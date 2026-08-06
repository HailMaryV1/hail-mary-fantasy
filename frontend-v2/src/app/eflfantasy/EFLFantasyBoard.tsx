"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import Link from "next/link";
import PitchView, { type PitchPlayer } from "@/components/PitchView";
import PlayerActionMenu, { type PlayerAction } from "@/components/PlayerActionMenu";
import PlayerInfoPanel from "@/components/PlayerInfoPanel";
import Kit from "@/components/Kit";
import GameweekSwitcher from "@/components/GameweekSwitcher";
import { searchPool } from "@/lib/poolSearch";
import { makeTransfer, makeClubTransfer } from "./actions";

export const POOL_PAGE_SIZE = 15;

type NextFixture = { opponent: string; isHome: boolean; gameweek: number };

export type BoardPlayer = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_name: string;
  score: number | null;
  nextFixture?: NextFixture | null;
  competition?: string | null;
};
export type PoolPlayer = BoardPlayer;

// A CLUB pick is a synthetic "player" (migration 0087) - same shape
// minus price/position, since neither is meaningful for a club slot.
export type BoardClub = {
  game_player_id: number;
  club_name: string;
  score: number | null;
  nextFixture?: NextFixture | null;
  lastSeasonAvgPoints?: number | null;
  competition?: string | null;
};
export type PoolClub = BoardClub;

function FixturePill({ fixture }: { fixture: NextFixture | null | undefined }) {
  if (!fixture) return null;
  return (
    <span className="rounded bg-navy-800 px-1 py-0.5 text-[9px] font-medium text-navy-300" title={`GW${fixture.gameweek}`}>
      {fixture.isHome ? "v" : "@"} {fixture.opponent}
    </span>
  );
}

function optimisticSwap<T extends { game_player_id: number }>(current: T[], outId: number, incoming: T): T[] {
  const stillHere = current.some((p) => p.game_player_id === outId);
  if (!stillHere) return current;
  return current.filter((p) => p.game_player_id !== outId).concat(incoming);
}

export default function EFLFantasyBoard({
  squadId,
  squadName,
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
  isPoolServerDriven,
}: {
  squadId: number;
  squadName: string;
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
  // False for a past-gameweek view, whose pool page.tsx already fetched
  // in full (see eflfantasy/page.tsx's fetchAllPoolRows) - that rare,
  // small-scale path keeps the old client-side filter/sort/paginate
  // behavior rather than hitting search_game_player_pool, since it's
  // scored from real actuals, not projections.
  isPoolServerDriven: boolean;
}) {
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
  const [poolTab, setPoolTab] = useState<"players" | "clubs">("players");
  const [poolPage, setPoolPage] = useState(1);

  const [optimisticSquad, applyOptimisticSquad] = useOptimistic(squad, (_current: BoardPlayer[], next: BoardPlayer[]) => next);
  const [optimisticClubs, applyOptimisticClubs] = useOptimistic(clubs, (_current: BoardClub[], next: BoardClub[]) => next);

  // Debounced search - typing shouldn't fire a fresh server request on
  // every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPoolPage(1);
  }, [posFilter, teamFilter, leagueFilter, debouncedSearch, poolTab]);

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
          excludeIds: squad.map((p) => p.game_player_id),
          excludeClub: true,
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
          excludeIds: clubs.map((c) => c.game_player_id),
          page: poolPage,
          pageSize: POOL_PAGE_SIZE,
        });
        setClubPool(
          result.rows.map((r) => ({
            game_player_id: r.game_player_id,
            club_name: r.team_name,
            score: r.hail_mary_score,
            competition: r.competition,
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
  }, [posFilter, teamFilter, leagueFilter, debouncedSearch, poolTab, poolPage, viewedGameweek, refreshKey]);

  const teams = isPoolServerDriven ? teamsProp : Array.from(new Set(initialPool.map((p) => p.team_name))).sort();

  const pendingOutPlayers = optimisticSquad.filter((p) => pendingOutIds.has(p.game_player_id));
  const pendingOutClubs = optimisticClubs.filter((c) => pendingOutClubIds.has(c.game_player_id));

  const pitchPlayers: PitchPlayer[] = optimisticSquad.map((p) => ({
    game_player_id: p.game_player_id,
    full_name: p.full_name,
    position: p.position,
    team_name: p.team_name,
    is_starting: true,
    price: null,
    score: p.score,
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
        : [{ label: "Player Info", onClick: () => setInfoPlayerId(menuPlayer.game_player_id) }]
      : [];

  // Same-position legality only - no budget exists for this game (see
  // gameConfig.ts's hasBudget), so unlike Dream Team/Cloud FF's "cheapest
  // outgoing first" pooled-budget logic, any pending-out slot of the
  // right position can fill any pool pick - first one found wins.
  function legalOutgoingFor(p: PoolPlayer): BoardPlayer[] {
    return pendingOutPlayers.filter((o) => o.position === p.position);
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

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <Link href="/" className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← Back to main menu
        </Link>

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

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatBox label="Transfers" value="Unlimited" />
          <StatBox label="Gameweek" value={`GW${viewedGameweek}`} />
          <StatBox label="Squad" value="1 GK · 2 DEF · 2 MID · 2 FWD · 2 CLUB" />
        </div>

        {(pendingOutPlayers.length > 0 || pendingOutClubs.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-700 bg-sky-950/40 px-4 py-2.5">
            <p className="text-sm text-sky-200">
              Selling{" "}
              <span className="font-semibold text-white">
                {[...pendingOutPlayers.map((p) => p.full_name), ...pendingOutClubs.map((c) => c.club_name)].join(", ")}
              </span>
              . Fill each empty slot with a same-type replacement (a player slot needs a same-position player, a club slot needs any other club)
              from the pool on the right. Tap an empty slot on the pitch to cancel that sale.
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
            <div className="mb-3 grid grid-cols-3 items-center gap-2">
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
              <div className="flex items-center justify-end gap-2">
                <Link
                  href="/eflfantasy/ask-mary"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Ask Mary
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
                      <Link
                        href="/eflfantasy/performance-lab"
                        className="block rounded-lg px-2 py-1.5 text-left text-xs text-navy-200 hover:bg-navy-800"
                        onClick={() => setOptionsOpen(false)}
                      >
                        Performance Lab
                      </Link>
                    </div>
                  )}
                </div>
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
                        {c.nextFixture ? ` · next ${c.nextFixture.isHome ? "vs" : "away to"} ${c.nextFixture.opponent} (GW${c.nextFixture.gameweek})` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {infoPlayerId != null ? (
            <PlayerInfoPanel gameSlug="eflfantasy" gamePlayerId={infoPlayerId} onBack={() => setInfoPlayerId(null)} />
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
                <option value="Championship">Championship</option>
                <option value="League One">League One</option>
                <option value="League Two">League Two</option>
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
                        <th className="pb-2 pr-2 font-medium">Pts</th>
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
                                  <div className="flex items-center gap-1 text-[10px] text-navy-500">
                                    <span>
                                      {p.team_name} · {p.position}
                                    </span>
                                    <FixturePill fixture={p.nextFixture} />
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-1.5 pr-2 text-sky-400">{p.score != null ? p.score.toFixed(1) : "-"}</td>
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
                                  <div className="flex items-center gap-1 text-[10px] text-navy-500">
                                    {c.lastSeasonAvgPoints != null && <span>{c.lastSeasonAvgPoints.toFixed(1)} pts/GW last season</span>}
                                    <FixturePill fixture={c.nextFixture} />
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-1.5 pr-2 text-sky-400">{c.score != null ? c.score.toFixed(1) : "-"}</td>
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
