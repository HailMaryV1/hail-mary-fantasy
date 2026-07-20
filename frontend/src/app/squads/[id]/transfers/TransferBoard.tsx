"use client";

import { useMemo, useState, useTransition } from "react";
import { makeTransfer } from "../../actions";
import PitchView from "../../PitchView";
import Badge from "../../Badge";
import StatusPill from "../../../StatusPill";
import { shortenPlayerName } from "@/lib/playerName";

const POSITIONS = ["ALL", "GK", "DEF", "MID", "FWD"] as const;
type SortKey = "score" | "price";

type SquadMember = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  price: number;
  is_starting: boolean;
  score: number | null;
  lineup?: string | null;
  status?: string | null;
  nextFixture?: { opponentAbbr: string; isHome: boolean } | null;
};

type PoolCandidate = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  price: number;
  score: number | null;
  lineup?: string | null;
  status?: string | null;
};

/**
 * Manual pick-your-own-swap board - click a squad player (pitch or bench)
 * to select them as OUT, then a same-position, budget/club-limit-legal
 * pool player as IN. Calls the same makeTransfer server action the
 * recommendation list below already uses (squads/actions.ts) - all the
 * free-transfer/-4pt/wildcard logic already lives there, nothing new to
 * duplicate here.
 */
export default function TransferBoard({
  squadId,
  squadMembers,
  pool,
  budgetRemaining,
  maxPerClub,
  clubCounts,
  currentGameweek,
  seasonStarted,
  freeTransfers,
  wildcardActiveThisWeek,
  wc1Available,
  wc2Available,
}: {
  squadId: number;
  squadMembers: SquadMember[];
  pool: PoolCandidate[];
  budgetRemaining: number;
  maxPerClub: number | null;
  clubCounts: Record<number, number>;
  currentGameweek: number | null;
  seasonStarted: boolean;
  freeTransfers: number;
  wildcardActiveThisWeek: boolean;
  wc1Available: boolean;
  wc2Available: boolean;
}) {
  const [selectedOutId, setSelectedOutId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [positionFilter, setPositionFilter] = useState<(typeof POSITIONS)[number]>("ALL");
  const [teamFilter, setTeamFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [useWildcard, setUseWildcard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const teams = useMemo(() => Array.from(new Set(pool.map((p) => p.team_name))).sort(), [pool]);

  const selectedOut = squadMembers.find((p) => p.game_player_id === selectedOutId) ?? null;
  const startingPlayers = squadMembers.filter((p) => p.is_starting);
  const benchPlayers = squadMembers.filter((p) => !p.is_starting);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function handleSquadSelect(gamePlayerId: number) {
    setSelectedOutId((prev) => (prev === gamePlayerId ? null : gamePlayerId));
    setError(null);
  }

  function canBringIn(candidate: PoolCandidate) {
    if (!selectedOut) return false;
    if (candidate.position !== selectedOut.position) return false;
    const affordableBudget = budgetRemaining + selectedOut.price;
    if (candidate.price > affordableBudget) return false;
    if (maxPerClub) {
      const clubCountWithoutOut = (clubCounts[candidate.team_id] ?? 0) - (candidate.team_id === selectedOut.team_id ? 1 : 0);
      if (clubCountWithoutOut + 1 > maxPerClub) return false;
    }
    return true;
  }

  const filteredPool = pool
    .filter((p) => !search.trim() || p.full_name.toLowerCase().includes(search.trim().toLowerCase()))
    .filter((p) => positionFilter === "ALL" || p.position === positionFilter)
    .filter((p) => teamFilter === "ALL" || p.team_name === teamFilter)
    .sort((a, b) => {
      const av = sortKey === "score" ? (a.score ?? 0) : a.price;
      const bv = sortKey === "score" ? (b.score ?? 0) : b.price;
      return sortDir === "desc" ? bv - av : av - bv;
    });

  const hasGameweek = currentGameweek !== null;
  // Pre-season transfers are free/unlimited regardless of the banked
  // free_transfers count (see squads/actions.ts's makeTransfer).
  const nextTransferFree = !hasGameweek || !seasonStarted || wildcardActiveThisWeek || useWildcard || freeTransfers > 0;

  function handleTransfer(inPlayer: PoolCandidate) {
    if (!selectedOut || !canBringIn(inPlayer) || isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await makeTransfer({
        squadId,
        outGamePlayerId: selectedOut.game_player_id,
        inGamePlayerId: inPlayer.game_player_id,
        useWildcard,
      });
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div>
      {hasGameweek && !wildcardActiveThisWeek && (wc1Available || wc2Available) && (
        <label className="mb-3 flex items-center gap-2 text-sm text-navy-300">
          <input
            type="checkbox"
            checked={useWildcard}
            onChange={(e) => setUseWildcard(e.target.checked)}
            className="accent-sky-500"
          />
          Use {wc1Available ? "Wildcard 1" : "Wildcard 2"} on my next transfer (makes all transfers free this
          gameweek, resets banked free transfers)
        </label>
      )}
      {selectedOut && (
        <p className="mb-3 text-sm text-navy-300">
          Transferring out <span className="font-medium text-white">{selectedOut.full_name}</span> ({selectedOut.position}) -{" "}
          <span className={nextTransferFree ? "text-emerald-400" : "text-red-400"}>
            {nextTransferFree ? "next transfer is free" : "costs -4 points"}
          </span>
          . Pick a same-position replacement from the pool.
        </p>
      )}
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {/* min-w-0 on both grid items - without it a grid/flex item can't
          shrink below its content's natural width (same gotcha as
          NavBar.tsx), so a long player name in the pool would silently
          force the whole row, and the page, to scroll horizontally
          instead of the intended internal wrapping/truncation kicking in. */}
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
        <div className="min-w-0 rounded-xl border border-navy-700 bg-navy-900 p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-navy-400">Player pool</p>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search player..."
            className="mb-2 w-full rounded-lg border border-navy-700 bg-navy-950 px-3 py-1.5 text-sm text-white"
          />
          <div className="mb-2 flex flex-wrap gap-1">
            {POSITIONS.map((p) => (
              <button
                key={p}
                onClick={() => setPositionFilter(p)}
                className={`rounded-md px-2 py-1 text-xs font-medium ${
                  positionFilter === p ? "bg-sky-500 text-navy-950" : "bg-navy-950 text-navy-300 hover:text-white"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="mb-2 w-full rounded-lg border border-navy-700 bg-navy-950 px-2 py-1 text-xs text-white"
          >
            <option value="ALL">All teams</option>
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <div className="mb-2 flex items-center gap-1 text-xs text-navy-400">
            <span>Sort:</span>
            <button
              onClick={() => toggleSort("score")}
              className={`rounded-md px-2 py-1 font-medium ${sortKey === "score" ? "bg-navy-800 text-white" : "hover:text-white"}`}
            >
              Score{sortKey === "score" ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
            </button>
            <button
              onClick={() => toggleSort("price")}
              className={`rounded-md px-2 py-1 font-medium ${sortKey === "price" ? "bg-navy-800 text-white" : "hover:text-white"}`}
            >
              Price{sortKey === "price" ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
            </button>
          </div>
          <div className="flex max-h-[28rem] flex-col gap-1 overflow-y-auto">
            {filteredPool.slice(0, 100).map((p) => {
              const clickable = canBringIn(p);
              return (
                <button
                  key={p.game_player_id}
                  onClick={() => handleTransfer(p)}
                  disabled={!clickable || isPending}
                  className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm ${
                    clickable ? "bg-navy-950 hover:bg-navy-800" : "cursor-not-allowed bg-navy-950/40 opacity-40"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-white">
                    <Badge teamName={p.team_name} size="sm" />
                    <span className="min-w-0">
                      <span className="inline-flex items-center" title={p.full_name}>
                        {shortenPlayerName(p.full_name)}
                        <StatusPill lineup={p.lineup} status={p.status} />
                      </span>
                      <span className="block text-xs text-navy-400">
                        {p.team_name} · {p.position} · £{Number(p.price).toFixed(1)}m
                      </span>
                    </span>
                  </span>
                  {p.score != null && <span className="ml-2 shrink-0 text-sky-400">{p.score.toFixed(1)}</span>}
                </button>
              );
            })}
            {filteredPool.length === 0 && <p className="px-2 py-4 text-center text-xs text-navy-400">No players match.</p>}
          </div>
        </div>

        <PitchView
          starting={startingPlayers}
          bench={benchPlayers}
          selectedId={selectedOutId}
          swappableIds={null}
          onSelect={(player) => handleSquadSelect(player.game_player_id)}
        />
      </div>
    </div>
  );
}
