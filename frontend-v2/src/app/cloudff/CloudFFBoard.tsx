"use client";

import { useEffect, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import PitchView, { type PitchPlayer } from "@/components/PitchView";
import PlayerActionMenu, { type PlayerAction } from "@/components/PlayerActionMenu";
import PlayerInfoPanel from "@/components/PlayerInfoPanel";
import GameweekSwitcher from "@/components/GameweekSwitcher";
import { makeTransfer } from "./actions";

export type FixtureTile = { opponentAbbr: string; isHome: boolean; difficulty: number };

export type BoardPlayer = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_name: string;
  price: number;
  score: number | null;
  fixtures: (FixtureTile | null)[];
  // Real per-gameweek projections from the same decomposed-scoring engine
  // that produces `score` - drives the pool's "Sort by" dropdown.
  goalProjected: number;
  assistProjected: number;
  bonusProjected: number;
};

export type PoolPlayer = BoardPlayer;

type DisplayMode = "next1" | "next2" | "next3" | "pts" | "pred";
type SortBy = "pts" | "goals" | "assists" | "bonus";

const SORT_OPTIONS: [SortBy, string][] = [
  ["pts", "Pts"],
  ["goals", "Goals"],
  ["assists", "Assists"],
  ["bonus", "Bonus"],
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
  planningGameweek,
  viewedGameweek,
  isPlanningView,
  isPastView,
  pastViewState,
  minGameweek,
  maxGameweek,
  formationCode,
  squad,
  pool,
  squadSummary,
}: {
  squadId: number;
  squadName: string;
  bank: number;
  teamValue: number;
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
  squadSummary: string[];
}) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>("pts");
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Multiple squad members can be marked for sale at once - each becomes
  // an empty placeholder on the pitch, so a player unaffordable on any
  // single sale can become affordable once a cheaper swap elsewhere has
  // actually landed and grown the real bank - see DreamTeamBoard.tsx's
  // identical pattern/rationale (no fictional shared pot, legality always
  // reflects what the next real makeTransfer call can actually validate).
  const [pendingOutIds, setPendingOutIds] = useState<Set<number>>(new Set());
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
  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState<"ALL" | "GK" | "DEF" | "MID" | "FWD">("ALL");
  const [maxValue, setMaxValue] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("pts");
  const [teamFilter, setTeamFilter] = useState<string>("ALL");

  // Instant local guess for a transfer - see DreamTeamBoard.tsx's
  // identical pattern. React drops back to the real prop once the
  // transition settles.
  const [optimisticSquad, applyOptimisticSquad] = useOptimistic(squad, (_current: BoardPlayer[], next: BoardPlayer[]) => next);

  const teams = Array.from(new Set(pool.map((p) => p.team_name))).sort();

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

  const pendingOutPlayers = optimisticSquad.filter((p) => pendingOutIds.has(p.game_player_id));

  const pitchPlayers: PitchPlayer[] = optimisticSquad.map((p) => ({
    game_player_id: p.game_player_id,
    full_name: p.full_name,
    position: p.position,
    team_name: p.team_name,
    is_starting: true,
    price: p.price,
    score: p.score,
    statText: displayMode in fixtureModeCount ? undefined : statTextFor(p),
    statTiles: displayMode in fixtureModeCount ? fixtureTilesFor(p.fixtures, fixtureModeCount[displayMode]) : undefined,
    isEmpty: pendingOutIds.has(p.game_player_id),
    emptyLabel: `Sold ${p.full_name}`,
  }));

  const menuPlayer = menuPlayerId != null ? (menuIsSquadMember ? optimisticSquad : pool).find((p) => p.game_player_id === menuPlayerId) : undefined;
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
  const displayBank = optimisticBank + pendingOutPlayers.reduce((sum, p) => sum + p.price, 0);

  // Real legality, matching exactly what a single makeTransfer call will
  // itself validate server-side: each empty slot only has its OWN sale's
  // price to spend, plus whatever's already really in the bank - a second
  // pending sale's cash isn't real until that swap actually lands. No
  // transfer cap and no club-limit check - Cloud FF's transfers are always
  // free and its game_squad_rules.max_per_club is null (see ./actions.ts).
  function legalOutgoingFor(p: PoolPlayer): BoardPlayer[] {
    return pendingOutPlayers.filter((o) => o.position === p.position && optimisticBank + o.price >= p.price);
  }
  const legalPoolIds = new Set(pool.filter((p) => legalOutgoingFor(p).length > 0).map((p) => p.game_player_id));

  function handleTransfer(inGamePlayerId: number) {
    const incomingPoolPlayer = pool.find((p) => p.game_player_id === inGamePlayerId);
    if (!incomingPoolPlayer) return;
    // Of the empty slots this player can actually afford, fill the
    // cheapest-outgoing one first - that leaves the more valuable pending
    // sale(s) still available to help fund a pricier pick later.
    const outgoing = legalOutgoingFor(incomingPoolPlayer).sort((a, b) => a.price - b.price)[0];
    if (!outgoing) return;
    setTransferError(null);
    startTransferTransition(async () => {
      applyOptimisticSquad(optimisticTransfer(optimisticSquad, outgoing.game_player_id, incomingPoolPlayer));
      const result = await makeTransfer({ squadId, outGamePlayerId: outgoing.game_player_id, inGamePlayerId });
      if (result?.error) setTransferError(result.error);
      else setPendingOutIds((prev) => { const next = new Set(prev); next.delete(outgoing.game_player_id); return next; });
    });
  }

  const filteredPool = pool
    .filter(
      (p) =>
        (posFilter === "ALL" || p.position === posFilter) &&
        (teamFilter === "ALL" || p.team_name === teamFilter) &&
        (search === "" || p.full_name.toLowerCase().includes(search.toLowerCase())) &&
        (maxValue === null || p.price <= maxValue)
    )
    .sort((a, b) => sortValue(b, sortBy) - sortValue(a, sortBy));

  const sortColumnLabel = SORT_OPTIONS.find(([v]) => v === sortBy)?.[1] ?? "Pts";

  // 15 rows/page rather than rendering the whole (position/team/value/
  // search-filtered) pool at once. Resets to page 1 whenever the filtered
  // set changes shape, so a stale page number never lands on an empty
  // page.
  const POOL_PAGE_SIZE = 15;
  const [poolPage, setPoolPage] = useState(1);
  useEffect(() => {
    setPoolPage(1);
  }, [posFilter, teamFilter, maxValue, sortBy, search]);
  const totalPoolPages = Math.max(1, Math.ceil(filteredPool.length / POOL_PAGE_SIZE));
  const clampedPoolPage = Math.min(poolPage, totalPoolPages);
  const pagedPool = filteredPool.slice((clampedPoolPage - 1) * POOL_PAGE_SIZE, clampedPoolPage * POOL_PAGE_SIZE);

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="flex items-center justify-between gap-2">
          <Link href="/" className="text-sm font-medium text-navy-400 hover:text-sky-400">
            ← Back to main menu
          </Link>
          <GameweekSwitcher
            basePath="/cloudff"
            currentGameweek={viewedGameweek}
            minGameweek={minGameweek}
            maxGameweek={maxGameweek}
            planningGameweek={planningGameweek}
          />
        </div>

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

        {pendingOutPlayers.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-700 bg-sky-950/40 px-4 py-2.5">
            <p className="text-sm text-sky-200">
              Selling <span className="font-semibold text-white">{pendingOutPlayers.map((p) => p.full_name).join(", ")}</span>. Fill each empty
              slot with a same-position replacement - picking a cheaper one for one slot frees real budget for a pricier pick in another, so a
              player you couldn&apos;t afford alone can become affordable once you&apos;ve banked a saving elsewhere. Tap an empty slot on the pitch
              to cancel that sale.
            </p>
            <button onClick={() => setPendingOutIds(new Set())} className="text-xs font-medium text-sky-400 hover:text-sky-300">
              Cancel all
            </button>
          </div>
        )}
        {transferError && <p className="mt-2 text-xs text-red-400">{transferError}</p>}

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">{squadName}</h2>
              <div className="flex items-center gap-2">
                <Link
                  href="/cloudff/ask-mary"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Ask Mary
                </Link>
                <Link
                  href="/cloudff/captains"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  Captains
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
                if (isTransferPending) return;
                if (pendingOutIds.has(p.game_player_id)) {
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
            <PlayerInfoPanel gameSlug="cloudff" gamePlayerId={infoPlayerId} onBack={() => setInfoPlayerId(null)} />
          ) : (
            <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
              <h2 className="text-sm font-semibold text-white">Browse all available players</h2>
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
                value={search}
                onChange={(e) => setSearch(e.target.value)}
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
                              handleTransfer(p.game_player_id);
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
                                <span className={`inline-block rounded px-1 py-0.5 text-[9px] font-bold text-white ${difficultyColor(f.difficulty)}`}>
                                  {f.isHome ? f.opponentAbbr : f.opponentAbbr.toLowerCase()}
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
                {filteredPool.length > 0 && (
                  <div className="mt-2 flex items-center justify-between text-[10px] text-navy-500">
                    <button
                      onClick={() => setPoolPage((p) => Math.max(1, p - 1))}
                      disabled={clampedPoolPage <= 1}
                      className="rounded px-2 py-1 font-medium text-navy-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-navy-300"
                    >
                      ← Prev
                    </button>
                    <span>
                      {(clampedPoolPage - 1) * POOL_PAGE_SIZE + 1}-{Math.min(clampedPoolPage * POOL_PAGE_SIZE, filteredPool.length)} of{" "}
                      {filteredPool.length}
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
