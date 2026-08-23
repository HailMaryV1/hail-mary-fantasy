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
import HailMaryRatingBadge from "@/components/HailMaryRatingBadge";
import ProjectionFreshness from "@/components/ProjectionFreshness";
import { searchPool } from "@/lib/poolSearch";
import { saveTeamForGameweek } from "./actions";
import { applyRecommendation } from "./ask-mary/actions";
import { isLegalFormationPick, countByPosition, ELEVEN_A_SIDE_FORMATIONS } from "@/lib/squadFormation";

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
  price: number;
  score: number | null;
  /** The 1-10 Hail Mary Rating (migration 0135) - threaded alongside score
   * from the same real source (player_projection_summary/game_player_pool's
   * hail_mary_rating column, or search_game_player_pool's hailMaryRating).
   * Data plumbing only for now - still unused for display/sort here, see
   * hailMaryRating.ts's own docstring for the follow-up that changes that. */
  rating: number | null;
  fixtures: (FixtureTile | null)[];
  rotationRisk?: RotationRiskInfo | null;
  // Real per-gameweek projections from the same decomposed-scoring engine
  // that produces `score` - drives the pool's "Sort by" dropdown.
  goalProjected: number;
  assistProjected: number;
  bonusProjected: number;
  // Live ownership % (2026-08-10 user request) - Cloud FF's own
  // getPlayerStats endpoint has a real, confirmed-live "Ownership" field
  // (e.g. Haaland at 92.8%), unlike Dream Team/FanTeam which have none.
  // Optional (not just nullable) same as rotationRisk above - only ever
  // populated for pool rows, never on squad members, so every squad-
  // player construction site doesn't need to thread through a value that
  // has no use there.
  ownershipPct?: number | null;
  // Real team news from fantasyfootballscout.co.uk (2026-08-19 user
  // request - see migration 0122/0123, playerStatus.ts's resolveStatusBadge)
  // - 'out'/'doubt'/'banned', with ffscoutStartProbability (0-100) only
  // meaningful when ffscoutStatus is 'doubt'.
  ffscoutStatus?: string | null;
  ffscoutStartProbability?: number | null;
  ffscoutDetail?: string | null;
  ffscoutExpectedReturnDate?: string | null;
};

export type PoolPlayer = BoardPlayer;

type DisplayMode = "next1" | "next2" | "next3" | "pts" | "pred";
type SortBy = "pts" | "goals" | "assists" | "bonus" | "price" | "owned";

const SORT_OPTIONS: [SortBy, string][] = [
  ["pts", "Rating"],
  ["goals", "Goals"],
  ["assists", "Assists"],
  ["bonus", "Bonus"],
  ["price", "Price"],
  ["owned", "% Owned"],
];
// Cloud FF runs on a higher price scale than Dream Team's original bands
// (real squad-23 prices already top out above £13m) - matches FanTeam's
// bands, which cover the same real range.
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
    case "owned":
      return p.ownershipPct ?? -Infinity;
    case "pts":
    default:
      return p.score ?? -Infinity;
  }
}

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

function fixtureTilesFor(tiles: (FixtureTile | null)[], count: number): { label: string; colorClass: string }[] {
  return tiles
    .slice(0, count)
    .filter((t): t is FixtureTile => t !== null)
    .map((t) => ({
      label: t.isHome ? t.opponentAbbr : t.opponentAbbr.toLowerCase(),
      colorClass: difficultyColor(t.difficulty),
    }));
}

// Best-effort client-side mirror of makeTransfer's real squad-shape
// change (./actions), used only to paint an instant local guess via
// useOptimistic while the real server action is in flight - see
// DreamTeamBoard.tsx's identical pattern/rationale.
function optimisticTransfer(current: BoardPlayer[], outGamePlayerId: number, incomingPoolPlayer: PoolPlayer): BoardPlayer[] {
  const stillHere = current.some((p) => p.game_player_id === outGamePlayerId);
  if (!stillHere) return current;
  return current.filter((p) => p.game_player_id !== outGamePlayerId).concat(incomingPoolPlayer);
}

export default function CloudFFBoard({
  squadId,
  squadName,
  bank,
  teamValue,
  isTeamSaved,
  uncoveredMatchDayCount,
  planningGameweek,
  viewedGameweek,
  isPlanningView,
  isPastView,
  pastViewState,
  minGameweek,
  maxGameweek,
  formationCode,
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
  bank: number;
  teamValue: number;
  isTeamSaved: boolean;
  // Real user request 2026-08-18: "I would want Mary to ensure i have a
  // captain for every single gameday." Every day with at least one
  // eligible player now auto-fills for real (see matchDayCaptains.ts's
  // ensureAutoPicks) - this count is only the genuine, un-fixable-by-
  // Mary remainder: an upcoming match-day where none of the squad's
  // players have a fixture at all, which needs a transfer, not a pick.
  uncoveredMatchDayCount: number;
  planningGameweek: number;
  viewedGameweek: number;
  isPlanningView: boolean;
  isPastView: boolean;
  pastViewState: "not_locked" | "no_results_yet" | null;
  minGameweek: number;
  maxGameweek: number;
  formationCode: string | null;
  squad: BoardPlayer[];
  pool: PoolPlayer[];
  poolTotalCount: number;
  teams: string[];
  // Every team's next-6-gameweek fixture difficulty, keyed "teamId:gameweek" -
  // see DreamTeamBoard.tsx's identical prop for why this is passed as a
  // plain object rather than recomputed per pool row.
  fixtureTiles: Record<string, FixtureTile>;
  // False for a past-gameweek view - see DreamTeamBoard.tsx's identical
  // reasoning.
  isPoolServerDriven: boolean;
  squadSummary: string[];
  // Real user request 2026-08-21 - see lib/projectionFreshness.ts.
  projectionsUpdatedAt: string | null;
}) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>("pts");
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Multiple squad members can be marked for sale at once, sharing one
  // budget pot and staged locally until Confirm - same batched pattern as
  // DreamTeamBoard.tsx (2026-08-20: switched from Cloud FF's old
  // immediate-per-click makeTransfer, which required each replacement to
  // match its own sale's price AND position individually, blocking a
  // pricier or cross-position pick the shared pot could genuinely afford).
  const [pendingOutIds, setPendingOutIds] = useState<Set<number>>(new Set());
  const [pendingSwaps, setPendingSwaps] = useState<Map<number, PoolPlayer>>(new Map());
  const [isTransferPending, startTransferTransition] = useTransition();
  const [transferError, setTransferError] = useState<string | null>(null);
  // Action-menu state (Transfer Out / Player Info) - opens on a plain
  // click of any squad or pool player, same
  // reconciliation pattern as DreamTeamBoard.tsx/FanTeamBoard.tsx: a click
  // only opens the menu when nothing is already selected for transfer;
  // once selected, clicking continues the existing select-then-click-to-
  // transfer flow untouched.
  const [menuPlayerId, setMenuPlayerId] = useState<number | null>(null);
  const [menuIsSquadMember, setMenuIsSquadMember] = useState(false);
  // Player Info replaces the pool browser panel in place, rather than
  // navigating away - matches the pattern already proven on Dream Team/
  // FanTeam.
  const [infoPlayerId, setInfoPlayerId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [posFilter, setPosFilter] = useState<"ALL" | "GK" | "DEF" | "MID" | "FWD">("ALL");
  const [maxValue, setMaxValue] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("pts");
  const [teamFilter, setTeamFilter] = useState<string>("ALL");

  // Instant local guess for a transfer - see DreamTeamBoard.tsx's
  // identical pattern. React drops back to the real prop once the
  // transition settles.
  const [optimisticSquad, applyOptimisticSquad] = useOptimistic(squad, (_current: BoardPlayer[], next: BoardPlayer[]) => next);

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
        gameSlug: "cloudff",
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
          price: r.price,
          score: r.hail_mary_score,
          rating: r.hailMaryRating,
          fixtures: buildFixtures(r.team_id),
          goalProjected: r.goalProjected,
          assistProjected: r.assistProjected,
          bonusProjected: r.bonusProjected,
          ownershipPct: r.ownershipPct,
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

  // "pred" used to prefix a "+" onto the same raw score "pts" showed -
  // never a real delta between two players - so both modes converge on
  // the same rating text now that raw points aren't user-facing.
  function statTextFor(p: { rating: number | null }): string {
    return p.rating != null ? `${p.rating}/10` : "-";
  }

  const fixtureModeCount: Record<string, number> = { next1: 1, next2: 2, next3: 3 };

  const pendingOutPlayers = optimisticSquad.filter((p) => pendingOutIds.has(p.game_player_id));

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
        rating: p.rating,
        isEmpty: true,
        emptyLabel: `Sold ${p.full_name}`,
      };
    }
    // Tentative incoming pick (not yet submitted) shows in place of the
    // sold player - same id (the ORIGINAL squad member's) so PitchView's
    // onSelect below can still tell which sale/pick this slot belongs to.
    // position deliberately comes from `display`, not `p` - a cross-
    // position pick renders in ITS OWN row (PitchView groups dynamically
    // by each player's own position), which is what lets the pitch show
    // the new formation shape without any layout changes.
    const display = swap ?? p;
    return {
      game_player_id: p.game_player_id,
      full_name: display.full_name,
      position: display.position,
      team_name: display.team_name,
      is_starting: true,
      price: display.price,
      score: display.score,
      rating: display.rating,
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

  const menuPlayer = menuPlayerId != null ? (menuIsSquadMember ? optimisticSquad : pagedPool).find((p) => p.game_player_id === menuPlayerId) : undefined;
  const menuActions: PlayerAction[] = !menuPlayer
    ? []
    : menuIsSquadMember
      ? [
          {
            label: "Transfer Out",
            onClick: () => setPendingOutIds((prev) => new Set(prev).add(menuPlayer.game_player_id)),
            disabled: !isPlanningView || pendingOutIds.has(menuPlayer.game_player_id),
          },
          { label: "Player Info", onClick: () => setInfoPlayerId(menuPlayer.game_player_id) },
        ]
      : [{ label: "Player Info", onClick: () => setInfoPlayerId(menuPlayer.game_player_id) }];

  // Budget is constant - back-derived once from the server-confirmed
  // bank+teamValue props so a transfer's optimistic squad can recompute
  // an honest bank/team-value instantly (see DreamTeamBoard.tsx's
  // identical pattern).
  const budget = bank + teamValue;
  const optimisticTeamValue = optimisticSquad.reduce((sum, p) => sum + p.price, 0);
  const optimisticBank = budget - optimisticTeamValue;
  // Every pending sale's price is one shared pot: real bank, plus every
  // sold player's price, minus whatever's already tentatively spent on
  // picks staged so far - see DreamTeamBoard.tsx's identical poolBudget.
  // Nothing is sent to the server until Confirm.
  const poolBudget =
    optimisticBank +
    pendingOutPlayers.reduce((sum, p) => sum + p.price, 0) -
    Array.from(pendingSwaps.values()).reduce((sum, p) => sum + p.price, 0);
  const displayBank = poolBudget;

  // Which sold slot clicking `p` would fill - any currently-open slot, not
  // just one matching p's own position, as long as committing to p's
  // position still leaves one of Cloud FF's 7 real formations reachable
  // once the other open slots are filled too - see squadFormation.ts and
  // DreamTeamBoard.tsx's identical pickSlotFor (2026-08-20 fix, ported here).
  const keptCounts = countByPosition(optimisticSquad.filter((p) => !pendingOutIds.has(p.game_player_id)));
  const stagedCounts = countByPosition(Array.from(pendingSwaps.values()));
  const openSlots = pendingOutPlayers.filter((o) => !pendingSwaps.has(o.game_player_id));
  function pickSlotFor(p: PoolPlayer): BoardPlayer | null {
    if (Array.from(pendingSwaps.values()).some((v) => v.game_player_id === p.game_player_id)) return null;
    if (openSlots.length === 0 || poolBudget < p.price) return null;
    if (!isLegalFormationPick(keptCounts, stagedCounts, p.position, openSlots.length, ELEVEN_A_SIDE_FORMATIONS)) return null;
    return openSlots.find((o) => o.position === p.position) ?? openSlots[0];
  }
  const legalPoolIds = new Set(pagedPool.filter((p) => pickSlotFor(p) !== null).map((p) => p.game_player_id));

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
      const result = await applyRecommendation({ squadId, legs });
      if (result?.error) setTransferError(result.error);
      else {
        setPendingOutIds(new Set());
        setPendingSwaps(new Map());
        setRefreshKey((k) => k + 1);
      }
    });
  }

  const sortColumnLabel = SORT_OPTIONS.find(([v]) => v === sortBy)?.[1] ?? "Rating";

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

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatBox label="Transfers" value="Unlimited" />
          <StatBox label="Bank" value={`£${displayBank.toFixed(1)}m`} />
          <StatBox label="Team Value" value={`£${optimisticTeamValue.toFixed(1)}m`} />
          <StatBox label="Formation" value={formationCode ?? "—"} />
        </div>

        {isPlanningView && uncoveredMatchDayCount > 0 && (
          <p className="mt-3 rounded-lg border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {uncoveredMatchDayCount} upcoming match-day{uncoveredMatchDayCount === 1 ? "" : "s"} - none of your squad play that day, so Mary
            can&apos;t set a captain there.{" "}
            <Link href="/cloudff/captains" className="font-semibold text-red-200 underline hover:text-white">
              Check Captains
            </Link>{" "}
            or make a transfer for coverage.
          </p>
        )}

        {pendingOutPlayers.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-700 bg-sky-950/40 px-4 py-2.5">
            <p className="text-sm text-sky-200">
              Selling <span className="font-semibold text-white">{pendingOutPlayers.map((p) => p.full_name).join(", ")}</span>. Their combined
              £{pendingOutPlayers.reduce((sum, p) => sum + p.price, 0).toFixed(1)}m is one shared pot - pick replacements for each slot in any
              order, any combination. Tap a filled slot on the pitch to change that pick, an empty one to cancel that sale, then Confirm once
              every slot has a pick.
            </p>
            <div className="flex items-center gap-3">
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
                  basePath="/cloudff"
                  currentGameweek={viewedGameweek}
                  minGameweek={minGameweek}
                  maxGameweek={maxGameweek}
                  planningGameweek={planningGameweek}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {isPlanningView && <SaveTeamButton isSaved={isTeamSaved} onSave={() => saveTeamForGameweek({ squadId })} />}
                <Link
                  href="/cloudff/ask-mary"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Ask Mary
                </Link>
                <Link
                  href="/cloudff/market-odds"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Market Odds
                </Link>
                <Link
                  href="/cloudff/captains"
                  className="relative rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Captains
                  {isPlanningView && uncoveredMatchDayCount > 0 && (
                    <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">
                      {uncoveredMatchDayCount}
                    </span>
                  )}
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
                        ["pts", "Rating"],
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
                if (isTransferPending) return;
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
          </div>

          {infoPlayerId != null ? (
            <PlayerInfoPanel gameSlug="cloudff" gamePlayerId={infoPlayerId} onBack={() => setInfoPlayerId(null)} viewedGameweek={viewedGameweek} />
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
                            {sortBy === "pts" ? <HailMaryRatingBadge rating={p.rating} /> : sortValue(p, sortBy).toFixed(2)}
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
