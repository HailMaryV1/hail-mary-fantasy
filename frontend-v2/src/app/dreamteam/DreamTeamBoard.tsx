"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import Link from "next/link";
import PitchView, { type PitchPlayer } from "@/components/PitchView";
import StatusPill from "@/components/StatusPill";
import RotationRiskBadge from "@/components/RotationRiskBadge";
import type { RotationRiskInfo } from "@/lib/rotationRisk";
import PlayerActionMenu, { type PlayerAction } from "@/components/PlayerActionMenu";
import PlayerInfoPanel from "@/components/PlayerInfoPanel";
import GameweekSwitcher from "@/components/GameweekSwitcher";
import SaveTeamButton from "@/components/SaveTeamButton";
import TrendChart from "@/components/TrendChart";
import ProjectionFreshness from "@/components/ProjectionFreshness";
import type { TrendPoint } from "@/lib/projectionTrend";
import { searchPool } from "@/lib/poolSearch";
import { isLegalFormationPick, countByPosition, ELEVEN_A_SIDE_FORMATIONS, type SquadPosition } from "@/lib/squadFormation";
import { setBooster, setCaptain, saveTeamForGameweek } from "./actions";
import { applyRecommendation } from "./ask-mary/actions";

export const POOL_PAGE_SIZE = 15;

// source: which team_fixture_difficulty COALESCE branch (migration 0017/
// 0103) produced this fixture's difficulty - real bookmaker match odds
// once posted, Mary's own FDR ratings (set_manual_pl_fixture_strength.py)
// as the fallback before that. Surfaced as a small dot on the pill so a
// glance at the pool table shows which fixtures are still estimates -
// updates automatically on next page load the moment real odds land,
// no separate refresh mechanism needed.
// isCup: true for a Carabao/EFL Cup, FA Cup, or European tie - Dream Team
// folds these into whichever gameweek their kickoff falls in, so a team
// can have TWO fixtures in one gameweek slot. Used to keep the league
// fixture first/primary wherever only one pill fits, and to visually mark
// the second one when both are shown - see fixtures below.
export type FixtureTile = { opponentAbbr: string; isHome: boolean; difficulty: number; source: "real_odds" | "fdr"; isCup: boolean };

export type BoardPlayer = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_name: string;
  price: number;
  score: number | null;
  isCaptain: boolean;
  isViceCaptain: boolean;
  // One entry per gameweek slot (6 ahead), each itself 0-2 tiles - a
  // double gameweek (league + cup) shows both, league always first.
  fixtures: FixtureTile[][];
  rotationRisk?: RotationRiskInfo | null;
  // Real per-gameweek projections from the same decomposed-scoring engine
  // that produces `score` - drives the pool's "Sort by" dropdown.
  goalProjected: number;
  assistProjected: number;
  bonusProjected: number;
  // Real team news from fantasyfootballscout.co.uk (2026-08-19 user
  // request - see migration 0122/0123, playerStatus.ts).
  ffscoutStatus?: string | null;
  ffscoutStartProbability?: number | null;
  // Real injury type/description + expected return date (2026-08-20 user
  // request, see migration 0127).
  ffscoutDetail?: string | null;
  ffscoutExpectedReturnDate?: string | null;
};

export type PoolPlayer = Omit<BoardPlayer, "isCaptain" | "isViceCaptain">;

type Booster = "goal_bonus" | "twelfth_man" | "max_captain";
type DisplayMode = "next1" | "next2" | "next3" | "pts" | "pred";
type SortBy = "pts" | "goals" | "assists" | "bonus" | "price";

// % Owned isn't offered here - Dream Team's real feed has no such field
// (confirmed live 2026-08-10), and this app never shows a made-up number
// in place of one. Price is real (a genuine budget game), so that one is.
const SORT_OPTIONS: [SortBy, string][] = [
  ["pts", "Pts"],
  ["goals", "Goals"],
  ["assists", "Assists"],
  ["bonus", "Bonus"],
  ["price", "Price"],
];
const VALUE_BANDS = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8.5];

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

const BOOSTER_LABELS: Record<Booster, string> = {
  goal_bonus: "Goal Bonus",
  twelfth_man: "12th Man",
  max_captain: "Max Captain",
};
const BOOSTER_SHORT: Record<Booster, string> = { goal_bonus: "GB", twelfth_man: "12M", max_captain: "MC" };

// attack_score is 0-1, higher = a better attacking fixture (easier) for
// that team - real data already computed for the Fixtures page, reused
// here as a simple 5-tier difficulty color.
function difficultyColor(d: number): string {
  if (d >= 0.6) return "bg-emerald-600";
  if (d >= 0.45) return "bg-emerald-800";
  if (d >= 0.35) return "bg-navy-700";
  if (d >= 0.25) return "bg-amber-800";
  return "bg-red-800";
}

function fixtureTilesFor(tiles: FixtureTile[][], count: number): { label: string; colorClass: string }[] {
  return tiles.slice(0, count).flatMap((slot) =>
    slot.map((t) => ({
      label: t.isHome ? t.opponentAbbr : t.opponentAbbr.toLowerCase(),
      // A subtle ring, not a whole new color scale, distinguishes the cup
      // fixture from the league one when both render side by side.
      colorClass: t.isCup ? `${difficultyColor(t.difficulty)} ring-1 ring-amber-400/70` : difficultyColor(t.difficulty),
    }))
  );
}

// Best-effort client-side mirror of makeTransfer's real squad-shape
// change (./actions), used only to paint an instant local guess via
// useOptimistic while the real server action is in flight - see
// FanTeamBoard.tsx's identical pattern/rationale.
function optimisticTransfer(current: BoardPlayer[], outGamePlayerId: number, incomingPoolPlayer: PoolPlayer): BoardPlayer[] {
  const stillHere = current.some((p) => p.game_player_id === outGamePlayerId);
  if (!stillHere) return current;
  const incoming: BoardPlayer = { ...incomingPoolPlayer, isCaptain: false, isViceCaptain: false };
  return current.filter((p) => p.game_player_id !== outGamePlayerId).concat(incoming);
}

function optimisticCaptain(current: BoardPlayer[], captainId: number, viceCaptainId: number): BoardPlayer[] {
  return current.map((p) => ({ ...p, isCaptain: p.game_player_id === captainId, isViceCaptain: p.game_player_id === viceCaptainId }));
}

export default function DreamTeamBoard({
  squadId,
  squadName,
  transfers,
  bank,
  teamValue,
  isTeamSaved,
  squadTrend,
  planningGameweek,
  viewedGameweek,
  isPlanningView,
  isPastView,
  pastViewState,
  minGameweek,
  maxGameweek,
  boosters,
  substitutesUsed,
  seasonStarted,
  squad,
  pool: initialPool,
  poolTotalCount: initialPoolTotalCount,
  teams: teamsProp,
  fixtureTiles,
  isPoolServerDriven,
  squadSummary,
  projectionsUpdatedAt,
}: {
  squadId: number;
  squadName: string;
  transfers: number;
  bank: number;
  teamValue: number;
  isTeamSaved: boolean;
  squadTrend: TrendPoint[];
  planningGameweek: number;
  viewedGameweek: number;
  isPlanningView: boolean;
  isPastView: boolean;
  pastViewState: "not_locked" | "no_results_yet" | null;
  minGameweek: number;
  maxGameweek: number;
  boosters: {
    active: Booster | null;
    activeGameweek: number | null;
    goalBonusUsed: boolean;
    twelfthManUsed: boolean;
    maxCaptainUsed: boolean;
  };
  substitutesUsed: number;
  seasonStarted: boolean;
  squad: BoardPlayer[];
  pool: PoolPlayer[];
  poolTotalCount: number;
  teams: string[];
  // Every team's next-6-gameweek fixture difficulty, keyed "teamId:gameweek" -
  // small (a few hundred entries) and game-wide, so it's cheap to fetch in
  // full regardless of which page of the pool is on screen. A pool row
  // fetched from search_game_player_pool only carries a team_id, not
  // fixtures - this lookup is how the board turns that id back into the
  // same 6-tile strip every other view of a player already shows.
  fixtureTiles: Record<string, FixtureTile[]>;
  // False for a past-gameweek view, whose pool page.tsx already fetched in
  // full - that rare, small-scale path keeps the old client-side filter/
  // sort/paginate behavior rather than hitting search_game_player_pool,
  // since it's scored from real actuals, not projections.
  isPoolServerDriven: boolean;
  squadSummary: string[];
  // Real user request 2026-08-21 - see lib/projectionFreshness.ts.
  projectionsUpdatedAt: string | null;
}) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>("pts");
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Multiple squad members can be marked for sale at once - each becomes
  // an empty placeholder on the pitch and its price genuinely joins a
  // shared pot (see poolBudget below), so a player unaffordable on any
  // single sale (e.g. Haaland) can become affordable once two or three
  // sales are combined, picked in whatever order the user wants. Picks
  // are staged client-side in pendingSwaps and only sent to the server
  // as one cash-freeing-first-ordered bundle (applyRecommendation) once
  // every sold slot has a replacement and the user hits Confirm - see
  // the user's explicit instruction that drove this: "its my planner
  // and i can do it the way i want."
  const [pendingOutIds, setPendingOutIds] = useState<Set<number>>(new Set());
  const [pendingSwaps, setPendingSwaps] = useState<Map<number, PoolPlayer>>(new Map());
  const [isBoosterPending, startBoosterTransition] = useTransition();
  const [isTransferPending, startTransferTransition] = useTransition();
  const [isCaptainPending, startCaptainTransition] = useTransition();
  const [boosterError, setBoosterError] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [captainError, setCaptainError] = useState<string | null>(null);
  // Action-menu state (Make Captain / Make Vice-Captain / Transfer Out /
  // Player Info) - opens on a plain click of any squad or pool player, same
  // reconciliation pattern as FanTeamBoard.tsx: a click only opens the menu
  // when nothing is already selected for transfer; once selected, clicking
  // continues the existing select-then-click-to-transfer flow untouched.
  const [menuPlayerId, setMenuPlayerId] = useState<number | null>(null);
  const [menuIsSquadMember, setMenuIsSquadMember] = useState(false);
  // Player Info replaces the pool browser panel in place, rather than
  // navigating away - matches the real Dream Team Tonic app's pattern the
  // user asked to match.
  const [infoPlayerId, setInfoPlayerId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [posFilter, setPosFilter] = useState<"ALL" | "GK" | "DEF" | "MID" | "FWD">("ALL");
  const [maxValue, setMaxValue] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("pts");
  const [teamFilter, setTeamFilter] = useState<string>("ALL");

  // Instant local guess for a transfer (squad) or a booster pick - see
  // FanTeamBoard.tsx's identical pattern. React drops back to the real
  // prop once each transition settles.
  const [optimisticSquad, applyOptimisticSquad] = useOptimistic(squad, (_current: BoardPlayer[], next: BoardPlayer[]) => next);
  const [optimisticBoosters, applyOptimisticBoosters] = useOptimistic(boosters, (_current, next: typeof boosters) => next);

  // Debounced search - typing shouldn't fire a fresh server request on
  // every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // 15 rows/page rather than rendering the whole (position/team/value/
  // search-filtered) pool at once - fewer DOM nodes to paint per
  // keystroke/filter change. Resets to page 1 whenever the filter shape
  // changes, so a stale page number never lands on an empty page.
  const [poolPage, setPoolPage] = useState(1);
  useEffect(() => {
    setPoolPage(1);
  }, [posFilter, teamFilter, maxValue, sortBy, debouncedSearch]);

  // Server-driven pool state - only the page actually on screen, fetched
  // fresh from search_game_player_pool whenever a filter/search/sort/page
  // changes (see migration 0099/0100 + poolSearch.ts) instead of filtering
  // a whole-pool array client-side. Starts from whatever page.tsx already
  // loaded for the very first render, so mount doesn't cost a redundant
  // duplicate request.
  const [pool, setPool] = useState<PoolPlayer[]>(initialPool);
  const [poolTotalCount, setPoolTotalCount] = useState(initialPoolTotalCount);
  const [isPoolLoading, startPoolTransition] = useTransition();
  const isFirstRender = useRef(true);
  const [refreshKey, setRefreshKey] = useState(0);

  function buildFixtures(teamId: number): FixtureTile[][] {
    return Array.from({ length: 6 }, (_, i) => fixtureTiles[`${teamId}:${viewedGameweek + i}`] ?? []);
  }

  function refetchPool() {
    if (!isPoolServerDriven) return;
    startPoolTransition(async () => {
      const result = await searchPool({
        gameSlug: "dreamteam",
        gameweek: viewedGameweek,
        position: posFilter === "ALL" ? null : posFilter,
        teamName: teamFilter === "ALL" ? null : teamFilter,
        search: debouncedSearch,
        // optimisticSquad, not squad - the server-confirmed squad prop only
        // lands once Next's revalidation round trip completes, which isn't
        // guaranteed to happen before this refetch fires (triggered
        // synchronously by handleTransfer's own refreshKey bump). optimisticSquad
        // updates the instant a transfer is submitted, so it's always the
        // true current squad at refetch time - using the stale prop here
        // let a just-sold player keep excluding correctly-purchasable
        // replacements and let a just-bought player linger in the pool.
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
          price: r.price,
          score: r.hail_mary_score,
          fixtures: buildFixtures(r.team_id),
          goalProjected: r.goalProjected,
          assistProjected: r.assistProjected,
          bonusProjected: r.bonusProjected,
          ffscoutStatus: r.ffscoutStatus,
          ffscoutStartProbability: r.ffscoutStartProbability,
          ffscoutDetail: r.ffscoutDetail,
          ffscoutExpectedReturnDate: r.ffscoutExpectedReturnDate,
          rotationRisk: r.rotationRisk,
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

  const pitchPlayers: PitchPlayer[] = optimisticSquad.map((p) => {
    const swap = pendingSwaps.get(p.game_player_id);
    if (pendingOutIds.has(p.game_player_id) && !swap) {
      return {
        game_player_id: p.game_player_id,
        full_name: p.full_name,
        position: p.position,
        team_name: p.team_name,
        is_starting: true,
        price: p.price,
        score: p.score,
        isCaptain: p.isCaptain,
        isViceCaptain: p.isViceCaptain,
        isEmpty: true,
        emptyLabel: `Sold ${p.full_name}`,
      };
    }
    // Tentative incoming pick (not yet submitted) shows in place of the
    // sold player - same id (the ORIGINAL squad member's) so PitchView's
    // onSelect below can still tell which sale/pick this slot belongs to.
    // position must be the INCOMING pick's real position once staged, not
    // the sold player's - PitchView groups pitch rows strictly by position
    // (FWD/MID/DEF/GK), so a staged cross-position pick (e.g. selling a
    // MID, buying a FWD - the whole point of pickSlotFor/isLegalFormationPick
    // allowing it) needs to visually land in its own real row, or the
    // formation never appears to change even though the pick is legal -
    // real user report 2026-08-21: "i can[']t manually change formations
    // and you wont set the auto formation change."
    const display = swap ?? p;
    return {
      game_player_id: p.game_player_id,
      full_name: display.full_name,
      position: display.position,
      team_name: display.team_name,
      is_starting: true,
      price: display.price,
      score: display.score,
      isCaptain: p.isCaptain,
      isViceCaptain: p.isViceCaptain,
      rotationRisk: p.rotationRisk,
      ffscoutStatus: p.ffscoutStatus,
      ffscoutStartProbability: p.ffscoutStartProbability,
      ffscoutDetail: p.ffscoutDetail,
      ffscoutExpectedReturnDate: p.ffscoutExpectedReturnDate,
      statText: displayMode in fixtureModeCount ? undefined : statTextFor(display),
      statTiles: displayMode in fixtureModeCount ? fixtureTilesFor(display.fixtures, fixtureModeCount[displayMode]) : undefined,
      isEmpty: false,
    };
  });

  function handleBooster(booster: Booster | null) {
    setBoosterError(null);
    startBoosterTransition(async () => {
      applyOptimisticBoosters({ ...boosters, active: booster, activeGameweek: booster ? planningGameweek : null });
      const result = await setBooster({ squadId, booster, gameweek: planningGameweek });
      if (result?.error) setBoosterError(result.error);
    });
  }

  function submitCaptain(captainId: number, viceCaptainId: number) {
    setCaptainError(null);
    startCaptainTransition(async () => {
      applyOptimisticSquad(optimisticCaptain(optimisticSquad, captainId, viceCaptainId));
      const result = await setCaptain({ squadId, captainGamePlayerId: captainId, viceCaptainGamePlayerId: viceCaptainId });
      if (result?.error) setCaptainError(result.error);
    });
  }

  // Reuses whichever squad member already holds the OTHER role if it's
  // still valid; otherwise falls back to the highest-scoring other squad
  // member as a sensible default the user can immediately override with
  // one more menu click (Make Captain/Make Vice-Captain are always
  // available from any player's menu, so nothing is ever a dead end).
  function handleMakeCaptain(playerId: number) {
    const currentViceCaptainId = optimisticSquad.find((p) => p.isViceCaptain)?.game_player_id ?? null;
    const viceCaptainId =
      currentViceCaptainId !== null && currentViceCaptainId !== playerId
        ? currentViceCaptainId
        : optimisticSquad.filter((p) => p.game_player_id !== playerId).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.game_player_id;
    if (viceCaptainId == null) return;
    submitCaptain(playerId, viceCaptainId);
  }
  function handleMakeViceCaptain(playerId: number) {
    const currentCaptainId = optimisticSquad.find((p) => p.isCaptain)?.game_player_id ?? null;
    const captainId =
      currentCaptainId !== null && currentCaptainId !== playerId
        ? currentCaptainId
        : optimisticSquad.filter((p) => p.game_player_id !== playerId).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.game_player_id;
    if (captainId == null) return;
    submitCaptain(captainId, playerId);
  }

  const menuPlayer = menuPlayerId != null ? (menuIsSquadMember ? optimisticSquad : pagedPool).find((p) => p.game_player_id === menuPlayerId) : undefined;
  const menuActions: PlayerAction[] = !menuPlayer
    ? []
    : menuIsSquadMember
      ? [
          {
            label: (menuPlayer as BoardPlayer).isCaptain ? "Captain ✓" : "Make Captain",
            onClick: () => handleMakeCaptain(menuPlayer.game_player_id),
            disabled: (menuPlayer as BoardPlayer).isCaptain || !isPlanningView,
          },
          {
            label: (menuPlayer as BoardPlayer).isViceCaptain ? "Vice-Captain ✓" : "Make Vice-Captain",
            onClick: () => handleMakeViceCaptain(menuPlayer.game_player_id),
            disabled: (menuPlayer as BoardPlayer).isViceCaptain || !isPlanningView,
          },
          {
            label: "Transfer Out",
            onClick: () => setPendingOutIds((prev) => new Set(prev).add(menuPlayer.game_player_id)),
            disabled: !isPlanningView || pendingOutIds.has(menuPlayer.game_player_id) || (seasonStarted && pendingOutIds.size >= transfers),
          },
          { label: "Player Info", onClick: () => setInfoPlayerId(menuPlayer.game_player_id) },
        ]
      : [{ label: "Player Info", onClick: () => setInfoPlayerId(menuPlayer.game_player_id) }];

  const pendingOutPlayers = optimisticSquad.filter((p) => pendingOutIds.has(p.game_player_id));
  const canTransfer = isPlanningView && (!seasonStarted || transfers > 0);

  // Budget is constant - back-derived once from the server-confirmed
  // bank+teamValue props so a transfer's optimistic squad can recompute
  // an honest bank/team-value instantly (see FanTeamBoard.tsx's identical
  // pattern).
  const budget = bank + teamValue;
  const optimisticTeamValue = optimisticSquad.reduce((sum, p) => sum + p.price, 0);
  const optimisticBank = budget - optimisticTeamValue;
  // Every pending sale's price is one shared pot: real bank, plus every
  // sold player's price, minus whatever's already tentatively spent on
  // picks staged so far. Nothing is sent to the server until Confirm -
  // see handleConfirmTransfers below - so there's no makeTransfer-per-
  // click ordering constraint to work around here at all.
  const poolBudget =
    optimisticBank +
    pendingOutPlayers.reduce((sum, p) => sum + p.price, 0) -
    Array.from(pendingSwaps.values()).reduce((sum, p) => sum + p.price, 0);
  // What the Bank stat box shows: the real remaining spendable pot, which
  // should visibly count down as picks land - poolBudget itself, not the
  // flat total pot (a static number here reads as "the bank isn't
  // updating" even though nothing about the pooling is wrong).
  const displayBank = poolBudget;
  // No bench - every squad member always starts and always counts, so
  // this is a flat sum (same "no formation search needed" reasoning as
  // askMaryEngine.ts's optimalXITotal).
  const optimisticTotalPoints = optimisticSquad.reduce((sum, p) => sum + (p.score ?? 0), 0);

  // Which sold slot clicking `p` would fill - any currently-open slot,
  // not just one matching p's own position (2026-08-20 user report: "if
  // I take out a 4m player and a 5m player it won't let me bring in a
  // 6m player" - selling a MID and a FWD blocked buying a DEF outright,
  // even though the shared pot could afford it and the resulting XI
  // would still be a real formation). isLegalFormationPick checks that
  // committing to p's position still leaves at least one of Dream Team's
  // 7 real formations reachable once the OTHER still-open slots (whatever
  // positions they end up being) are filled too - see squadFormation.ts.
  // Deliberately NOT falling back to silently replacing an already-
  // assigned slot's pick here - that produced exactly the "it just keeps
  // swapping" confusion once every slot already had a pick, with no
  // visible reason why. Changing a pick is the pitch-tap-to-unassign flow
  // below, not a second pool click.
  const keptCounts = countByPosition(optimisticSquad.filter((p) => !pendingOutIds.has(p.game_player_id)));
  const stagedCounts = countByPosition(Array.from(pendingSwaps.values()));
  const openSlots = pendingOutPlayers.filter((o) => !pendingSwaps.has(o.game_player_id));
  function pickSlotFor(p: PoolPlayer): BoardPlayer | null {
    // Already staged into another slot - must be unassigned (tap its
    // pitch slot) before it can be picked again, so one player can never
    // land in two slots at once.
    if (Array.from(pendingSwaps.values()).some((v) => v.game_player_id === p.game_player_id)) return null;
    if (openSlots.length === 0 || poolBudget < p.price) return null;
    if (!isLegalFormationPick(keptCounts, stagedCounts, p.position, openSlots.length, ELEVEN_A_SIDE_FORMATIONS)) return null;
    // Prefer a same-position slot when one's open, so a plain like-for-
    // like swap never spends a different slot than the obvious one.
    return openSlots.find((o) => o.position === p.position) ?? openSlots[0];
  }
  const legalPoolIds = new Set(canTransfer ? pagedPool.filter((p) => pickSlotFor(p) !== null).map((p) => p.game_player_id) : []);

  // Stages a tentative pick only - no server call. The pitch/pool re-
  // render instantly off this local state; nothing is real until Confirm.
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
      return {
        outGamePlayerId,
        inGamePlayerId: inPlayer.game_player_id,
        outPrice: outPlayer.price,
        inPrice: inPlayer.price,
        inPosition: inPlayer.position as SquadPosition,
      };
    });
    if (legs.length === 0) return;
    setTransferError(null);
    startTransferTransition(async () => {
      const newSquad = legs.reduce(
        (sq, leg) => optimisticTransfer(sq, leg.outGamePlayerId, pendingSwaps.get(leg.outGamePlayerId)!),
        optimisticSquad
      );
      applyOptimisticSquad(newSquad);
      const result = await applyRecommendation({ squadId, legs });
      // Real user report 2026-08-21: on failure, the pitch kept showing the
      // attempted (never-persisted) pick, and Save Team could be pressed
      // against that phantom state. Clearing pending state + bumping
      // refreshKey here too (not just on success) forces a real resync
      // instead of leaving the failed optimistic guess on screen
      // indefinitely.
      setPendingOutIds(new Set());
      setPendingSwaps(new Map());
      setRefreshKey((k) => k + 1);
      if (result?.error) setTransferError(result.error);
    });
  }

  const sortColumnLabel = SORT_OPTIONS.find(([v]) => v === sortBy)?.[1] ?? "Pts";

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
          <StatBox label="Projected Points" value={optimisticTotalPoints.toFixed(1)} />
          <StatBox label="Transfers" value={seasonStarted ? String(transfers) : "Unlimited"} />
          <StatBox label="Bank" value={`£${displayBank.toFixed(1)}m`} />
          <StatBox label="Team Value" value={`£${optimisticTeamValue.toFixed(1)}m`} />
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Boosters/Subs</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {(["goal_bonus", "twelfth_man", "max_captain"] as const).map((b) => {
                const used = b === "goal_bonus" ? boosters.goalBonusUsed : b === "twelfth_man" ? boosters.twelfthManUsed : boosters.maxCaptainUsed;
                const active = optimisticBoosters.active === b && optimisticBoosters.activeGameweek === planningGameweek;
                return (
                  <button
                    key={b}
                    disabled={used || isBoosterPending || !isPlanningView}
                    onClick={() => handleBooster(active ? null : b)}
                    title={used ? `${BOOSTER_LABELS[b]} - already used this season` : BOOSTER_LABELS[b]}
                    className={`rounded px-2 py-1 text-[10px] font-bold ${
                      used
                        ? "cursor-not-allowed bg-navy-800 text-navy-600 line-through"
                        : active
                          ? "bg-amber-500 text-navy-950"
                          : "bg-navy-800 text-navy-200 hover:bg-navy-700"
                    }`}
                  >
                    {BOOSTER_SHORT[b]}
                  </button>
                );
              })}
              <span className="rounded bg-navy-800 px-2 py-1 text-[10px] font-bold text-navy-300">Subs {substitutesUsed}/10</span>
            </div>
          </div>
        </div>
        {boosterError && <p className="mt-2 text-xs text-red-400">{boosterError}</p>}

        {pendingOutPlayers.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-700 bg-sky-950/40 px-4 py-2.5">
            <p className="text-sm text-sky-200">
              {canTransfer ? (
                <>
                  Selling <span className="font-semibold text-white">{pendingOutPlayers.map((p) => p.full_name).join(", ")}</span>. Their combined
                  £{pendingOutPlayers.reduce((sum, p) => sum + p.price, 0).toFixed(1)}m is one shared pot - pick replacements for each slot in any
                  order, any combination. Tap a filled slot on the pitch to change that pick, an empty one to cancel that sale, then Confirm once
                  every slot has a pick.
                </>
              ) : (
                <>No transfers left this gameweek - Dream Team has a hard cap, no points-hit option.</>
              )}
            </p>
            <div className="flex items-center gap-3">
              {canTransfer && (
                <button
                  onClick={handleConfirmTransfers}
                  disabled={pendingSwaps.size !== pendingOutPlayers.length || isTransferPending}
                  className="rounded-full bg-sky-500 px-3 py-1.5 text-xs font-semibold text-navy-950 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isTransferPending ? "Confirming…" : `Confirm ${pendingOutPlayers.length} transfer${pendingOutPlayers.length === 1 ? "" : "s"}`}
                </button>
              )}
              <button
                onClick={() => {
                  setPendingOutIds(new Set());
                  setPendingSwaps(new Map());
                }}
                className="text-xs font-medium text-sky-400 hover:text-sky-300"
              >
                Cancel all
              </button>
            </div>
          </div>
        )}
        {transferError && <p className="mt-2 text-xs text-red-400">{transferError}</p>}

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div>
            <div className="mb-3 flex flex-col gap-2 sm:grid sm:grid-cols-3 sm:items-center">
              <h2 className="text-sm font-semibold text-white">{squadName}</h2>
              <div className="flex justify-center">
                <GameweekSwitcher
                  basePath="/dreamteam"
                  currentGameweek={viewedGameweek}
                  minGameweek={minGameweek}
                  maxGameweek={maxGameweek}
                  planningGameweek={planningGameweek}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {isPlanningView && <SaveTeamButton isSaved={isTeamSaved} onSave={() => saveTeamForGameweek({ squadId })} />}
                <Link
                  href="/dreamteam/ask-mary"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Ask Mary
                </Link>
                <Link
                  href="/dreamteam/market-odds"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Market Odds
                </Link>
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
              starting={pitchPlayers}
              selectedId={null}
              swappableIds={null}
              onSelect={(p) => {
                if (isTransferPending || isCaptainPending) return;
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
                setMenuPlayerId(p.game_player_id);
                setMenuIsSquadMember(true);
              }}
            />
            {squadSummary.length > 0 && (
              <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Mary&apos;s Squad Summary</h2>
                <p className="mt-2 text-sm leading-relaxed text-navy-200">{squadSummary.join(" ")}</p>
              </div>
            )}
            {squadTrend.length > 0 && squadTrend.some((p) => p.score > 0) && (
              <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Squad Points Trend</h2>
                <p className="mt-1 text-xs text-navy-500">If you kept this exact squad - next {squadTrend.length} gameweeks.</p>
                <div className="mt-2">
                  <TrendChart points={squadTrend.map((p) => ({ label: `GW${p.gameweek}`, value: p.score }))} accent="#34d399" />
                </div>
              </div>
            )}
          </div>

          {infoPlayerId != null ? (
            <PlayerInfoPanel gameSlug="dreamteam" gamePlayerId={infoPlayerId} onBack={() => setInfoPlayerId(null)} viewedGameweek={viewedGameweek} />
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
                    const rowClickable = pendingOutPlayers.length > 0 && canTransfer && isLegal && !isTransferPending;
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
                          pendingOutPlayers.length > 0 ? (isLegal ? "cursor-pointer bg-emerald-950/20 hover:bg-emerald-900/30" : "opacity-30") : "cursor-pointer hover:bg-navy-800/60"
                        }`}
                      >
                        <td className="py-1.5 pr-2">
                          <div className="flex items-center font-medium text-white">
                            {p.full_name}
                            <StatusPill
                              ffscoutStatus={p.ffscoutStatus}
                              ffscoutStartProbability={p.ffscoutStartProbability}
                              ffscoutDetail={p.ffscoutDetail}
                              ffscoutExpectedReturnDate={p.ffscoutExpectedReturnDate}
                            />
                            <RotationRiskBadge risk={p.rotationRisk} />
                          </div>
                          <div className="text-[10px] text-navy-500">
                            {p.team_name} · {p.position} · £{p.price.toFixed(1)}m
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-sky-400">
                          {sortBy === "pts" ? (p.score != null ? p.score.toFixed(1) : "-") : sortValue(p, sortBy).toFixed(2)}
                        </td>
                        {p.fixtures.slice(0, 6).map((slot, i) => (
                          <td key={i} className="px-1 py-1.5 text-center">
                            {slot.length > 0 ? (
                              <span className="flex flex-col items-center gap-0.5">
                                {slot.map((f, j) => (
                                  <span
                                    key={j}
                                    className={`relative inline-block rounded px-1 py-0.5 text-[9px] font-bold text-white ${difficultyColor(f.difficulty)} ${
                                      f.isCup ? "ring-1 ring-amber-400/70" : ""
                                    }`}
                                    title={
                                      (f.isCup ? "Cup fixture (not this gameweek's primary) - " : "") +
                                      (f.source === "real_odds" ? "Live bookmaker odds" : "Estimated - Mary's FDR ratings (no live odds posted yet)")
                                    }
                                  >
                                    {f.isHome ? f.opponentAbbr : f.opponentAbbr.toLowerCase()}
                                    {f.source === "real_odds" && (
                                      <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-sky-400 ring-1 ring-navy-950" />
                                    )}
                                  </span>
                                ))}
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
                    {(clampedPoolPage - 1) * POOL_PAGE_SIZE + 1}-{Math.min(clampedPoolPage * POOL_PAGE_SIZE, activeTotalCount)} of {activeTotalCount}
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
              <ProjectionFreshness updatedAt={projectionsUpdatedAt} />
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
      {captainError && <p className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-950 px-3 py-2 text-xs text-red-300 shadow-lg">{captainError}</p>}
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
