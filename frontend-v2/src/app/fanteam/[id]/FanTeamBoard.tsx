"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import Link from "next/link";
import PitchView, { type PitchPlayer } from "@/components/PitchView";
import type { RotationRiskInfo } from "@/lib/rotationRisk";
import PlayerActionMenu, { type PlayerAction } from "@/components/PlayerActionMenu";
import PlayerInfoPanel from "@/components/PlayerInfoPanel";
import GameweekSwitcher from "@/components/GameweekSwitcher";
import SaveTeamButton from "@/components/SaveTeamButton";
import { searchPool } from "@/lib/poolSearch";
import { reorderFanteamBench, setFanteamFormation, setFanteamCaptain, swapFanteamLineup, saveTeamForGameweek } from "../actions";
import { applyRecommendation } from "./ask-mary/actions";

export const POOL_PAGE_SIZE = 15;

// source: which team_fixture_difficulty COALESCE branch (migration 0017/
// 0103) produced this fixture's difficulty - real bookmaker match odds
// once posted, Mary's own FDR ratings as the fallback before that.
export type FixtureTile = { opponentAbbr: string; isHome: boolean; difficulty: number; source: "real_odds" | "fdr" };

export type BoardPlayer = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_name: string;
  team_id: number;
  price: number;
  score: number | null;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isStarting: boolean;
  // Real bench priority (1/2/3 for the 3 outfield reserves, null for
  // starters and the single reserve GK - a 15-man squad only ever has
  // one bench GK, so there's nothing to order there).
  benchOrder: number | null;
  fixtures: (FixtureTile | null)[];
  rotationRisk?: RotationRiskInfo | null;
  goalProjected: number;
  assistProjected: number;
  bonusProjected: number;
};

export type PoolPlayer = Omit<BoardPlayer, "isCaptain" | "isViceCaptain" | "isStarting" | "benchOrder">;

export type Formation = { code: string; gk_count: number; def_count: number; mid_count: number; fwd_count: number };

type DisplayMode = "next1" | "next2" | "next3" | "pts" | "pred";
type SortBy = "pts" | "goals" | "assists" | "bonus" | "price";

// % Owned isn't offered here - FanTeam's real feed has no such field
// (confirmed - see swingOpportunity.ts), and this app never shows a
// made-up number in place of one.
const SORT_OPTIONS: [SortBy, string][] = [
  ["pts", "Pts"],
  ["goals", "Goals"],
  ["assists", "Assists"],
  ["bonus", "Bonus"],
  ["price", "Price"],
];
const VALUE_BANDS = [4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 9, 10, 12, 14];

function sortValue(p: PoolPlayer, sortBy: SortBy): number {
  switch (sortBy) {
    case "goals":
      return p.goalProjected;
    case "assists":
      return p.assistProjected;
    case "bonus":
      return p.bonusProjected;
    case "price":
      return p.price;
    case "pts":
    default:
      return p.score ?? -Infinity;
  }
}

// attack_score is 0-1, higher = a better attacking fixture (easier) for
// that team - same tiering used on the Dream Team board.
function difficultyColor(d: number): string {
  if (d >= 0.6) return "bg-emerald-600";
  if (d >= 0.45) return "bg-emerald-800";
  if (d >= 0.35) return "bg-navy-700";
  if (d >= 0.25) return "bg-amber-800";
  return "bg-red-800";
}

function fixtureTilesFor(tiles: (FixtureTile | null)[], count: number): { label: string; colorClass: string }[] {
  return tiles
    .slice(0, count)
    .filter((t): t is FixtureTile => t !== null)
    .map((t) => ({
      label: t.isHome ? t.opponentAbbr : t.opponentAbbr.toLowerCase(),
      colorClass: difficultyColor(t.difficulty),
    }));
}

// FanTeam's real wildcard windows (WC1: gameweeks 2-19, WC2: 20-38) -
// mirrors the same real constants enforced server-side in
// makeFanteamTransfer, duplicated here only for the client-side
// availability preview (fixed real-world gameweek ranges, not
// application logic that can drift).
function wildcardWindowFor(gameweek: number): "wc1" | "wc2" | null {
  if (gameweek >= 2 && gameweek <= 19) return "wc1";
  if (gameweek >= 20 && gameweek <= 38) return "wc2";
  return null;
}

// Best-effort client-side mirrors of the server's real mutation logic
// (setFanteamFormation/setFanteamCaptain/reorderFanteamBench/
// swapFanteamLineup/makeFanteamTransfer in ../actions), used ONLY to
// paint an instant local guess via useOptimistic while the real
// server action is in flight - the server stays the single source of
// truth and always wins on the next revalidate, so a guess that's
// slightly off (an unusual score tie-break, a race with another
// change) self-corrects within one round trip rather than staying
// wrong.
function optimisticFormation(current: BoardPlayer[], formation: Formation): BoardPlayer[] {
  const quota: Record<"GK" | "DEF" | "MID" | "FWD", number> = {
    GK: formation.gk_count,
    DEF: formation.def_count,
    MID: formation.mid_count,
    FWD: formation.fwd_count,
  };
  const byPosition: Record<"GK" | "DEF" | "MID" | "FWD", BoardPlayer[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of current) byPosition[p.position].push(p);
  const next: BoardPlayer[] = [];
  for (const pos of ["GK", "DEF", "MID", "FWD"] as const) {
    byPosition[pos]
      .slice()
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .forEach((p, i) => next.push({ ...p, isStarting: i < quota[pos], benchOrder: null }));
  }
  const outfieldBenchOrder = new Map(
    next
      .filter((p) => !p.isStarting && p.position !== "GK")
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((p, i) => [p.game_player_id, i + 1])
  );
  return next.map((p) => (outfieldBenchOrder.has(p.game_player_id) ? { ...p, benchOrder: outfieldBenchOrder.get(p.game_player_id)! } : p));
}

function optimisticCaptain(current: BoardPlayer[], captainId: number, viceCaptainId: number): BoardPlayer[] {
  return current.map((p) => ({ ...p, isCaptain: p.game_player_id === captainId, isViceCaptain: p.game_player_id === viceCaptainId }));
}

function optimisticBenchReorder(current: BoardPlayer[], gamePlayerId: number, targetOrder: number): BoardPlayer[] {
  const outfield = current.filter((p) => !p.isStarting && p.position !== "GK");
  const orders = outfield.map((p) => p.benchOrder);
  const needsNormalizing = orders.some((o) => o == null) || new Set(orders).size !== orders.length;
  const orderByPlayerId = needsNormalizing
    ? new Map(
        outfield
          .slice()
          .sort((a, b) => (a.benchOrder ?? 99) - (b.benchOrder ?? 99) || a.game_player_id - b.game_player_id)
          .map((p, i) => [p.game_player_id, i + 1])
      )
    : new Map(outfield.map((p) => [p.game_player_id, p.benchOrder!]));
  const movingFrom = orderByPlayerId.get(gamePlayerId);
  if (movingFrom == null) return current;
  const occupantId = [...orderByPlayerId.entries()].find(([id, order]) => order === targetOrder && id !== gamePlayerId)?.[0];
  orderByPlayerId.set(gamePlayerId, targetOrder);
  if (occupantId != null) orderByPlayerId.set(occupantId, movingFrom);
  return current.map((p) => (orderByPlayerId.has(p.game_player_id) ? { ...p, benchOrder: orderByPlayerId.get(p.game_player_id)! } : p));
}

function optimisticSwap(current: BoardPlayer[], playerAId: number, playerBId: number): BoardPlayer[] {
  const a = current.find((p) => p.game_player_id === playerAId);
  const b = current.find((p) => p.game_player_id === playerBId);
  if (!a || !b) return current;
  return current.map((p) => {
    if (p.game_player_id === playerAId) return { ...p, isStarting: b.isStarting, benchOrder: b.benchOrder };
    if (p.game_player_id === playerBId) return { ...p, isStarting: a.isStarting, benchOrder: a.benchOrder };
    return p;
  });
}

function optimisticTransfer(current: BoardPlayer[], outGamePlayerId: number, incomingPoolPlayer: PoolPlayer): BoardPlayer[] {
  const outgoing = current.find((p) => p.game_player_id === outGamePlayerId);
  if (!outgoing) return current;
  const incoming: BoardPlayer = {
    ...incomingPoolPlayer,
    isCaptain: false,
    isViceCaptain: false,
    isStarting: outgoing.isStarting,
    benchOrder: outgoing.isStarting ? null : outgoing.benchOrder,
  };
  return current.filter((p) => p.game_player_id !== outGamePlayerId).concat(incoming);
}

export default function FanTeamBoard({
  squadId,
  squadName,
  transfers,
  bank,
  teamValue,
  isTeamSaved,
  planningGameweek,
  viewedGameweek,
  isPlanningView,
  isPastView,
  pastViewState,
  minGameweek,
  maxGameweek,
  wildcard1UsedGameweek,
  wildcard2UsedGameweek,
  maxPerClub,
  seasonStarted,
  formations,
  currentFormationCode,
  isProviderSynced,
  rawCaptainId,
  rawViceCaptainId,
  squad,
  pool: initialPool,
  poolTotalCount: initialPoolTotalCount,
  teams: teamsProp,
  fixtureTiles,
  isPoolServerDriven,
  squadSummary,
}: {
  squadId: number;
  squadName: string;
  transfers: number;
  bank: number;
  teamValue: number;
  isTeamSaved: boolean;
  planningGameweek: number;
  viewedGameweek: number;
  isPlanningView: boolean;
  isPastView: boolean;
  pastViewState: "not_locked" | "no_results_yet" | null;
  minGameweek: number;
  maxGameweek: number;
  wildcard1UsedGameweek: number | null;
  wildcard2UsedGameweek: number | null;
  maxPerClub: number;
  seasonStarted: boolean;
  formations: Formation[];
  // Null when the current starting XI's GK/DEF/MID/FWD counts don't match
  // any of the 7 real formations - can genuinely happen (a squad synced
  // mid-transfer, or one that's never had a formation applied here yet).
  currentFormationCode: string | null;
  // Captain/vice-captain are read-only (via PitchView's existing C/VC
  // pills) whenever true - a provider-synced squad has them overwritten
  // by the next scheduled FanTeam sync regardless of what's picked here.
  isProviderSynced: boolean;
  // The squad row's raw captain/vice-captain fields - distinct from
  // squad[].isCaptain/isViceCaptain, which only reflect a pick that's
  // still a current squad member. A provider-synced pick can point at a
  // player no longer in this squad's 15 (roster drift between our mirror
  // and the real site); the raw fields are what setFanteamCaptain's
  // server-side guard actually checks, so the "can I edit this?" decision
  // here has to match that, not the roster-filtered view.
  rawCaptainId: number | null;
  rawViceCaptainId: number | null;
  squad: BoardPlayer[];
  pool: PoolPlayer[];
  poolTotalCount: number;
  teams: string[];
  // Every team's next-6-gameweek fixture difficulty, keyed "teamId:gameweek" -
  // see DreamTeamBoard.tsx's identical prop for why this is passed as a
  // plain object rather than recomputed per pool row.
  fixtureTiles: Record<string, FixtureTile>;
  // False for a past-gameweek view - see DreamTeamBoard.tsx's identical
  // reasoning (that path keeps the old client-side filter/paginate
  // behavior over an already-fetched full pool).
  isPoolServerDriven: boolean;
  squadSummary: string[];
}) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>("pts");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Multiple squad members can be marked for real Transfer Out at once,
  // independent of the swap/bench selectedId above - each becomes an
  // empty placeholder on the pitch, so a player unaffordable on any
  // single sale can become affordable once a cheaper swap elsewhere has
  // actually landed and grown the real bank - see DreamTeamBoard.tsx's
  // identical pattern/rationale: picks are staged client-side in
  // pendingSwaps and pool a shared budget (poolBudget below) across every
  // pending sale, only submitted as one cash-freeing-first-ordered bundle
  // (applyRecommendation) on Confirm.
  const [pendingOutIds, setPendingOutIds] = useState<Set<number>>(new Set());
  const [pendingSwaps, setPendingSwaps] = useState<Map<number, PoolPlayer>>(new Map());
  const [useWildcard, setUseWildcard] = useState(false);
  const [isTransferPending, startTransferTransition] = useTransition();
  const [transferError, setTransferError] = useState<string | null>(null);
  const [isFormationPending, startFormationTransition] = useTransition();
  const [formationError, setFormationError] = useState<string | null>(null);
  const [isBenchPending, startBenchTransition] = useTransition();
  const [benchError, setBenchError] = useState<string | null>(null);
  const [isCaptainPending, startCaptainTransition] = useTransition();
  const [captainError, setCaptainError] = useState<string | null>(null);
  const [isSwapPending, startSwapTransition] = useTransition();
  const [swapError, setSwapError] = useState<string | null>(null);
  // Action-menu state (Make Captain / Make Vice-Captain / Swap/Transfer
  // Out / Player Info) - opens on a plain click of any squad or pool
  // player, same reconciliation pattern as DreamTeamBoard.tsx: a click
  // only opens the menu when nothing is already selected for a swap/
  // transfer; once selected, clicking continues the existing select-
  // then-click-to-complete flow untouched.
  const [menuPlayerId, setMenuPlayerId] = useState<number | null>(null);
  const [menuIsSquadMember, setMenuIsSquadMember] = useState(false);
  // Player Info replaces the pool browser panel in place, rather than
  // navigating away - matches the real Dream Team Tonic app's pattern.
  const [infoPlayerId, setInfoPlayerId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [posFilter, setPosFilter] = useState<"ALL" | "GK" | "DEF" | "MID" | "FWD">("ALL");
  const [teamFilter, setTeamFilter] = useState<string>("ALL");
  const [maxValue, setMaxValue] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("pts");

  // Instant local guess for every squad-shape change (formation, captain,
  // bench order, swap, transfer) - painted synchronously inside each
  // action's transition, before the server round trip resolves. React
  // automatically drops back to the real `squad` prop once the
  // transition settles (the revalidated server data becomes the new
  // prop), so this never needs manual reset/rollback wiring.
  const [optimisticSquad, applyOptimisticSquad] = useOptimistic(squad, (_current: BoardPlayer[], next: BoardPlayer[]) => next);

  // Budget is constant (doesn't change with a transfer) - back-derived
  // once from the server-confirmed bank+teamValue props so a transfer's
  // optimistic squad can recompute an honest bank/team-value instantly
  // instead of showing stale figures until the server round trip lands.
  // Declared early (not just before the JSX return) since the transfer-
  // legality logic below also needs it.
  const budget = bank + teamValue;
  const optimisticTeamValue = optimisticSquad.reduce((sum, p) => sum + p.price, 0);
  const optimisticBank = budget - optimisticTeamValue;

  // Debounced search - typing shouldn't fire a fresh server request on
  // every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // 15 rows/page rather than rendering the whole (position/team/value/
  // search-filtered) pool at once. Resets to page 1 whenever the filter
  // shape changes, so a stale page number never lands on an empty page.
  const [poolPage, setPoolPage] = useState(1);
  useEffect(() => {
    setPoolPage(1);
  }, [posFilter, teamFilter, maxValue, sortBy, debouncedSearch]);

  // Server-driven pool state - see DreamTeamBoard.tsx's identical pattern.
  const [pool, setPool] = useState<PoolPlayer[]>(initialPool);
  const [poolTotalCount, setPoolTotalCount] = useState(initialPoolTotalCount);
  const [isPoolLoading, startPoolTransition] = useTransition();
  const isFirstRender = useRef(true);
  const [refreshKey, setRefreshKey] = useState(0);

  function buildFixtures(teamId: number): (FixtureTile | null)[] {
    return Array.from({ length: 6 }, (_, i) => fixtureTiles[`${teamId}:${viewedGameweek + i}`] ?? null);
  }

  function refetchPool() {
    if (!isPoolServerDriven) return;
    startPoolTransition(async () => {
      const result = await searchPool({
        gameSlug: "fanteam",
        gameweek: viewedGameweek,
        position: posFilter === "ALL" ? null : posFilter,
        teamName: teamFilter === "ALL" ? null : teamFilter,
        search: debouncedSearch,
        // optimisticSquad, not squad - see DreamTeamBoard.tsx's identical
        // fix for why the server prop can't be trusted to be fresh at the
        // moment this refetch fires.
        excludeIds: optimisticSquad.map((p) => p.game_player_id),
        maxPrice: maxValue,
        sortBy,
        page: poolPage,
        pageSize: POOL_PAGE_SIZE,
      });
      setPool(
        result.rows.map((r) => ({
          game_player_id: r.game_player_id,
          full_name: r.full_name,
          position: r.position as PoolPlayer["position"],
          team_name: r.team_name,
          team_id: r.team_id,
          price: r.price,
          score: r.hail_mary_score,
          fixtures: buildFixtures(r.team_id),
          goalProjected: r.goalProjected,
          assistProjected: r.assistProjected,
          bonusProjected: r.bonusProjected,
        }))
      );
      setPoolTotalCount(result.totalCount);
    });
  }

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    refetchPool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posFilter, teamFilter, maxValue, sortBy, debouncedSearch, poolPage, viewedGameweek, refreshKey]);

  const teams = isPoolServerDriven ? teamsProp : Array.from(new Set(initialPool.map((p) => p.team_name))).sort();

  // Not server-driven (past view) - old full-array filter/sort, unchanged.
  const filteredPool = isPoolServerDriven
    ? pool
    : initialPool
        .filter(
          (p) =>
            (posFilter === "ALL" || p.position === posFilter) &&
            (teamFilter === "ALL" || p.team_name === teamFilter) &&
            (debouncedSearch === "" || p.full_name.toLowerCase().includes(debouncedSearch.toLowerCase())) &&
            (maxValue === null || p.price <= maxValue)
        )
        .sort((a, b) => sortValue(b, sortBy) - sortValue(a, sortBy));

  const activeTotalCount = isPoolServerDriven ? poolTotalCount : filteredPool.length;
  const totalPoolPages = Math.max(1, Math.ceil(activeTotalCount / POOL_PAGE_SIZE));
  const clampedPoolPage = Math.min(poolPage, totalPoolPages);
  const pagedPool = isPoolServerDriven ? filteredPool : filteredPool.slice((poolPage - 1) * POOL_PAGE_SIZE, poolPage * POOL_PAGE_SIZE);

  const wildcardWindow = wildcardWindowFor(planningGameweek);
  const wildcardActiveThisGameweek = wildcard1UsedGameweek === planningGameweek || wildcard2UsedGameweek === planningGameweek;
  const wc1Available = wildcardWindow === "wc1" && wildcard1UsedGameweek === null;
  const wc2Available = wildcardWindow === "wc2" && wildcard2UsedGameweek === null;
  const wildcardOfferable = seasonStarted && !wildcardActiveThisGameweek && (wc1Available || wc2Available);

  function statTextFor(p: { score: number | null }): string {
    switch (displayMode) {
      case "pred":
        return p.score != null ? `${p.score >= 0 ? "+" : ""}${p.score.toFixed(1)}` : "-";
      case "pts":
      default:
        return p.score != null ? `${p.score.toFixed(1)} pts` : "-";
    }
  }

  const fixtureModeCount: Record<string, number> = { next1: 1, next2: 2, next3: 3 };

  function toPitchPlayer(p: BoardPlayer): PitchPlayer {
    const swap = pendingSwaps.get(p.game_player_id);
    if (pendingOutIds.has(p.game_player_id) && !swap) {
      return {
        game_player_id: p.game_player_id,
        full_name: p.full_name,
        position: p.position,
        team_name: p.team_name,
        is_starting: p.isStarting,
        price: p.price,
        score: p.score,
        isCaptain: p.isCaptain,
        isViceCaptain: p.isViceCaptain,
        benchOrder: p.benchOrder,
        isEmpty: true,
        emptyLabel: `Sold ${p.full_name}`,
      };
    }
    // Tentative incoming pick (not yet submitted) shows in place of the
    // sold player - same id (the ORIGINAL squad member's) so onSelect
    // below can still tell which sale/pick this slot belongs to.
    const display = swap ?? p;
    return {
      game_player_id: p.game_player_id,
      full_name: display.full_name,
      position: p.position,
      team_name: display.team_name,
      is_starting: p.isStarting,
      price: display.price,
      score: display.score,
      isCaptain: p.isCaptain,
      isViceCaptain: p.isViceCaptain,
      benchOrder: p.benchOrder,
      rotationRisk: p.rotationRisk,
      statText: displayMode in fixtureModeCount ? undefined : statTextFor(display),
      statTiles: displayMode in fixtureModeCount ? fixtureTilesFor(display.fixtures, fixtureModeCount[displayMode]) : undefined,
      isEmpty: false,
    };
  }

  const starters = optimisticSquad.filter((p) => p.isStarting).map(toPitchPlayer);
  // Reserve GK first (never has a benchOrder - a 15-man squad only ever
  // has one), then the 3 outfield reserves in their real priority order.
  // benchOrder can be missing/duplicated on real data (see
  // reorderFanteamBench's docstring) - falls back to game_player_id here
  // so the display default matches exactly what the server would
  // normalize it to on first use, and the two never disagree.
  const benchGK = optimisticSquad.filter((p) => !p.isStarting && p.position === "GK").map(toPitchPlayer);
  const benchOutfieldRaw = optimisticSquad.filter((p) => !p.isStarting && p.position !== "GK");
  // Matches reorderFanteamBench's own "any null or duplicate triggers a
  // full renumber" rule exactly - filling only the gaps would risk
  // colliding with a real value still held by someone else (e.g. two
  // players missing an order both defaulting to the same slot a third
  // player already legitimately occupies).
  const outfieldOrders = benchOutfieldRaw.map((p) => p.benchOrder);
  const outfieldNeedsNormalizing = outfieldOrders.some((o) => o == null) || new Set(outfieldOrders).size !== outfieldOrders.length;
  const benchOutfield = benchOutfieldRaw
    .slice()
    .sort((a, b) => (a.benchOrder ?? 99) - (b.benchOrder ?? 99) || a.game_player_id - b.game_player_id)
    .map((p, i) => toPitchPlayer({ ...p, benchOrder: outfieldNeedsNormalizing ? i + 1 : p.benchOrder }));
  const bench = [...benchGK, ...benchOutfield];

  function handleReorderBench(gamePlayerId: number, targetOrder: number) {
    setBenchError(null);
    startBenchTransition(async () => {
      applyOptimisticSquad(optimisticBenchReorder(optimisticSquad, gamePlayerId, targetOrder));
      const result = await reorderFanteamBench({ squadId, gamePlayerId, targetOrder });
      if (result?.error) setBenchError(result.error);
    });
  }

  function handleFormationChange(formationCode: string) {
    setFormationError(null);
    const formation = formations.find((f) => f.code === formationCode);
    startFormationTransition(async () => {
      if (formation) applyOptimisticSquad(optimisticFormation(optimisticSquad, formation));
      const result = await setFanteamFormation({ squadId, formationCode });
      if (result?.error) setFormationError(result.error);
    });
  }

  // Server-confirmed (or, mid-transition, optimistically-guessed) captain/VC.
  const serverCaptainId = optimisticSquad.find((p) => p.isCaptain)?.game_player_id ?? null;
  const serverViceCaptainId = optimisticSquad.find((p) => p.isViceCaptain)?.game_player_id ?? null;
  // Locally staged - captain and vice-captain are picked in two separate
  // dropdown changes, but the server requires both non-null and
  // different in one call. Without local staging, picking captain then
  // vice-captain (starting from neither set) would never actually submit:
  // each dropdown's onChange only knows the OTHER field's last
  // server-confirmed value, which is still null until a save succeeds.
  const [pendingCaptainId, setPendingCaptainId] = useState<number | null>(serverCaptainId);
  const [pendingViceCaptainId, setPendingViceCaptainId] = useState<number | null>(serverViceCaptainId);
  useEffect(() => {
    setPendingCaptainId(serverCaptainId);
    setPendingViceCaptainId(serverViceCaptainId);
  }, [serverCaptainId, serverViceCaptainId]);

  const starterOptions = optimisticSquad.filter((p) => p.isStarting);

  function handleSetCaptain(newCaptainId: number | null, newViceCaptainId: number | null) {
    if (newCaptainId === null || newViceCaptainId === null || newCaptainId === newViceCaptainId) return;
    setCaptainError(null);
    startCaptainTransition(async () => {
      applyOptimisticSquad(optimisticCaptain(optimisticSquad, newCaptainId, newViceCaptainId));
      const result = await setFanteamCaptain({ squadId, captainGamePlayerId: newCaptainId, viceCaptainGamePlayerId: newViceCaptainId });
      if (result?.error) setCaptainError(result.error);
    });
  }

  function handleCaptainDropdownChange(newCaptainId: number) {
    setPendingCaptainId(newCaptainId);
    handleSetCaptain(newCaptainId, pendingViceCaptainId);
  }
  function handleViceCaptainDropdownChange(newViceCaptainId: number) {
    setPendingViceCaptainId(newViceCaptainId);
    handleSetCaptain(pendingCaptainId, newViceCaptainId);
  }

  // The menu (unlike the two always-visible dropdowns above) can be the
  // very first captain/VC action taken on a squad, where the OTHER role
  // isn't set yet - handleCaptainDropdownChange/handleViceCaptainDropdownChange
  // would silently no-op in that case (handleSetCaptain requires both
  // non-null). Falls back to the highest-scoring other starter so the
  // click always does something, same pattern as Dream Team's menu.
  function handleMenuMakeCaptain(playerId: number) {
    const viceCaptainId =
      pendingViceCaptainId !== null && pendingViceCaptainId !== playerId
        ? pendingViceCaptainId
        : starterOptions.filter((p) => p.game_player_id !== playerId).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.game_player_id;
    if (viceCaptainId == null) return;
    setPendingCaptainId(playerId);
    setPendingViceCaptainId(viceCaptainId);
    handleSetCaptain(playerId, viceCaptainId);
  }
  function handleMenuMakeViceCaptain(playerId: number) {
    const captainId =
      pendingCaptainId !== null && pendingCaptainId !== playerId
        ? pendingCaptainId
        : starterOptions.filter((p) => p.game_player_id !== playerId).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.game_player_id;
    if (captainId == null) return;
    setPendingViceCaptainId(playerId);
    setPendingCaptainId(captainId);
    handleSetCaptain(captainId, playerId);
  }

  const menuPlayer = menuPlayerId != null ? (menuIsSquadMember ? optimisticSquad : pagedPool).find((p) => p.game_player_id === menuPlayerId) : undefined;
  const menuActions: PlayerAction[] = !menuPlayer
    ? []
    : menuIsSquadMember
      ? [
          {
            label: (menuPlayer as BoardPlayer).isCaptain ? "Captain ✓" : "Make Captain",
            onClick: () => handleMenuMakeCaptain(menuPlayer.game_player_id),
            disabled: !isPlanningView || (menuPlayer as BoardPlayer).isCaptain || !(menuPlayer as BoardPlayer).isStarting,
          },
          {
            label: (menuPlayer as BoardPlayer).isViceCaptain ? "Vice-Captain ✓" : "Make Vice-Captain",
            onClick: () => handleMenuMakeViceCaptain(menuPlayer.game_player_id),
            disabled: !isPlanningView || (menuPlayer as BoardPlayer).isViceCaptain || !(menuPlayer as BoardPlayer).isStarting,
          },
          {
            label: (menuPlayer as BoardPlayer).isStarting ? "Swap / Bench" : "Swap In",
            onClick: () => setSelectedId(menuPlayer.game_player_id),
            disabled: !isPlanningView,
          },
          {
            label: "Transfer Out",
            onClick: () => setPendingOutIds((prev) => new Set(prev).add(menuPlayer.game_player_id)),
            disabled: !isPlanningView || pendingOutIds.has(menuPlayer.game_player_id),
          },
          { label: "Player Info", onClick: () => setInfoPlayerId(menuPlayer.game_player_id) },
        ]
      : [{ label: "Player Info", onClick: () => setInfoPlayerId(menuPlayer.game_player_id) }];

  // FanTeam has no hard transfer cap like Dream Team - a transfer is
  // always allowed, just at a real cost (see costPreview below).
  const selectedPlayer = selectedId != null ? optimisticSquad.find((p) => p.game_player_id === selectedId) : undefined;

  // A real sub, not a transfer - opposite starting/bench status, and
  // either the same position (formation counts untouched) or a different
  // position whose resulting GK/DEF/MID/FWD counts still match one of
  // this game's real formations (e.g. swapping a MID for a DEF flips
  // 3-5-2 into 4-4-2). The server re-validates the same way.
  const startingCounts: Record<"GK" | "DEF" | "MID" | "FWD", number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of optimisticSquad) if (p.isStarting) startingCounts[p.position] += 1;

  function swapKeepsValidFormation(outgoingPos: "GK" | "DEF" | "MID" | "FWD", incomingPos: "GK" | "DEF" | "MID" | "FWD"): boolean {
    if (outgoingPos === incomingPos) return true;
    const counts = { ...startingCounts, [outgoingPos]: startingCounts[outgoingPos] - 1, [incomingPos]: startingCounts[incomingPos] + 1 };
    return formations.some((f) => f.gk_count === counts.GK && f.def_count === counts.DEF && f.mid_count === counts.MID && f.fwd_count === counts.FWD);
  }

  const legalSwapIds = new Set(
    selectedPlayer
      ? optimisticSquad
          .filter((p) => p.isStarting !== selectedPlayer.isStarting)
          .filter((p) => {
            const outgoingPos = selectedPlayer.isStarting ? selectedPlayer.position : p.position;
            const incomingPos = selectedPlayer.isStarting ? p.position : selectedPlayer.position;
            return swapKeepsValidFormation(outgoingPos, incomingPos);
          })
          .map((p) => p.game_player_id)
      : []
  );

  function handleSwapLineup(playerAId: number, playerBId: number) {
    setSwapError(null);
    startSwapTransition(async () => {
      applyOptimisticSquad(optimisticSwap(optimisticSquad, playerAId, playerBId));
      const result = await swapFanteamLineup({ squadId, playerAId, playerBId });
      if (result?.error) setSwapError(result.error);
      else setSelectedId(null);
    });
  }

  // Multiple squad members can be marked for real Transfer Out at once -
  // independent of the swap-only selectedId/legalSwapIds above. Each
  // becomes an empty pitch placeholder; picks are staged locally
  // (pendingSwaps) rather than submitted per click, and their combined
  // price is one shared pot (poolBudget below) - see DreamTeamBoard.tsx's
  // identical pooled-budget design. Nothing is sent to the server until
  // Confirm, which submits the whole set as one bundle.
  const pendingOutPlayers = optimisticSquad.filter((p) => pendingOutIds.has(p.game_player_id));

  // Real max-3-per-club count for the squad as it would look once every
  // CURRENTLY-STAGED pick lands: a sold slot with no pick yet is simply
  // absent (still undecided), a sold slot with a tentative pick counts
  // that pick's club instead of the sold player's - unlike a single
  // in-flight swap, several picks can be staged at once here, so the
  // real limit has to be checked against the whole hypothetical bundle,
  // not just one swap in isolation. `excludeSlotId` additionally drops
  // one slot's own current pick so a candidate can be checked against
  // "every OTHER slot's pick" before deciding whether it fits there too.
  function finalClubCounts(excludeSlotId?: number): Map<number, number> {
    const counts = new Map<number, number>();
    for (const p of optimisticSquad) {
      if (pendingOutIds.has(p.game_player_id)) {
        if (p.game_player_id === excludeSlotId) continue;
        const swap = pendingSwaps.get(p.game_player_id);
        if (!swap) continue;
        counts.set(swap.team_id, (counts.get(swap.team_id) ?? 0) + 1);
        continue;
      }
      counts.set(p.team_id, (counts.get(p.team_id) ?? 0) + 1);
    }
    return counts;
  }

  // Real bank plus every sold player's price, minus whatever's already
  // tentatively spent on picks staged so far - the shared pot every
  // tentative pick draws from.
  const poolBudget =
    optimisticBank +
    pendingOutPlayers.reduce((sum, p) => sum + p.price, 0) -
    Array.from(pendingSwaps.values()).reduce((sum, p) => sum + p.price, 0);

  // Which sold slot clicking `p` would fill: only a genuinely unassigned
  // same-position slot. Deliberately NOT falling back to silently
  // replacing an already-assigned slot's pick here - that produced
  // exactly the "it just keeps swapping" confusion once every matching
  // slot already had a pick, with no visible reason why. Changing a pick
  // is the pitch-tap-to-unassign flow, not a second pool click.
  function pickSlotFor(p: PoolPlayer): BoardPlayer | null {
    if (Array.from(pendingSwaps.values()).some((v) => v.game_player_id === p.game_player_id)) return null;
    const unassigned = pendingOutPlayers.find((o) => o.position === p.position && !pendingSwaps.has(o.game_player_id));
    if (!unassigned) return null;
    const counts = finalClubCounts(unassigned.game_player_id);
    const clubOk = (counts.get(p.team_id) ?? 0) + 1 <= maxPerClub;
    return poolBudget >= p.price && clubOk ? unassigned : null;
  }
  const legalPoolIds = new Set(pagedPool.filter((p) => pickSlotFor(p) !== null).map((p) => p.game_player_id));

  const costPreview = !seasonStarted
    ? "Free (pre-season)"
    : wildcardActiveThisGameweek || useWildcard
      ? "Free (wildcard)"
      : transfers > 0
        ? `Free (${transfers} transfer${transfers === 1 ? "" : "s"} left)`
        : "-4 pts (no free transfers left)";
  // Total cost across the whole staged bundle, in the same order the
  // server will actually process it (cash-freeing-first == same order
  // applyRecommendation sorts by, but free-transfer consumption doesn't
  // depend on that order - only on how many legs there are).
  const bundleCostPreview = (() => {
    const n = pendingSwaps.size;
    if (n === 0) return null;
    if (!seasonStarted) return "Free (pre-season)";
    if (wildcardActiveThisGameweek || useWildcard) return "Free (wildcard)";
    const freeLegs = Math.min(n, transfers);
    const costLegs = n - freeLegs;
    if (costLegs === 0) return `Free (${freeLegs} transfer${freeLegs === 1 ? "" : "s"})`;
    return `${freeLegs} free, ${costLegs} × -4 pts`;
  })();

  // Stages a tentative pick only - no server call. The pitch/pool
  // re-render instantly off this local state; nothing is real until
  // Confirm.
  function handlePoolClick(inPlayer: PoolPlayer) {
    const slot = pickSlotFor(inPlayer);
    if (!slot) return;
    setPendingSwaps((prev) => {
      const next = new Map(prev);
      next.set(slot.game_player_id, inPlayer);
      return next;
    });
  }

  function handleConfirmTransfers() {
    const legs = Array.from(pendingSwaps.entries()).map(([outGamePlayerId, inPlayer]) => {
      const outPlayer = pendingOutPlayers.find((o) => o.game_player_id === outGamePlayerId)!;
      return { outGamePlayerId, inGamePlayerId: inPlayer.game_player_id, outPrice: outPlayer.price, inPrice: inPlayer.price };
    });
    if (legs.length === 0) return;
    setTransferError(null);
    startTransferTransition(async () => {
      const newSquad = legs.reduce(
        (sq, leg) => optimisticTransfer(sq, leg.outGamePlayerId, pendingSwaps.get(leg.outGamePlayerId)!),
        optimisticSquad
      );
      applyOptimisticSquad(newSquad);
      const result = await applyRecommendation({ squadId, legs, useWildcard });
      if (result?.error) setTransferError(result.error);
      else {
        setPendingOutIds(new Set());
        setPendingSwaps(new Map());
        setUseWildcard(false);
        setRefreshKey((k) => k + 1);
      }
    });
  }

  const sortColumnLabel = SORT_OPTIONS.find(([v]) => v === sortBy)?.[1] ?? "Pts";

  // Captains score double - a simple sum, not the more elaborate
  // auto-sub-probability-weighted total used elsewhere.
  const projectedPoints = optimisticSquad.filter((p) => p.isStarting).reduce((sum, p) => sum + (p.score ?? 0) * (p.isCaptain ? 2 : 1), 0);
  // The real remaining spendable pot - poolBudget itself, not the flat
  // total pot, so the Bank stat box visibly counts down as picks land.
  const displayBank = poolBudget;

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-7xl">
        {!isPlanningView && (
          <p className="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            {isPastView
              ? pastViewState === "not_locked"
                ? `GW${viewedGameweek} was never locked in - no squad to show. Switch back to GW${planningGameweek} to keep planning.`
                : pastViewState === "no_results_yet"
                  ? `Showing your GW${viewedGameweek} locked squad - results haven't been captured yet.`
                  : `Showing your GW${viewedGameweek} locked squad and actual points.`
              : `Previewing GW${viewedGameweek} projections - read-only. Switch back to GW${planningGameweek} to make changes.`}
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatBox label="Transfers" value={seasonStarted ? String(transfers) : "Unlimited"} />
          <StatBox label="Bank" value={`£${displayBank.toFixed(1)}m`} />
          <StatBox label="Team Value" value={`£${optimisticTeamValue.toFixed(1)}m`} />
          <StatBox label="Projected Points" value={projectedPoints.toFixed(1)} />
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Wildcard</p>
            <p className="mt-0.5 text-sm font-semibold text-white">
              {wildcardActiveThisGameweek
                ? "Active this GW"
                : wildcard1UsedGameweek != null && wildcard2UsedGameweek != null
                  ? "Both used"
                  : wc1Available || wc2Available
                    ? "Available"
                    : "Not in window"}
            </p>
          </div>
        </div>

        {(!isProviderSynced || (rawCaptainId === null && rawViceCaptainId === null)) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-navy-700 bg-navy-900 p-3">
            <span className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Captain</span>
            <select
              value={pendingCaptainId ?? ""}
              disabled={isCaptainPending || !isPlanningView}
              onChange={(e) => handleCaptainDropdownChange(Number(e.target.value))}
              className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
            >
              {pendingCaptainId === null && <option value="">Pick a captain</option>}
              {starterOptions
                .filter((p) => p.game_player_id !== pendingViceCaptainId)
                .map((p) => (
                  <option key={p.game_player_id} value={p.game_player_id}>
                    {p.full_name}
                  </option>
                ))}
            </select>
            <span className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Vice-Captain</span>
            <select
              value={pendingViceCaptainId ?? ""}
              disabled={isCaptainPending || !isPlanningView}
              onChange={(e) => handleViceCaptainDropdownChange(Number(e.target.value))}
              className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
            >
              {pendingViceCaptainId === null && <option value="">Pick a vice-captain</option>}
              {starterOptions
                .filter((p) => p.game_player_id !== pendingCaptainId)
                .map((p) => (
                  <option key={p.game_player_id} value={p.game_player_id}>
                    {p.full_name}
                  </option>
                ))}
            </select>
            {captainError && <p className="text-xs text-red-400">{captainError}</p>}
            {!captainError && (pendingCaptainId === null || pendingViceCaptainId === null) && (
              <p className="text-xs text-navy-500">
                Pick both to save.
                {isProviderSynced && " This squad is synced from FanTeam - your pick may be replaced by the real site's captain at the next sync."}
              </p>
            )}
          </div>
        )}

        {selectedPlayer && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-700 bg-sky-950/40 px-4 py-2.5">
            <p className="text-sm text-sky-200">
              <span className="font-semibold text-white">{selectedPlayer.full_name}</span> selected - click a highlighted{" "}
              {selectedPlayer.isStarting ? "bench" : "starting"} player on the pitch to sub.
            </p>
            <button onClick={() => setSelectedId(null)} className="text-xs font-medium text-sky-400 hover:text-sky-300">
              Cancel
            </button>
          </div>
        )}

        {pendingOutPlayers.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-700 bg-sky-950/40 px-4 py-2.5">
            <p className="text-sm text-sky-200">
              Selling <span className="font-semibold text-white">{pendingOutPlayers.map((p) => p.full_name).join(", ")}</span>. Their combined
              £{pendingOutPlayers.reduce((sum, p) => sum + p.price, 0).toFixed(1)}m is one shared pot - pick replacements for each slot in any
              order, any combination. Tap a filled slot on the pitch to change that pick, an empty one to cancel that sale, then Confirm once
              every slot has a pick.{" "}
              {bundleCostPreview ? (
                <>
                  Cost: <span className="font-semibold text-white">{bundleCostPreview}</span>
                </>
              ) : (
                <>
                  Next pick: <span className="font-semibold text-white">{costPreview}</span>
                </>
              )}
            </p>
            <div className="flex items-center gap-3">
              {wildcardOfferable && (
                <label className="flex items-center gap-1.5 text-xs text-sky-200">
                  <input type="checkbox" checked={useWildcard} onChange={(e) => setUseWildcard(e.target.checked)} />
                  Use {wc1Available ? "Wildcard 1" : "Wildcard 2"}
                </label>
              )}
              <button
                onClick={handleConfirmTransfers}
                disabled={pendingSwaps.size !== pendingOutPlayers.length || isTransferPending}
                className="rounded-full bg-sky-500 px-3 py-1.5 text-xs font-semibold text-navy-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isTransferPending ? "Confirming…" : `Confirm ${pendingOutPlayers.length} transfer${pendingOutPlayers.length === 1 ? "" : "s"}`}
              </button>
              <button
                onClick={() => {
                  setPendingOutIds(new Set());
                  setPendingSwaps(new Map());
                  setUseWildcard(false);
                }}
                className="text-xs font-medium text-sky-400 hover:text-sky-300"
              >
                Cancel all
              </button>
            </div>
          </div>
        )}
        {transferError && <p className="mt-2 text-xs text-red-400">{transferError}</p>}
        {swapError && <p className="mt-2 text-xs text-red-400">{swapError}</p>}
        {benchError && <p className="mt-2 text-xs text-red-400">{benchError}</p>}
        {formationError && <p className="mt-2 text-xs text-red-400">{formationError}</p>}

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div>
            <div className="mb-3 flex flex-col gap-2 sm:grid sm:grid-cols-3 sm:items-center">
              <h2 className="text-sm font-semibold text-white">{squadName}</h2>
              <div className="flex justify-center">
                <GameweekSwitcher
                  basePath={`/fanteam/${squadId}`}
                  currentGameweek={viewedGameweek}
                  minGameweek={minGameweek}
                  maxGameweek={maxGameweek}
                  planningGameweek={planningGameweek}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {isPlanningView && <SaveTeamButton isSaved={isTeamSaved} onSave={() => saveTeamForGameweek({ squadId })} />}
                <Link
                  href={`/fanteam/${squadId}/ask-mary`}
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Ask Mary
                </Link>
                <select
                  value={currentFormationCode ?? ""}
                  disabled={isFormationPending || !isPlanningView}
                  onChange={(e) => handleFormationChange(e.target.value)}
                  aria-label="Formation - picking a new one auto-fills the best 11 for it from your squad"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                >
                  {currentFormationCode === null && <option value="">Formation: custom</option>}
                  {formations.map((f) => (
                    <option key={f.code} value={f.code}>
                      Formation: {f.code}
                    </option>
                  ))}
                </select>
                <div className="relative">
                <button
                  onClick={() => setOptionsOpen((o) => !o)}
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  ☰ Options
                </button>
                {optionsOpen && (
                  <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-xl border border-navy-700 bg-navy-900 p-2 shadow-xl">
                    <p className="px-2 py-1 text-[10px] font-semibold uppercase text-navy-500">Show on players</p>
                    {(
                      [
                        ["next1", "Next GW Fix"],
                        ["next2", "Next 2 GW Fix"],
                        ["next3", "Next 3 GW Fix"],
                        ["pts", "Pts"],
                        ["pred", `Pred +/- GW${viewedGameweek}`],
                      ] as [DisplayMode, string][]
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        onClick={() => {
                          setDisplayMode(mode);
                          setOptionsOpen(false);
                        }}
                        className={`block w-full rounded-lg px-2 py-1.5 text-left text-xs ${
                          displayMode === mode ? "bg-sky-500 font-medium text-navy-950" : "text-navy-200 hover:bg-navy-800"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                </div>
              </div>
            </div>
            <PitchView
              starting={starters}
              bench={bench}
              selectedId={selectedId}
              swappableIds={selectedPlayer ? legalSwapIds : null}
              onSelect={(p) => {
                if (isTransferPending || isSwapPending || isCaptainPending) return;
                if (pendingOutIds.has(p.game_player_id)) {
                  if (pendingSwaps.has(p.game_player_id)) {
                    // A tentative pick is already staged here - unassign
                    // just the pick, keep the sale itself pending so the
                    // user can choose a different replacement.
                    setPendingSwaps((prev) => {
                      const next = new Map(prev);
                      next.delete(p.game_player_id);
                      return next;
                    });
                    return;
                  }
                  setPendingOutIds((prev) => {
                    const next = new Set(prev);
                    next.delete(p.game_player_id);
                    return next;
                  });
                  return;
                }
                if (p.game_player_id === selectedId) {
                  setSelectedId(null);
                  return;
                }
                if (selectedPlayer && legalSwapIds.has(p.game_player_id)) {
                  handleSwapLineup(selectedPlayer.game_player_id, p.game_player_id);
                  return;
                }
                if (selectedPlayer) {
                  setSelectedId(p.game_player_id);
                  return;
                }
                setMenuPlayerId(p.game_player_id);
                setMenuIsSquadMember(true);
              }}
              onReorderBench={isBenchPending || !isPlanningView ? undefined : handleReorderBench}
            />
            {squadSummary.length > 0 && (
              <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Mary&apos;s Squad Summary</h2>
                <p className="mt-2 text-sm leading-relaxed text-navy-200">{squadSummary.join(" ")}</p>
              </div>
            )}
          </div>

          {infoPlayerId != null ? (
            <PlayerInfoPanel gameSlug="fanteam" gamePlayerId={infoPlayerId} onBack={() => setInfoPlayerId(null)} />
          ) : (
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white">Browse all available players</h2>
              {isPoolLoading && <span className="text-[10px] text-navy-500">Loading…</span>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["ALL", "GK", "DEF", "MID", "FWD"] as const).map((pos) => (
                <button
                  key={pos}
                  onClick={() => setPosFilter(pos)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    posFilter === pos ? "bg-sky-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:bg-navy-700"
                  }`}
                >
                  {pos}
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <select
                value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}
                className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              >
                <option value="ALL">All clubs</option>
                {teams.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                value={maxValue ?? ""}
                onChange={(e) => setMaxValue(e.target.value === "" ? null : Number(e.target.value))}
                className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              >
                <option value="">All values</option>
                {VALUE_BANDS.map((v) => (
                  <option key={v} value={v}>
                    £{v}m or less
                  </option>
                ))}
              </select>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              >
                {SORT_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    Sort: {label}
                  </option>
                ))}
              </select>
            </div>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search player..."
              className="mt-2 w-full rounded-lg border border-navy-700 bg-navy-950 px-3 py-2 text-sm text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
            />

            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-navy-500">
                    <th className="pb-2 pr-2 font-medium">Player</th>
                    <th className="pb-2 pr-2 font-medium">{sortColumnLabel}</th>
                    {Array.from({ length: 6 }, (_, i) => (
                      <th key={i} className="px-1 pb-2 text-center font-medium">
                        GW{viewedGameweek + i}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pagedPool.map((p) => {
                    const isLegal = legalPoolIds.has(p.game_player_id);
                    const rowClickable = pendingOutPlayers.length > 0 && isLegal && !isTransferPending;
                    return (
                      <tr
                        key={p.game_player_id}
                        onClick={() => {
                          if (rowClickable) {
                            handlePoolClick(p);
                            return;
                          }
                          if (pendingOutPlayers.length === 0) {
                            setMenuPlayerId(p.game_player_id);
                            setMenuIsSquadMember(false);
                          }
                        }}
                        className={`border-t border-navy-800 ${
                          pendingOutPlayers.length > 0
                            ? isLegal
                              ? "cursor-pointer bg-emerald-950/20 hover:bg-emerald-900/30"
                              : "opacity-30"
                            : "cursor-pointer hover:bg-navy-800/60"
                        }`}
                      >
                        <td className="py-1.5 pr-2">
                          <div className="font-medium text-white">{p.full_name}</div>
                          <div className="text-[10px] text-navy-500">
                            {p.team_name} · {p.position} · £{p.price.toFixed(1)}m
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-sky-400">
                          {sortBy === "pts" ? (p.score != null ? p.score.toFixed(1) : "-") : sortValue(p, sortBy).toFixed(2)}
                        </td>
                        {p.fixtures.slice(0, 6).map((f, i) => (
                          <td key={i} className="px-1 py-1.5 text-center">
                            {f ? (
                              <span
                                className={`relative inline-block rounded px-1 py-0.5 text-[9px] font-bold text-white ${difficultyColor(f.difficulty)}`}
                                title={f.source === "real_odds" ? "Live bookmaker odds" : "Estimated - Mary's FDR ratings (no live odds posted yet)"}
                              >
                                {f.isHome ? f.opponentAbbr : f.opponentAbbr.toLowerCase()}
                                {f.source === "real_odds" && (
                                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-sky-400 ring-1 ring-navy-950" />
                                )}
                              </span>
                            ) : (
                              <span className="text-navy-700">-</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {activeTotalCount > 0 && (
                <div className="mt-2 flex items-center justify-between text-[10px] text-navy-500">
                  <button
                    onClick={() => setPoolPage((p) => Math.max(1, p - 1))}
                    disabled={clampedPoolPage <= 1}
                    className="rounded px-2 py-1 font-medium text-navy-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-navy-300"
                  >
                    ← Prev
                  </button>
                  <span>
                    {(clampedPoolPage - 1) * POOL_PAGE_SIZE + 1}-{Math.min(clampedPoolPage * POOL_PAGE_SIZE, activeTotalCount)} of{" "}
                    {activeTotalCount}
                  </span>
                  <button
                    onClick={() => setPoolPage((p) => Math.min(totalPoolPages, p + 1))}
                    disabled={clampedPoolPage >= totalPoolPages}
                    className="rounded px-2 py-1 font-medium text-navy-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-navy-300"
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>
          </div>
          )}
        </div>
      </div>

      <PlayerActionMenu
        open={menuPlayerId != null}
        onClose={() => setMenuPlayerId(null)}
        title={menuPlayer?.full_name ?? ""}
        subtitle={menuPlayer ? `${menuPlayer.position} · ${menuPlayer.team_name} · £${menuPlayer.price.toFixed(1)}m` : undefined}
        actions={menuActions}
      />

      {/* The inline captainError message above only mounts when the
          dropdown block does (line ~577) - not true once a synced squad
          already has both roles set. The menu's Make Captain/Make
          Vice-Captain actions can fire (and fail, e.g. "squad is synced")
          from any state, so they need an always-mounted fallback. */}
      {captainError && (
        <p className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-950 px-3 py-2 text-xs text-red-300 shadow-lg">{captainError}</p>
      )}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}
