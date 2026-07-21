"use client";

import { useMemo, useState, useTransition } from "react";
import { saveLineup, applyRecommendation } from "../actions";
import { addToWatchlist } from "@/app/watchlist/actions";
import { findLegalReplacementsForOutgoing, type TransferCandidate } from "@/lib/transferMatching";
import PitchView from "../PitchView";
import PlayerActionMenu, { type PlayerAction } from "../PlayerActionMenu";

// position widened to string (not the soccer-only literal union) purely so
// this still type-checks against PitchView's now-shared PitchPlayer type -
// this page itself is soccer-only (NFL has no bench/lineup concept), the
// GK/DEF/MID/FWD logic below is unaffected.
type Player = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_id: number;
  team_name: string;
  price: number;
  is_starting: boolean;
  score: number | null;
  lineup?: string | null;
  status?: string | null;
};

type Formation = {
  code: string;
  gk_count: number;
  def_count: number;
  mid_count: number;
  fwd_count: number;
};

type Suggestion = { formationCode: string; startingGamePlayerIds: number[]; total: number } | null;

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

function formationForCounts(counts: Record<string, number>, formations: Formation[]): string | null {
  const match = formations.find(
    (f) => f.gk_count === counts.GK && f.def_count === counts.DEF && f.mid_count === counts.MID && f.fwd_count === counts.FWD
  );
  return match?.code ?? null;
}

function toCandidate(player: Player): TransferCandidate {
  return {
    gamePlayerId: player.game_player_id,
    fullName: player.full_name,
    teamId: player.team_id,
    teamName: player.team_name,
    price: player.price,
    score: player.score ?? 0,
    position: player.position as TransferCandidate["position"],
  };
}

export default function LineupBuilder({
  squadId,
  gameId,
  startingSize,
  formations,
  players,
  suggestion,
  pool,
  budget,
  maxPerClub,
}: {
  squadId: number;
  gameId: number;
  startingSize: number;
  formations: Formation[];
  players: Player[];
  suggestion: Suggestion;
  pool: TransferCandidate[];
  budget: number;
  maxPerClub: number | null;
}) {
  const initialFormation =
    formations.find((f) => {
      const counts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
      players.filter((p) => p.is_starting).forEach((p) => (counts[p.position] += 1));
      return counts.GK === f.gk_count && counts.DEF === f.def_count && counts.MID === f.mid_count && counts.FWD === f.fwd_count;
    })?.code ?? formations[0]?.code ?? null;

  const [formationCode, setFormationCode] = useState<string | null>(initialFormation);
  const [starting, setStarting] = useState<Set<number>>(
    new Set(players.filter((p) => p.is_starting).map((p) => p.game_player_id))
  );
  const [selectedForSwapId, setSelectedForSwapId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [menuPlayer, setMenuPlayer] = useState<Player | null>(null);
  const [transferFor, setTransferFor] = useState<Player | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActionPending, startActionTransition] = useTransition();
  const [transferSearch, setTransferSearch] = useState("");
  const [transferTeamFilter, setTransferTeamFilter] = useState("ALL");
  const [transferSortKey, setTransferSortKey] = useState<"score" | "price">("score");
  const [transferSortDir, setTransferSortDir] = useState<"asc" | "desc">("desc");

  const quota = useMemo(() => {
    const f = formations.find((f) => f.code === formationCode);
    return { GK: f?.gk_count ?? 0, DEF: f?.def_count ?? 0, MID: f?.mid_count ?? 0, FWD: f?.fwd_count ?? 0 };
  }, [formations, formationCode]);

  const startingPlayers = players.filter((p) => starting.has(p.game_player_id));
  const benchPlayers = players.filter((p) => !starting.has(p.game_player_id));
  const countsByPosition = useMemo(() => {
    const counts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    startingPlayers.forEach((p) => (counts[p.position] += 1));
    return counts;
  }, [startingPlayers]);

  const isComplete = POSITIONS.every((pos) => countsByPosition[pos] === quota[pos]);

  // For the Transfer/Remove menu actions - findLegalReplacementsForOutgoing
  // needs to know what's already owned, what's affordable, and per-club
  // counts, same as TransferBoard.tsx computes for the Transfers page.
  const squadIds = useMemo(() => new Set(players.map((p) => p.game_player_id)), [players]);
  const budgetRemaining = useMemo(() => budget - players.reduce((sum, p) => sum + p.price, 0), [budget, players]);
  const clubCounts = useMemo(() => {
    const counts = new Map<number, number>();
    players.forEach((p) => counts.set(p.team_id, (counts.get(p.team_id) ?? 0) + 1));
    return counts;
  }, [players]);

  const transferCandidates = useMemo(
    () =>
      transferFor
        ? findLegalReplacementsForOutgoing(pool, toCandidate(transferFor), squadIds, budgetRemaining, clubCounts, maxPerClub)
        : [],
    [transferFor, pool, squadIds, budgetRemaining, clubCounts, maxPerClub]
  );
  const transferTeams = useMemo(
    () => Array.from(new Set(transferCandidates.map((m) => m.candidate.teamName))).sort(),
    [transferCandidates]
  );
  const filteredTransferCandidates = useMemo(() => {
    return transferCandidates
      .filter((m) => !transferSearch.trim() || m.candidate.fullName.toLowerCase().includes(transferSearch.trim().toLowerCase()))
      .filter((m) => transferTeamFilter === "ALL" || m.candidate.teamName === transferTeamFilter)
      .slice()
      .sort((a, b) => {
        const av = transferSortKey === "score" ? a.candidate.score : a.candidate.price;
        const bv = transferSortKey === "score" ? b.candidate.score : b.candidate.price;
        return transferSortDir === "desc" ? bv - av : av - bv;
      });
  }, [transferCandidates, transferSearch, transferTeamFilter, transferSortKey, transferSortDir]);

  function toggleTransferSort(key: "score" | "price") {
    if (key === transferSortKey) {
      setTransferSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setTransferSortKey(key);
      setTransferSortDir("desc");
    }
  }

  // The swap gesture generalizes to either direction (a starter or a bench
  // player can be the one you click "Swap" on first) - the source's zone
  // is read from `starting` (live state), not the stale is_starting prop,
  // since that's what startingPlayers/benchPlayers above already do.
  const swappableIds = useMemo(() => {
    if (selectedForSwapId === null) return null;
    const source = players.find((p) => p.game_player_id === selectedForSwapId);
    if (!source) return null;
    const sourceIsBench = !starting.has(selectedForSwapId);
    const ids = new Set<number>();

    if (sourceIsBench) {
      benchPlayers.forEach((p) => {
        if (p.game_player_id !== selectedForSwapId) ids.add(p.game_player_id);
      });
      startingPlayers.forEach((pitchPlayer) => {
        if (pitchPlayer.position === source.position) {
          ids.add(pitchPlayer.game_player_id);
          return;
        }
        const newCounts = { ...countsByPosition };
        newCounts[source.position] += 1;
        newCounts[pitchPlayer.position] -= 1;
        if (formationForCounts(newCounts, formations)) ids.add(pitchPlayer.game_player_id);
      });
    } else {
      // Swapping two starters with each other never changes the XI's
      // composition, so only bench players are meaningful targets here.
      benchPlayers.forEach((benchPlayer) => {
        if (benchPlayer.position === source.position) {
          ids.add(benchPlayer.game_player_id);
          return;
        }
        const newCounts = { ...countsByPosition };
        newCounts[benchPlayer.position] += 1;
        newCounts[source.position] -= 1;
        if (formationForCounts(newCounts, formations)) ids.add(benchPlayer.game_player_id);
      });
    }
    return ids;
  }, [selectedForSwapId, players, benchPlayers, startingPlayers, countsByPosition, formations, starting]);

  function completeSwap(target: Player) {
    const source = players.find((p) => p.game_player_id === selectedForSwapId);
    if (!source) return;
    const sourceIsBench = !starting.has(source.game_player_id);
    const benchPlayer = sourceIsBench ? source : target;
    const pitchPlayer = sourceIsBench ? target : source;

    let newFormationCode = formationCode;
    if (benchPlayer.position !== pitchPlayer.position) {
      const newCounts = { ...countsByPosition };
      newCounts[benchPlayer.position] += 1;
      newCounts[pitchPlayer.position] -= 1;
      const matched = formationForCounts(newCounts, formations);
      if (!matched) return; // shouldn't happen (dimmed already), but guard anyway
      newFormationCode = matched;
    }

    setStarting((prev) => {
      const next = new Set(prev);
      next.delete(pitchPlayer.game_player_id);
      next.add(benchPlayer.game_player_id);
      return next;
    });
    setFormationCode(newFormationCode);
    setSelectedForSwapId(null);
  }

  // Every click either completes a swap already in progress, cancels it
  // (clicking the same source again), or - the common case - opens the
  // action menu for whichever player was clicked. PitchView already
  // disables chips outside swappableIds while a swap is in progress, so
  // this only ever fires for a valid target in that mode.
  //
  // Takes only { game_player_id } (PitchView's PitchPlayer, not the fuller
  // local Player type) and re-looks the player up locally - keeps this
  // assignable to PitchView's onSelect prop without widening PitchView's
  // own player type just for this page's team_id need.
  function handlePitchSelect(clicked: { game_player_id: number }) {
    const player = players.find((p) => p.game_player_id === clicked.game_player_id);
    if (!player) return;
    if (selectedForSwapId === player.game_player_id) {
      setSelectedForSwapId(null);
      return;
    }
    if (selectedForSwapId !== null) {
      completeSwap(player);
      return;
    }
    setActionError(null);
    setMenuPlayer(player);
  }

  function applySuggestion() {
    if (!suggestion) return;
    setFormationCode(suggestion.formationCode);
    setStarting(new Set(suggestion.startingGamePlayerIds));
    setSelectedForSwapId(null);
  }

  function handleSave() {
    setError(null);
    if (!formationCode) return;
    startTransition(async () => {
      const result = await saveLineup({
        squadId,
        formationCode,
        startingGamePlayerIds: Array.from(starting),
      });
      if (result?.error) setError(result.error);
    });
  }

  function applyTransfer(outId: number, inId: number) {
    setActionError(null);
    startActionTransition(async () => {
      const result = await applyRecommendation({ squadId, transfers: [{ outGamePlayerId: outId, inGamePlayerId: inId }] });
      if (result?.error) setActionError(result.error);
    });
  }

  function handleRemove(player: Player) {
    const candidates = findLegalReplacementsForOutgoing(pool, toCandidate(player), squadIds, budgetRemaining, clubCounts, maxPerClub);
    if (candidates.length === 0) {
      setActionError(`No legal replacement available for ${player.full_name} right now.`);
      return;
    }
    applyTransfer(player.game_player_id, candidates[0].candidate.gamePlayerId);
  }

  function handleWatchlist(player: Player) {
    setActionError(null);
    startActionTransition(async () => {
      const result = await addToWatchlist({
        gameId,
        gamePlayerId: player.game_player_id,
        reasons: ["sell_watch"],
        notes: "Added from My Team.",
      });
      if (result?.error) setActionError(result.error);
    });
  }

  const menuActions: PlayerAction[] = menuPlayer
    ? [
        { label: "Swap (starting ↔ bench)", onClick: () => setSelectedForSwapId(menuPlayer.game_player_id) },
        {
          label: "Transfer Player",
          onClick: () => {
            setTransferSearch("");
            setTransferTeamFilter("ALL");
            setTransferFor(menuPlayer);
          },
        },
        { label: "Remove Player", onClick: () => handleRemove(menuPlayer), disabled: isActionPending },
        { label: "Add to Watchlist", onClick: () => handleWatchlist(menuPlayer), disabled: isActionPending },
      ]
    : [];

  return (
    <div>
      <div className="mb-4">
        <p className="text-xs font-medium uppercase tracking-wide text-navy-400">Formation</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {formations.map((f) => (
            <button
              key={f.code}
              onClick={() => {
                setFormationCode(f.code);
                setStarting(new Set());
                setSelectedForSwapId(null);
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                formationCode === f.code
                  ? "bg-sky-500 text-navy-950"
                  : "bg-navy-900 text-navy-300 hover:text-white"
              }`}
            >
              {f.code}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {POSITIONS.map((pos) => (
          <span key={pos} className={countsByPosition[pos] === quota[pos] ? "text-emerald-400" : "text-navy-400"}>
            {pos} {countsByPosition[pos]}/{quota[pos]}
          </span>
        ))}
        <span className="text-navy-400">{starting.size}/{startingSize} starting</span>
      </div>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {actionError && <p className="mb-3 text-sm text-red-400">{actionError}</p>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={handleSave}
          disabled={!isComplete || isPending}
          className="rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-navy-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? "Saving..." : "Save lineup"}
        </button>
        {suggestion && (
          <button
            onClick={applySuggestion}
            className="rounded-lg border border-navy-700 bg-navy-900 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-navy-800"
          >
            Auto-fill optimal XI ({suggestion.formationCode}, {suggestion.total.toFixed(1)} pts)
          </button>
        )}
      </div>

      <p className="mb-2 text-xs text-navy-400">
        {selectedForSwapId !== null
          ? "Pick a highlighted player to complete the swap - any swap that leaves a valid formation is allowed, not just same-position."
          : "Tap a player for options - swap, transfer, remove, or add to your watchlist."}
      </p>

      <PitchView
        starting={startingPlayers}
        bench={benchPlayers}
        selectedId={selectedForSwapId}
        swappableIds={swappableIds}
        onSelect={handlePitchSelect}
      />

      <PlayerActionMenu
        open={menuPlayer !== null}
        onClose={() => setMenuPlayer(null)}
        title={menuPlayer?.full_name ?? ""}
        subtitle={menuPlayer ? `${menuPlayer.position} · ${menuPlayer.team_name}` : undefined}
        actions={menuActions}
      />

      {transferFor && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setTransferFor(null)} />
          <div className="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-navy-700 bg-navy-900 shadow-lg sm:inset-x-auto sm:bottom-4 sm:left-1/2 sm:w-96 sm:-translate-x-1/2 sm:rounded-2xl sm:border">
            <div className="sticky top-0 border-b border-navy-800 bg-navy-900 px-4 py-3">
              <p className="text-sm font-medium text-white">Transfer out {transferFor.full_name}</p>
              <p className="text-xs text-navy-400">Pick a same-position replacement</p>
              <input
                type="text"
                value={transferSearch}
                onChange={(e) => setTransferSearch(e.target.value)}
                placeholder="Search player..."
                className="mt-2 w-full rounded-lg border border-navy-700 bg-navy-950 px-3 py-1.5 text-sm text-white"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={transferTeamFilter}
                  onChange={(e) => setTransferTeamFilter(e.target.value)}
                  className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1 text-xs text-white"
                >
                  <option value="ALL">All teams</option>
                  {transferTeams.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1 text-xs text-navy-400">
                  <span>Sort:</span>
                  <button
                    onClick={() => toggleTransferSort("score")}
                    className={`rounded-md px-2 py-1 font-medium ${transferSortKey === "score" ? "bg-navy-800 text-white" : "hover:text-white"}`}
                  >
                    Score{transferSortKey === "score" ? (transferSortDir === "desc" ? " ↓" : " ↑") : ""}
                  </button>
                  <button
                    onClick={() => toggleTransferSort("price")}
                    className={`rounded-md px-2 py-1 font-medium ${transferSortKey === "price" ? "bg-navy-800 text-white" : "hover:text-white"}`}
                  >
                    Price{transferSortKey === "price" ? (transferSortDir === "desc" ? " ↓" : " ↑") : ""}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-1 p-2">
              {filteredTransferCandidates.map((m) => (
                <button
                  key={m.candidate.gamePlayerId}
                  disabled={isActionPending}
                  onClick={() => {
                    applyTransfer(transferFor.game_player_id, m.candidate.gamePlayerId);
                    setTransferFor(null);
                  }}
                  className="flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="text-white">
                    {m.candidate.fullName}
                    <span className="block text-xs text-navy-400">
                      {m.candidate.teamName} · £{m.candidate.price.toFixed(1)}m
                    </span>
                  </span>
                  <span className="ml-2 shrink-0 text-sky-400">{m.candidate.score.toFixed(1)}</span>
                </button>
              ))}
              {transferCandidates.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-navy-400">No legal replacement available right now.</p>
              )}
              {transferCandidates.length > 0 && filteredTransferCandidates.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-navy-400">No players match.</p>
              )}
            </div>
            <button
              onClick={() => setTransferFor(null)}
              className="block w-full border-t border-navy-800 px-4 py-2.5 text-left text-sm text-navy-400 hover:bg-navy-800"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
