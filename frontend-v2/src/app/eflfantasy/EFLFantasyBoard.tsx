"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import Link from "next/link";
import PitchView, { type PitchPlayer } from "@/components/PitchView";
import PlayerActionMenu, { type PlayerAction } from "@/components/PlayerActionMenu";
import PlayerInfoPanel from "@/components/PlayerInfoPanel";
import Kit from "@/components/Kit";
import GameweekSwitcher from "@/components/GameweekSwitcher";
import OddsRefreshButton from "@/components/OddsRefreshButton";
import SaveTeamButton from "@/components/SaveTeamButton";
import { searchPool } from "@/lib/poolSearch";
import { isLegalPositionSwap } from "@/lib/eflFormation";
import { makeTransfer, makeClubTransfer, addReserve, removeReserve, setReservesForPosition, saveTeamForGameweek } from "./actions";

export const POOL_PAGE_SIZE = 15;

// source: which team_fixture_difficulty COALESCE branch produced this
// fixture's difficulty - real bookmaker match odds once posted, the EFL's
// own FDR fallback before that. Surfaced as a small dot on the pill, same
// convention as DreamTeamBoard.tsx.
export type FixtureTile = { opponentAbbr: string; isHome: boolean; difficulty: number; source: "real_odds" | "fdr" };

// Real stats (2026-08-19 user request, mirroring fantasy.efl.com's own
// player popup - "Recent Gameweeks" points, appearances/clean sheets/
// tackles/clearances/blocks/interceptions/key passes/shots on target).
// See migration 0121's docstring - realTotalPoints is a rolling season-
// to-date total (not the same thing as lastGwPoints, a single real
// gameweek's result). Optional/nullable throughout: only ever real for
// EFL Fantasy today, and even there only once a player has actually
// featured in a real gameweek.
export type RealPlayerStats = {
  realTotalPoints?: number | null;
  realMinutesPlayed?: number | null;
  realGoals?: number | null;
  realAssists?: number | null;
  realCleanSheets?: number | null;
  realSaves?: number | null;
  realTackles?: number | null;
  realClearances?: number | null;
  realBlocks?: number | null;
  realInterceptions?: number | null;
  realKeyPasses?: number | null;
  realShotsOnTarget?: number | null;
  lastGw?: number | null;
  lastGwPoints?: number | null;
};

export type BoardPlayer = RealPlayerStats & {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_name: string;
  score: number | null;
  fixtures: (FixtureTile | null)[];
  competition?: string | null;
  // Live ownership % (2026-08-10 user request) - fantasy.efl.com's own
  // players.json has a real, confirmed-live "percentSelected" field
  // (e.g. K. Trippier at 55.6%). No price/budget exists in EFL Fantasy at
  // all (see migration 0089's docstring), so ownership is the only real
  // "Sort by" option this game gets beyond raw points.
  ownershipPct?: number | null;
};
export type PoolPlayer = BoardPlayer;

// A CLUB pick is a synthetic "player" (migration 0087) - same shape
// minus price/position, since neither is meaningful for a club slot.
export type BoardClub = {
  game_player_id: number;
  club_name: string;
  score: number | null;
  fixtures: (FixtureTile | null)[];
  // Full (non-abbreviated) opponent name for the "Why These Clubs" prose
  // line only - the colour-coded pills use fixtures[]'s abbreviated
  // opponentAbbr instead.
  nextFixtureLabel?: string | null;
  lastSeasonAvgPoints?: number | null;
  competition?: string | null;
};
export type PoolClub = BoardClub;

// The user's own researched backup shortlist per position (2026-08-11
// request) - EFL Fantasy has no bench at all, so this is the only
// fallback when a starter picks up last-minute bad news. GK is excluded
// on purpose (the user doesn't rate GK reserves as worth tracking).
export type ReservePosition = "DEF" | "MID" | "FWD";
export type ReservePick = {
  game_player_id: number;
  full_name: string;
  team_name: string;
  score: number | null;
  fixtures: (FixtureTile | null)[];
};
const RESERVE_POSITIONS: ReservePosition[] = ["DEF", "MID", "FWD"];

type DisplayMode = "next1" | "next2" | "next3" | "pts";
const FIXTURE_MODE_COUNT: Record<string, number> = { next1: 1, next2: 2, next3: 3 };

type SortBy = "pts" | "owned" | "real_pts" | "tackles" | "clearances" | "blocks" | "interceptions" | "key_passes" | "shots_on_target" | "saves";
const SORT_OPTIONS: [SortBy, string][] = [
  ["pts", "Projected Pts"],
  ["real_pts", "Total Pts (real)"],
  ["owned", "% Owned"],
  ["tackles", "Tackles"],
  ["clearances", "Clearances"],
  ["blocks", "Blocks"],
  ["interceptions", "Interceptions"],
  ["key_passes", "Key Passes"],
  ["shots_on_target", "Shots on Target"],
  ["saves", "Saves"],
];
// Off for now (2026-08-07, user request) - the pitch card always shows
// pts + next fixture together instead, since unlimited weekly transfers
// make planning several gameweeks ahead less useful here than on the
// other games. The toggle machinery stays intact (displayMode state,
// FIXTURE_MODE_COUNT, the dropdown JSX below) so it's a one-line flip
// to bring back, not a rebuild.
const FIXTURE_TOGGLE_ENABLED = false;

// attack_score is 0-1, higher = a better attacking fixture (easier) for
// that team - same tiering used on the other games' boards. Now backed
// by the 3-tier fixture-difficulty system (real bookmaker odds, falling
// back to EFL's own real FDR, see this project's fixture-difficulty
// memory) rather than the old averagePoints proxy.
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

// Pitch/Player-Info specific: unlike the pool table's compact upper/
// lowercase convention (fixtureTilesFor above), the pitch card has room
// to spell out home/away explicitly rather than relying on letter case,
// which the user found unclear - "vs"/"@" makes it unambiguous at a
// glance.
function pitchFixtureTile(tile: FixtureTile | null | undefined): { label: string; colorClass: string }[] {
  if (!tile) return [];
  return [{ label: `${tile.isHome ? "vs" : "@"} ${tile.opponentAbbr}`, colorClass: difficultyColor(tile.difficulty) }];
}

function optimisticSwap<T extends { game_player_id: number }>(current: T[], outId: number, incoming: T): T[] {
  const stillHere = current.some((p) => p.game_player_id === outId);
  if (!stillHere) return current;
  return current.filter((p) => p.game_player_id !== outId).concat(incoming);
}

export default function EFLFantasyBoard({
  squadId,
  squadName,
  isTeamSaved,
  planningGameweek,
  viewedGameweek,
  isPlanningView,
  isPastView,
  pastViewState,
  minGameweek,
  maxGameweek,
  squad,
  pool: initialPool,
  poolTotalCount: initialPoolTotalCount,
  clubs,
  clubPool: initialClubPool,
  clubPoolTotalCount: initialClubPoolTotalCount,
  teams: teamsProp,
  squadSummary,
  actualTotalPoints,
  seasonTotalPoints,
  isPoolServerDriven,
  fixtureTiles,
  reserves,
}: {
  squadId: number;
  squadName: string;
  isTeamSaved: boolean;
  planningGameweek: number;
  viewedGameweek: number;
  isPlanningView: boolean;
  isPastView: boolean;
  pastViewState: "not_locked" | "no_results_yet" | null;
  minGameweek: number;
  maxGameweek: number;
  squad: BoardPlayer[];
  pool: PoolPlayer[];
  poolTotalCount: number;
  clubs: BoardClub[];
  clubPool: PoolClub[];
  clubPoolTotalCount: number;
  teams: string[];
  squadSummary: string[];
  // Real total for a locked past gameweek (captain-doubled sum of squad +
  // clubs' actual points) - null on the planning view (no real result
  // yet) or before any result has been captured. 2026-08-19 user request:
  // "no record of how many points my team is on" - GW1's real per-player
  // points were showing, but nothing summed them into a visible total.
  actualTotalPoints: number | null;
  // Real season-to-date total (captain-doubled sum across every completed
  // gameweek, not just the one on screen) - 2026-08-19 user request: "a
  // large current points total somewhere on the page". Null only when no
  // gameweek has any real result yet (pre-season).
  seasonTotalPoints: number | null;
  // False for a past-gameweek view, whose pool page.tsx already fetched
  // in full (see eflfantasy/page.tsx's fetchAllPoolRows) - that rare,
  // small-scale path keeps the old client-side filter/sort/paginate
  // behavior rather than hitting search_game_player_pool, since it's
  // scored from real actuals, not projections.
  isPoolServerDriven: boolean;
  // Every team's next-6-gameweek fixture difficulty, keyed "teamId:gameweek" -
  // see FanTeamBoard.tsx's identical prop for why this is passed as a
  // plain object rather than recomputed per pool row.
  fixtureTiles: Record<string, FixtureTile>;
  // Empty on a past-gameweek view (see page.tsx's docstring) - the
  // shortlist is about backing up THIS week's live decisions, not a past
  // one.
  reserves: Record<ReservePosition, ReservePick[]>;
}) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>("pts");
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Multiple squad members can be marked for sale at once - see
  // DreamTeamBoard.tsx/CloudFFBoard.tsx's identical "no fictional shared
  // pot" pattern. No budget here at all (see gameConfig.ts's hasBudget),
  // so legality only ever needs a same-position check, never an
  // affordability one.
  const [pendingOutIds, setPendingOutIds] = useState<Set<number>>(new Set());
  const [pendingOutClubIds, setPendingOutClubIds] = useState<Set<number>>(new Set());
  const [isTransferPending, startTransferTransition] = useTransition();
  const [transferError, setTransferError] = useState<string | null>(null);
  const [menuPlayerId, setMenuPlayerId] = useState<number | null>(null);
  const [menuIsSquadMember, setMenuIsSquadMember] = useState(false);
  const [menuIsClub, setMenuIsClub] = useState(false);
  const [infoPlayerId, setInfoPlayerId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [posFilter, setPosFilter] = useState<"ALL" | "GK" | "DEF" | "MID" | "FWD">("ALL");
  const [teamFilter, setTeamFilter] = useState<string>("ALL");
  const [leagueFilter, setLeagueFilter] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<SortBy>("pts");
  const [poolTab, setPoolTab] = useState<"players" | "clubs">("players");
  const [poolPage, setPoolPage] = useState(1);

  const [optimisticSquad, applyOptimisticSquad] = useOptimistic(squad, (_current: BoardPlayer[], next: BoardPlayer[]) => next);
  const [optimisticClubs, applyOptimisticClubs] = useOptimistic(clubs, (_current: BoardClub[], next: BoardClub[]) => next);
  const [optimisticReserves, applyOptimisticReserves] = useOptimistic(
    reserves,
    (_current: Record<ReservePosition, ReservePick[]>, next: Record<ReservePosition, ReservePick[]>) => next
  );
  const [isReservePending, startReserveTransition] = useTransition();
  const [reserveError, setReserveError] = useState<string | null>(null);
  // Which reserve row's "swap in for which starter?" chooser is open -
  // only one at a time, keyed by the reserve's game_player_id.
  const [swapPickerReserveId, setSwapPickerReserveId] = useState<number | null>(null);

  // Debounced search - typing shouldn't fire a fresh server request on
  // every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPoolPage(1);
  }, [posFilter, teamFilter, leagueFilter, debouncedSearch, poolTab, sortBy]);

  // Server-driven pool state - only the page actually on screen, fetched
  // fresh from search_game_player_pool whenever a filter/search/page/tab
  // changes (see migration 0099/0100/0101 + poolSearch.ts). Starts from
  // whatever page.tsx already loaded for the very first render, so mount
  // doesn't cost a redundant duplicate request.
  const [pool, setPool] = useState<PoolPlayer[]>(initialPool);
  const [poolTotalCount, setPoolTotalCount] = useState(initialPoolTotalCount);
  const [clubPool, setClubPool] = useState<PoolClub[]>(initialClubPool);
  const [clubPoolTotalCount, setClubPoolTotalCount] = useState(initialClubPoolTotalCount);
  const [isPoolLoading, startPoolTransition] = useTransition();
  const isFirstRender = useRef(true);
  const [refreshKey, setRefreshKey] = useState(0);

  function buildFixtures(teamId: number): (FixtureTile | null)[] {
    return Array.from({ length: 6 }, (_, i) => fixtureTiles[`${teamId}:${viewedGameweek + i}`] ?? null);
  }

  function refetchPool() {
    if (!isPoolServerDriven) return;
    startPoolTransition(async () => {
      if (poolTab === "players") {
        const result = await searchPool({
          gameSlug: "eflfantasy",
          gameweek: viewedGameweek,
          position: posFilter === "ALL" ? null : posFilter,
          teamName: teamFilter === "ALL" ? null : teamFilter,
          competition: leagueFilter === "ALL" ? null : leagueFilter,
          search: debouncedSearch,
          // optimisticSquad, not squad - see DreamTeamBoard.tsx's identical
          // fix for why the server prop can't be trusted to be fresh at the
          // moment this refetch fires.
          excludeIds: optimisticSquad.map((p) => p.game_player_id),
          excludeClub: true,
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
            score: r.hail_mary_score,
            competition: r.competition,
            fixtures: buildFixtures(r.team_id),
            ownershipPct: r.ownershipPct,
            realTotalPoints: r.realTotalPoints,
            realMinutesPlayed: r.realMinutesPlayed,
            realGoals: r.realGoals,
            realAssists: r.realAssists,
            realCleanSheets: r.realCleanSheets,
            realSaves: r.realSaves,
            realTackles: r.realTackles,
            realClearances: r.realClearances,
            realBlocks: r.realBlocks,
            realInterceptions: r.realInterceptions,
            realKeyPasses: r.realKeyPasses,
            realShotsOnTarget: r.realShotsOnTarget,
            lastGw: r.lastGw,
            lastGwPoints: r.lastGwPoints,
          }))
        );
        setPoolTotalCount(result.totalCount);
      } else {
        const result = await searchPool({
          gameSlug: "eflfantasy",
          gameweek: viewedGameweek,
          position: "CLUB",
          competition: leagueFilter === "ALL" ? null : leagueFilter,
          search: debouncedSearch,
          // optimisticClubs, not clubs - same reasoning as the players
          // branch above.
          excludeIds: optimisticClubs.map((c) => c.game_player_id),
          page: poolPage,
          pageSize: POOL_PAGE_SIZE,
        });
        setClubPool(
          result.rows.map((r) => ({
            game_player_id: r.game_player_id,
            club_name: r.team_name,
            score: r.hail_mary_score,
            competition: r.competition,
            fixtures: buildFixtures(r.team_id),
          }))
        );
        setClubPoolTotalCount(result.totalCount);
      }
    });
  }

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    refetchPool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posFilter, teamFilter, leagueFilter, debouncedSearch, poolTab, poolPage, viewedGameweek, refreshKey, sortBy]);

  const teams = isPoolServerDriven ? teamsProp : Array.from(new Set(initialPool.map((p) => p.team_name))).sort();

  const pendingOutPlayers = optimisticSquad.filter((p) => pendingOutIds.has(p.game_player_id));
  const pendingOutClubs = optimisticClubs.filter((c) => pendingOutClubIds.has(c.game_player_id));

  // Real squad shape, derived from the actual squad rather than a fixed
  // "1 GK/2 DEF/2 MID/2 FWD" assumption - fantasy.efl.com's own team-
  // builder offers 3 real formations (2-2-2/2-3-1/3-2-1, confirmed live
  // 2026-08-08 via a screenshot of their UI), and migration 0089's claim
  // that formation was fixed turned out to be wrong. Transfers can now
  // change formation too (2026-08-10, see legalOutgoingFor below +
  // eflFormation.ts), so this always reflects whatever the squad
  // currently is, not a fixed default.
  const positionCounts = optimisticSquad.reduce(
    (acc, p) => ({ ...acc, [p.position]: (acc[p.position] ?? 0) + 1 }),
    {} as Record<BoardPlayer["position"], number>
  );
  const squadShapeLabel = `${positionCounts.GK ?? 0} GK · ${positionCounts.DEF ?? 0} DEF · ${positionCounts.MID ?? 0} MID · ${positionCounts.FWD ?? 0} FWD · 2 CLUB`;

  // Pitch chips always show both points and next fixture together now -
  // unlimited free transfers every gameweek (see gameConfig.ts's
  // hasBudget/transfer rules) means looking more than one week ahead
  // rarely changes a decision, so the old Next1/2/3-vs-Pts toggle (still
  // available - see FIXTURE_TOGGLE_ENABLED below) isn't the default view.
  const pitchPlayers: PitchPlayer[] = optimisticSquad.map((p) => ({
    game_player_id: p.game_player_id,
    full_name: p.full_name,
    position: p.position,
    team_name: p.team_name,
    is_starting: true,
    price: null,
    score: p.score,
    statText: FIXTURE_TOGGLE_ENABLED && displayMode in FIXTURE_MODE_COUNT ? undefined : `${p.score != null ? p.score.toFixed(1) : "-"} pts`,
    statTiles:
      FIXTURE_TOGGLE_ENABLED && displayMode in FIXTURE_MODE_COUNT
        ? fixtureTilesFor(p.fixtures, FIXTURE_MODE_COUNT[displayMode])
        : pitchFixtureTile(p.fixtures[0]),
    isEmpty: pendingOutIds.has(p.game_player_id),
    emptyLabel: `Sold ${p.full_name}`,
  }));
  const pitchClubs: PitchPlayer[] = optimisticClubs.map((c) => ({
    game_player_id: c.game_player_id,
    full_name: c.club_name,
    position: "CLUB",
    team_name: c.club_name,
    is_starting: true,
    price: null,
    statText: FIXTURE_TOGGLE_ENABLED && displayMode in FIXTURE_MODE_COUNT ? undefined : `${c.score != null ? c.score.toFixed(1) : "-"} pts`,
    statTiles:
      FIXTURE_TOGGLE_ENABLED && displayMode in FIXTURE_MODE_COUNT
        ? fixtureTilesFor(c.fixtures, FIXTURE_MODE_COUNT[displayMode])
        : pitchFixtureTile(c.fixtures[0]),
    score: c.score,
    isEmpty: pendingOutClubIds.has(c.game_player_id),
    emptyLabel: `Sold ${c.club_name}`,
  }));

  // Not server-driven (past view) - old full-array filter/sort, unchanged.
  const filteredPool = isPoolServerDriven
    ? pool
    : initialPool
        .filter(
          (p) =>
            (posFilter === "ALL" || p.position === posFilter) &&
            (teamFilter === "ALL" || p.team_name === teamFilter) &&
            (leagueFilter === "ALL" || p.competition === leagueFilter) &&
            (debouncedSearch === "" || p.full_name.toLowerCase().includes(debouncedSearch.toLowerCase()))
        )
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  const filteredClubPool = isPoolServerDriven
    ? clubPool
    : initialClubPool
        .filter(
          (c) =>
            (leagueFilter === "ALL" || c.competition === leagueFilter) &&
            (debouncedSearch === "" || c.club_name.toLowerCase().includes(debouncedSearch.toLowerCase()))
        )
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

  const pagedPool = isPoolServerDriven ? filteredPool : filteredPool.slice((poolPage - 1) * POOL_PAGE_SIZE, poolPage * POOL_PAGE_SIZE);
  const pagedClubPool = isPoolServerDriven ? filteredClubPool : filteredClubPool.slice((poolPage - 1) * POOL_PAGE_SIZE, poolPage * POOL_PAGE_SIZE);
  const activeTotalCount = isPoolServerDriven
    ? poolTab === "players"
      ? poolTotalCount
      : clubPoolTotalCount
    : poolTab === "players"
      ? filteredPool.length
      : filteredClubPool.length;
  const totalPoolPages = Math.max(1, Math.ceil(activeTotalCount / POOL_PAGE_SIZE));
  const clampedPoolPage = Math.min(poolPage, totalPoolPages);

  const menuPlayer = !menuIsClub && menuPlayerId != null ? (menuIsSquadMember ? optimisticSquad : pagedPool).find((p) => p.game_player_id === menuPlayerId) : undefined;
  const menuClub = menuIsClub && menuPlayerId != null ? (menuIsSquadMember ? optimisticClubs : pagedClubPool).find((c) => c.game_player_id === menuPlayerId) : undefined;

  // Player Info's fixture-pill row - looks across every list this
  // game_player_id could have been opened from (own squad, browse pool,
  // clubs, club pool), same coloured pills as the pitch/pool table.
  function fixturesForInfoPanel(id: number): { label: string; colorClass: string }[] {
    const found =
      optimisticSquad.find((p) => p.game_player_id === id) ??
      pagedPool.find((p) => p.game_player_id === id) ??
      optimisticClubs.find((c) => c.game_player_id === id) ??
      pagedClubPool.find((c) => c.game_player_id === id);
    return found ? fixtureTilesFor(found.fixtures, 3) : [];
  }
  const menuActions: PlayerAction[] = menuIsClub
    ? menuClub
      ? menuIsSquadMember
        ? [
            {
              label: "Transfer Out",
              onClick: () => setPendingOutClubIds((prev) => new Set(prev).add(menuClub.game_player_id)),
              disabled: !isPlanningView || pendingOutClubIds.has(menuClub.game_player_id),
            },
          ]
        : []
      : []
    : menuPlayer
      ? menuIsSquadMember
        ? [
            {
              label: "Transfer Out",
              onClick: () => setPendingOutIds((prev) => new Set(prev).add(menuPlayer.game_player_id)),
              disabled: !isPlanningView || pendingOutIds.has(menuPlayer.game_player_id),
            },
            { label: "Player Info", onClick: () => setInfoPlayerId(menuPlayer.game_player_id) },
          ]
        : [
            { label: "Player Info", onClick: () => setInfoPlayerId(menuPlayer.game_player_id) },
            // GK excluded - the user doesn't rate GK reserves as worth
            // tracking (see ReservePosition's docstring).
            ...(isPlanningView &&
            menuPlayer.position !== "GK" &&
            !optimisticReserves[menuPlayer.position as ReservePosition].some((r) => r.game_player_id === menuPlayer.game_player_id)
              ? [
                  {
                    label: "Add as Reserve",
                    onClick: () =>
                      handleAddReserve(menuPlayer.position as ReservePosition, {
                        game_player_id: menuPlayer.game_player_id,
                        full_name: menuPlayer.full_name,
                        team_name: menuPlayer.team_name,
                        score: menuPlayer.score,
                        fixtures: menuPlayer.fixtures,
                      }),
                  },
                ]
              : []),
          ]
      : [];

  // No budget exists for this game (see gameConfig.ts's hasBudget), so
  // unlike Dream Team/Cloud FF's "cheapest outgoing first" pooled-budget
  // logic, legality here is purely positional. A same-position pending-out
  // slot always matches (never changes formation); a different-position
  // slot matches only if that swap keeps the squad on one of the 3 real
  // formations (see eflFormation.ts). Same-position matches are ranked
  // first so marking two players "Transfer Out" at once never accidentally
  // spends the wrong slot on a formation change the user didn't ask for.
  function legalOutgoingFor(p: PoolPlayer): BoardPlayer[] {
    const currentCounts = { DEF: positionCounts.DEF ?? 0, MID: positionCounts.MID ?? 0, FWD: positionCounts.FWD ?? 0 };
    return pendingOutPlayers
      .filter((o) => isLegalPositionSwap(o.position, p.position, currentCounts))
      .sort((a, b) => (a.position === p.position ? 0 : 1) - (b.position === p.position ? 0 : 1));
  }
  const legalPoolIds = new Set(pagedPool.filter((p) => legalOutgoingFor(p).length > 0).map((p) => p.game_player_id));

  function handleTransfer(inGamePlayerId: number) {
    const incomingPoolPlayer = pagedPool.find((p) => p.game_player_id === inGamePlayerId);
    if (!incomingPoolPlayer) return;
    const outgoing = legalOutgoingFor(incomingPoolPlayer)[0];
    if (!outgoing) return;
    setTransferError(null);
    startTransferTransition(async () => {
      applyOptimisticSquad(optimisticSwap(optimisticSquad, outgoing.game_player_id, incomingPoolPlayer));
      const result = await makeTransfer({ squadId, outGamePlayerId: outgoing.game_player_id, inGamePlayerId });
      if (result?.error) setTransferError(result.error);
      else {
        setPendingOutIds((prev) => {
          const next = new Set(prev);
          next.delete(outgoing.game_player_id);
          return next;
        });
        setRefreshKey((k) => k + 1);
      }
    });
  }

  function handleClubTransfer(inGamePlayerId: number) {
    const incomingPoolClub = pagedClubPool.find((c) => c.game_player_id === inGamePlayerId);
    const outgoing = pendingOutClubs[0];
    if (!incomingPoolClub || !outgoing) return;
    setTransferError(null);
    startTransferTransition(async () => {
      applyOptimisticClubs(optimisticSwap(optimisticClubs, outgoing.game_player_id, incomingPoolClub));
      const result = await makeClubTransfer({ squadId, outGamePlayerId: outgoing.game_player_id, inGamePlayerId });
      if (result?.error) setTransferError(result.error);
      else {
        setPendingOutClubIds((prev) => {
          const next = new Set(prev);
          next.delete(outgoing.game_player_id);
          return next;
        });
        setRefreshKey((k) => k + 1);
      }
    });
  }

  // Which current squad starters a given reserve position could legally
  // replace - same-position starters always qualify (formation
  // unchanged); a different position only qualifies if that swap keeps
  // the squad on a real formation (see eflFormation.ts, same rule as the
  // main transfer flow's legalOutgoingFor above).
  function legalSwapTargetsForReserve(reservePosition: ReservePosition): BoardPlayer[] {
    const currentCounts = { DEF: positionCounts.DEF ?? 0, MID: positionCounts.MID ?? 0, FWD: positionCounts.FWD ?? 0 };
    return optimisticSquad
      .filter((p) => p.position !== "GK" && isLegalPositionSwap(p.position, reservePosition, currentCounts))
      .sort((a, b) => (a.position === reservePosition ? 0 : 1) - (b.position === reservePosition ? 0 : 1));
  }

  function handleAddReserve(position: ReservePosition, pick: ReservePick) {
    setReserveError(null);
    startReserveTransition(async () => {
      applyOptimisticReserves({ ...optimisticReserves, [position]: [...optimisticReserves[position], pick] });
      const result = await addReserve({ squadId, position, gamePlayerId: pick.game_player_id });
      if (result?.error) setReserveError(result.error);
    });
  }

  function handleRemoveReserve(position: ReservePosition, gamePlayerId: number) {
    setReserveError(null);
    startReserveTransition(async () => {
      applyOptimisticReserves({ ...optimisticReserves, [position]: optimisticReserves[position].filter((r) => r.game_player_id !== gamePlayerId) });
      const result = await removeReserve({ squadId, position, gamePlayerId });
      if (result?.error) setReserveError(result.error);
    });
  }

  function handleMoveReserve(position: ReservePosition, gamePlayerId: number, direction: "up" | "down") {
    const list = optimisticReserves[position];
    const i = list.findIndex((r) => r.game_player_id === gamePlayerId);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i === -1 || j < 0 || j >= list.length) return;
    const reordered = [...list];
    [reordered[i], reordered[j]] = [reordered[j], reordered[i]];
    setReserveError(null);
    startReserveTransition(async () => {
      applyOptimisticReserves({ ...optimisticReserves, [position]: reordered });
      const result = await setReservesForPosition({ squadId, position, gamePlayerIds: reordered.map((r) => r.game_player_id) });
      if (result?.error) setReserveError(result.error);
    });
  }

  // A subs-bench swap, not just a one-way promotion (2026-08-11 request) -
  // the demoted starter goes onto ITS OWN position's reserve list (which
  // may differ from `position` when the swap also changed formation - see
  // eflFormation.ts), so the two players can keep trading places without
  // ever needing to re-search the pool.
  function handleSwapInReserve(position: ReservePosition, pick: ReservePick, outgoing: BoardPlayer) {
    setSwapPickerReserveId(null);
    setTransferError(null);
    const outPos = outgoing.position as ReservePosition;
    const demoted: ReservePick = {
      game_player_id: outgoing.game_player_id,
      full_name: outgoing.full_name,
      team_name: outgoing.team_name,
      score: outgoing.score,
      fixtures: outgoing.fixtures,
    };
    startTransferTransition(async () => {
      applyOptimisticSquad(optimisticSwap(optimisticSquad, outgoing.game_player_id, { ...pick, position, competition: null }));
      const afterRemoval = { ...optimisticReserves, [position]: optimisticReserves[position].filter((r) => r.game_player_id !== pick.game_player_id) };
      applyOptimisticReserves({ ...afterRemoval, [outPos]: [...afterRemoval[outPos], demoted] });
      const result = await makeTransfer({ squadId, outGamePlayerId: outgoing.game_player_id, inGamePlayerId: pick.game_player_id });
      if (result?.error) {
        setTransferError(result.error);
        return;
      }
      await removeReserve({ squadId, position, gamePlayerId: pick.game_player_id });
      await addReserve({ squadId, position: outPos, gamePlayerId: outgoing.game_player_id });
      setRefreshKey((k) => k + 1);
    });
  }

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

        {seasonTotalPoints != null && (
          <div className="mt-4 flex items-baseline gap-3 rounded-xl border border-sky-700 bg-gradient-to-r from-sky-950/60 to-navy-900 px-5 py-4">
            <span className="text-4xl font-bold tabular-nums text-white sm:text-5xl">{seasonTotalPoints.toFixed(0)}</span>
            <span className="text-xs font-medium uppercase tracking-wide text-sky-300 sm:text-sm">Total Points</span>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatBox label="Transfers" value="Unlimited" />
          <StatBox label="Gameweek" value={`GW${viewedGameweek}`} />
          <StatBox label="Squad" value={squadShapeLabel} />
        </div>

        {isPlanningView && pendingOutPlayers.length === 0 && (
          <p className="mt-2 text-xs text-navy-500">
            Want a different formation? Transfer Out a player, then bring in one from a different position - 2-2-2, 2-3-1, and 3-2-1 are all real
            formations.
          </p>
        )}

        {(pendingOutPlayers.length > 0 || pendingOutClubs.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-700 bg-sky-950/40 px-4 py-2.5">
            <p className="text-sm text-sky-200">
              Selling{" "}
              <span className="font-semibold text-white">
                {[...pendingOutPlayers.map((p) => p.full_name), ...pendingOutClubs.map((c) => c.club_name)].join(", ")}
              </span>
              . Fill each empty slot from the pool on the right - a club slot needs any other club; a player slot can take a same-position
              replacement, or a different position if that keeps your squad on a real formation (2-2-2, 2-3-1, or 3-2-1). Tap an empty slot on the
              pitch to cancel that sale.
            </p>
            <button
              onClick={() => {
                setPendingOutIds(new Set());
                setPendingOutClubIds(new Set());
              }}
              className="text-xs font-medium text-sky-400 hover:text-sky-300"
            >
              Cancel all
            </button>
          </div>
        )}
        {transferError && <p className="mt-2 text-xs text-red-400">{transferError}</p>}

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div>
            <div className="mb-3 flex flex-col gap-2 sm:grid sm:grid-cols-3 sm:items-center">
              <h2 className="text-sm font-semibold text-white">{squadName}</h2>
              <div className="flex justify-center">
                <GameweekSwitcher
                  basePath="/eflfantasy"
                  currentGameweek={viewedGameweek}
                  minGameweek={minGameweek}
                  maxGameweek={maxGameweek}
                  planningGameweek={planningGameweek}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {isPlanningView && <SaveTeamButton isSaved={isTeamSaved} onSave={() => saveTeamForGameweek({ squadId })} />}
                <OddsRefreshButton gameSlug="eflfantasy" />
                <Link
                  href="/eflfantasy/ask-mary"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Ask Mary
                </Link>
                <Link
                  href="/eflfantasy/performance-lab"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Performance Lab
                </Link>
                <Link
                  href="/eflfantasy/market-odds"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Market Odds
                </Link>
                {FIXTURE_TOGGLE_ENABLED && (
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
                )}
              </div>
            </div>
            <PitchView
              starting={pitchPlayers}
              clubs={pitchClubs}
              selectedId={null}
              swappableIds={null}
              onSelect={(p) => {
                if (isTransferPending) return;
                const isClub = p.position === "CLUB";
                if (isClub && pendingOutClubIds.has(p.game_player_id)) {
                  setPendingOutClubIds((prev) => { const next = new Set(prev); next.delete(p.game_player_id); return next; });
                  return;
                }
                if (!isClub && pendingOutIds.has(p.game_player_id)) {
                  setPendingOutIds((prev) => { const next = new Set(prev); next.delete(p.game_player_id); return next; });
                  return;
                }
                setMenuPlayerId(p.game_player_id);
                setMenuIsSquadMember(true);
                setMenuIsClub(isClub);
              }}
            />
            {squadSummary.length > 0 && (
              <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Mary&apos;s Squad Summary</h2>
                <p className="mt-2 text-sm leading-relaxed text-navy-200">{squadSummary.join(" ")}</p>
              </div>
            )}
            {isPastView && actualTotalPoints != null && (
              <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">GW{viewedGameweek} Result</h2>
                <p className="mt-2 text-sm leading-relaxed text-navy-200">
                  Your squad scored <span className="font-semibold text-white">{actualTotalPoints.toFixed(1)} pts</span> in gameweek {viewedGameweek}
                  {" "}
                  (captain&apos;s points already doubled).
                </p>
              </div>
            )}
            {optimisticClubs.length > 0 && (
              <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Why These Clubs</h2>
                <div className="mt-2 flex flex-col gap-2">
                  {optimisticClubs.map((c) => (
                    <div key={c.game_player_id} className="flex items-center gap-2 text-sm">
                      <Kit teamName={c.club_name} size="sm" />
                      <span className="font-medium text-white">{c.club_name}</span>
                      <span className="text-navy-400">
                        {c.lastSeasonAvgPoints != null ? `averaged ${c.lastSeasonAvgPoints.toFixed(1)} pts/GW last season` : "no last-season data"}
                        {c.nextFixtureLabel ? ` · ${c.nextFixtureLabel}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {isPlanningView && (
              <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Reserves</h2>
                <p className="mt-1 text-xs text-navy-500">
                  Your researched backups per position - if a starter gets bad news, swap in the next name on the list.
                </p>
                {reserveError && <p className="mt-2 text-xs text-red-400">{reserveError}</p>}
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {RESERVE_POSITIONS.map((position) => (
                    <div key={position}>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-navy-500">{position}</p>
                      <div className="mt-1.5 flex flex-col gap-1.5">
                        {optimisticReserves[position].length === 0 && <p className="text-xs text-navy-600">No reserves yet - add from the pool.</p>}
                        {optimisticReserves[position].map((pick, i) => (
                          <div key={pick.game_player_id} className="rounded-lg border border-navy-800 bg-navy-950 p-2">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-semibold text-navy-500">{i + 1}</span>
                              <button
                                onClick={() => setInfoPlayerId(pick.game_player_id)}
                                className="min-w-0 flex-1 truncate text-left text-xs font-medium text-white hover:text-sky-300"
                              >
                                {pick.full_name}
                              </button>
                              {pick.fixtures[0] ? (
                                <span
                                  className={`inline-block rounded px-1 py-0.5 text-[9px] font-bold text-white ${difficultyColor(pick.fixtures[0].difficulty)}`}
                                >
                                  {pick.fixtures[0].isHome ? pick.fixtures[0].opponentAbbr : pick.fixtures[0].opponentAbbr.toLowerCase()}
                                </span>
                              ) : (
                                <span className="text-[9px] text-navy-700">-</span>
                              )}
                              <span className="text-[10px] text-navy-500">{pick.score != null ? pick.score.toFixed(1) : "-"}</span>
                            </div>
                            <div className="mt-1 flex items-center gap-1.5">
                              <button
                                onClick={() => handleMoveReserve(position, pick.game_player_id, "up")}
                                disabled={i === 0 || isReservePending}
                                className="rounded px-1 text-xs text-navy-500 hover:text-white disabled:opacity-30"
                                aria-label="Move up"
                              >
                                ↑
                              </button>
                              <button
                                onClick={() => handleMoveReserve(position, pick.game_player_id, "down")}
                                disabled={i === optimisticReserves[position].length - 1 || isReservePending}
                                className="rounded px-1 text-xs text-navy-500 hover:text-white disabled:opacity-30"
                                aria-label="Move down"
                              >
                                ↓
                              </button>
                              <button
                                onClick={() => setSwapPickerReserveId(swapPickerReserveId === pick.game_player_id ? null : pick.game_player_id)}
                                disabled={isTransferPending}
                                className="ml-auto rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-medium text-navy-950 hover:bg-sky-400 disabled:opacity-50"
                              >
                                Swap In
                              </button>
                              <button
                                onClick={() => handleRemoveReserve(position, pick.game_player_id)}
                                disabled={isReservePending}
                                className="rounded px-1 text-xs text-navy-500 hover:text-red-400"
                                aria-label="Remove reserve"
                              >
                                ✕
                              </button>
                            </div>
                            {swapPickerReserveId === pick.game_player_id && (
                              <div className="mt-1.5 flex flex-col gap-1 border-t border-navy-800 pt-1.5">
                                <p className="text-[10px] text-navy-500">Swap in for:</p>
                                {legalSwapTargetsForReserve(position).map((starter) => (
                                  <button
                                    key={starter.game_player_id}
                                    onClick={() => handleSwapInReserve(position, pick, starter)}
                                    className="rounded-lg border border-navy-700 bg-navy-900 px-2 py-1 text-left text-[11px] text-navy-200 hover:border-sky-500 hover:text-white"
                                  >
                                    {starter.full_name} <span className="text-navy-500">({starter.position})</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {infoPlayerId != null ? (
            <PlayerInfoPanel
              gameSlug="eflfantasy"
              gamePlayerId={infoPlayerId}
              onBack={() => setInfoPlayerId(null)}
              fixtures={fixturesForInfoPanel(infoPlayerId)}
            />
          ) : (
            <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
              <div className="mb-3 flex items-center gap-2">
                <button
                  onClick={() => setPoolTab("players")}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${poolTab === "players" ? "bg-sky-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:bg-navy-700"}`}
                >
                  Players
                </button>
                <button
                  onClick={() => setPoolTab("clubs")}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${poolTab === "clubs" ? "bg-sky-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:bg-navy-700"}`}
                >
                  Clubs
                </button>
                {isPoolLoading && <span className="text-[10px] text-navy-500">Loading…</span>}
              </div>

              <select
                value={leagueFilter}
                onChange={(e) => setLeagueFilter(e.target.value)}
                className="mb-2 rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              >
                <option value="ALL">All leagues</option>
                <option value="efl_championship">Championship</option>
                <option value="efl_league_one">League One</option>
                <option value="efl_league_two">League Two</option>
              </select>

              {poolTab === "players" ? (
                <>
                  <div className="flex flex-wrap gap-2">
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
                  <select
                    value={teamFilter}
                    onChange={(e) => setTeamFilter(e.target.value)}
                    className="mt-2 rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                  >
                    <option value="ALL">All clubs</option>
                    {teams.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortBy)}
                    className="mt-2 rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                  >
                    {SORT_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>
                        Sort: {label}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}

              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={poolTab === "players" ? "Search player..." : "Search club..."}
                className="mt-2 w-full rounded-lg border border-navy-700 bg-navy-950 px-3 py-2 text-sm text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              />

              <div className="mt-3 overflow-x-auto">
                {poolTab === "players" ? (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-navy-500">
                        <th className="pb-2 pr-2 font-medium">Player</th>
                        <th className="pb-2 pr-2 font-medium" title="Projected points for this gameweek">Proj</th>
                        <th className="pb-2 pr-2 font-medium" title="Real points scored so far this season">Total Pts</th>
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
                                handleTransfer(p.game_player_id);
                                return;
                              }
                              if (pendingOutPlayers.length === 0 && pendingOutClubs.length === 0) {
                                setMenuPlayerId(p.game_player_id);
                                setMenuIsSquadMember(false);
                                setMenuIsClub(false);
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
                              <div className="flex items-center gap-1.5">
                                <Kit teamName={p.team_name} size="sm" />
                                <div>
                                  <div className="font-medium text-white">{p.full_name}</div>
                                  <div className="text-[10px] text-navy-500">
                                    {p.team_name} · {p.position}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-1.5 pr-2 text-sky-400">{p.score != null ? p.score.toFixed(1) : "-"}</td>
                            <td className="py-1.5 pr-2 text-white">{p.realTotalPoints != null ? p.realTotalPoints.toFixed(1) : "-"}</td>
                            {p.fixtures.slice(0, 6).map((f, i) => (
                              <td key={i} className="px-1 py-1.5 text-center">
                                {f ? (
                                  <span
                                    className={`relative inline-block rounded px-1 py-0.5 text-[9px] font-bold text-white ${difficultyColor(f.difficulty)}`}
                                    title={f.source === "real_odds" ? "Live bookmaker odds" : "Estimated - EFL's own FDR ratings (no live odds posted yet)"}
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
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-navy-500">
                        <th className="pb-2 pr-2 font-medium">Club</th>
                        <th className="pb-2 pr-2 font-medium">Pts</th>
                        {Array.from({ length: 6 }, (_, i) => (
                          <th key={i} className="px-1 pb-2 text-center font-medium">
                            GW{viewedGameweek + i}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pagedClubPool.map((c) => {
                        const alreadyInSquad = optimisticClubs.some((sc) => sc.game_player_id === c.game_player_id);
                        const rowClickable = pendingOutClubs.length > 0 && !alreadyInSquad && !isTransferPending;
                        return (
                          <tr
                            key={c.game_player_id}
                            onClick={() => {
                              if (rowClickable) {
                                handleClubTransfer(c.game_player_id);
                                return;
                              }
                              if (pendingOutPlayers.length === 0 && pendingOutClubs.length === 0) {
                                setMenuPlayerId(c.game_player_id);
                                setMenuIsSquadMember(false);
                                setMenuIsClub(true);
                              }
                            }}
                            className={`border-t border-navy-800 ${
                              pendingOutClubs.length > 0
                                ? !alreadyInSquad
                                  ? "cursor-pointer bg-emerald-950/20 hover:bg-emerald-900/30"
                                  : "opacity-30"
                                : "cursor-pointer hover:bg-navy-800/60"
                            }`}
                          >
                            <td className="py-1.5 pr-2">
                              <div className="flex items-center gap-1.5">
                                <Kit teamName={c.club_name} size="sm" />
                                <div>
                                  <div className="font-medium text-white">{c.club_name}</div>
                                  {c.lastSeasonAvgPoints != null && (
                                    <div className="text-[10px] text-navy-500">{c.lastSeasonAvgPoints.toFixed(1)} pts/GW last season</div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="py-1.5 pr-2 text-sky-400">{c.score != null ? c.score.toFixed(1) : "-"}</td>
                            {c.fixtures.slice(0, 6).map((f, i) => (
                              <td key={i} className="px-1 py-1.5 text-center">
                                {f ? (
                                  <span
                                    className={`relative inline-block rounded px-1 py-0.5 text-[9px] font-bold text-white ${difficultyColor(f.difficulty)}`}
                                    title={f.source === "real_odds" ? "Live bookmaker odds" : "Estimated - EFL's own FDR ratings (no live odds posted yet)"}
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
                )}
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
        title={menuIsClub ? (menuClub?.club_name ?? "") : (menuPlayer?.full_name ?? "")}
        subtitle={menuIsClub ? "Club" : menuPlayer ? `${menuPlayer.position} · ${menuPlayer.team_name}` : undefined}
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
