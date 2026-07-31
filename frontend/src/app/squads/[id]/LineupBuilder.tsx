"use client";

import { useMemo, useState, useTransition } from "react";
import { saveLineup, saveTeamForGameweek, applyRecommendation } from "../actions";
import { addToWatchlist } from "@/app/watchlist/actions";
import { findLegalReplacementsForOutgoing, type TransferCandidate } from "@/lib/transferMatching";
import PitchView from "../PitchView";
import PlayerActionMenu, { type PlayerAction } from "../PlayerActionMenu";
import FormPill from "../../FormPill";
import type { FormStatus } from "@/lib/hailMaryForm";

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
  bench_order: number | null;
  score: number | null;
  lineup?: string | null;
  status?: string | null;
  formStatus?: FormStatus | null;
  is_captain?: boolean;
  is_vice_captain?: boolean;
};

type Formation = {
  code: string;
  gk_count: number;
  def_count: number;
  mid_count: number;
  fwd_count: number;
};

type Suggestion = { formationCode: string; startingGamePlayerIds: number[]; total: number } | null;

// One gameweek's worth of per-player fixture/expected/actual points for
// this squad - see squads/[id]/page.tsx for how the full 1..38 map is
// built server-side in one pass.
export type GameweekSnapshot = {
  gameweek: number;
  players: Record<
    number,
    { fixture: { opponentAbbr: string; isHome: boolean } | null; expectedPoints: number | null; actualPoints: number | null }
  >;
  squadExpected: number;
  squadActual: number | null;
};

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

function formationForCounts(counts: Record<string, number>, formations: Formation[]): string | null {
  const match = formations.find(
    (f) => f.gk_count === counts.GK && f.def_count === counts.DEF && f.mid_count === counts.MID && f.fwd_count === counts.FWD
  );
  return match?.code ?? null;
}

// Auto-substitution priority order for the outfield bench (1st/2nd/3rd
// reserve, GK excluded - a 15-man squad only ever has one reserve GK).
// Falls back to squad-array order when no bench_order has been saved yet,
// so the feature has a sensible default from the very first load.
function defaultBenchOrder(benchPlayers: Player[]): number[] {
  return benchPlayers
    .filter((p) => p.position !== "GK")
    .slice()
    .sort((a, b) => (a.bench_order ?? 99) - (b.bench_order ?? 99))
    .map((p) => p.game_player_id);
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
    formStatus: player.formStatus ?? null,
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
  gameweekData,
  initialGameweek,
  seasonGameweeks,
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
  // Undefined for games with no published calendar (Dream Team today) -
  // the gameweek switcher below doesn't render at all in that case.
  gameweekData?: Record<number, GameweekSnapshot>;
  initialGameweek?: number | null;
  seasonGameweeks?: number;
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
  // Auto-substitution priority for the 3 outfield bench spots, most
  // important (1st reserve) first - see defaultBenchOrder above and
  // PitchView's reorder controls below. GK isn't tracked here since a
  // 15-man squad only ever has exactly one reserve GK, nothing to order.
  const [benchOrderIds, setBenchOrderIds] = useState<number[]>(() => defaultBenchOrder(players.filter((p) => !p.is_starting)));
  // Direct swap - whoever's put into reserve slot `targetOrder` trades
  // places with whoever currently holds it, so moving reserve 3 into
  // reserve 1 (giving them first claim on an auto-substitution) is one
  // action, not three separate nudges.
  function setBenchPosition(gamePlayerId: number, targetOrder: number) {
    setBenchOrderIds((prev) => {
      const currentIdx = prev.indexOf(gamePlayerId);
      const targetIdx = targetOrder - 1;
      if (currentIdx === -1 || targetIdx < 0 || targetIdx >= prev.length || targetIdx === currentIdx) return prev;
      const next = prev.slice();
      [next[currentIdx], next[targetIdx]] = [next[targetIdx], next[currentIdx]];
      return next;
    });
  }
  // Browsing-only - which gameweek's fixture/expected/actual points the
  // pitch cards show. Independent of everything else here (transfer
  // matching, lineup saving) which all stay anchored to the current
  // actionable gameweek's own score, since those decisions apply going
  // forward from now, not for whichever gameweek is just being viewed.
  const [selectedGameweek, setSelectedGameweek] = useState<number>(initialGameweek ?? 1);
  const gwSnapshot = gameweekData?.[selectedGameweek];
  const displayPlayers = useMemo(
    () =>
      players.map((p) => {
        const gwPlayer = gwSnapshot?.players[p.game_player_id];
        return { ...p, score: gwPlayer ? gwPlayer.expectedPoints : p.score, nextFixture: gwPlayer?.fixture ?? null };
      }),
    [players, gwSnapshot]
  );
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

  const startingPlayers = displayPlayers.filter((p) => starting.has(p.game_player_id));
  const benchPlayers = displayPlayers.filter((p) => !starting.has(p.game_player_id));
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
      // Only pitch players are valid targets here - bench-to-bench has
      // its own dedicated reorder control (the "Res" dropdowns below),
      // and completeSwap's own pitchPlayer/benchPlayer split assumes
      // the target is always the pitch side when the source is bench.
      // Marking another bench player as "swappable" here used to let a
      // click add the source into the starting XI without removing
      // anyone (completeSwap had nothing on the pitch to delete) -
      // confirmed reachable, fixed by never offering it as a target.
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
    const targetIsBench = !starting.has(target.game_player_id);
    // Defense in depth: this logic only makes sense as bench<->pitch.
    // swappableIds should never offer a same-zone target, but if it
    // ever did, treating a bench target as "the pitch player" (the old
    // bug) added a player to the XI without removing anyone - bail
    // instead.
    if (sourceIsBench === targetIsBench) return;
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
    // benchPlayer just left the bench (now starting) - drop from the
    // order. pitchPlayer just joined it (now bench) - append at the end
    // (lowest priority) unless it's the GK, which isn't ordered.
    setBenchOrderIds((prev) => {
      const next = prev.filter((id) => id !== benchPlayer.game_player_id);
      if (pitchPlayer.position !== "GK" && !next.includes(pitchPlayer.game_player_id)) next.push(pitchPlayer.game_player_id);
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

  // Switching formation used to wipe the entire starting XI back to
  // empty (setStarting(new Set())) - confirmed live: picking a new
  // formation put all 15 players on the bench instead of adjusting the
  // lineup. Keeps every current starter who still fits the new
  // formation's per-position quota, trimming only the lowest-scoring
  // excess within a position that now has fewer slots (e.g. 5-3-2 ->
  // 4-4-2 drops the weakest DEF, not an arbitrary/random one) - nobody
  // is force-added for a position that now needs more, since guessing
  // who to promote isn't this action's job (Auto-fill optimal XI
  // already exists for that).
  function changeFormation(newFormation: Formation) {
    const newQuota: Record<string, number> = {
      GK: newFormation.gk_count,
      DEF: newFormation.def_count,
      MID: newFormation.mid_count,
      FWD: newFormation.fwd_count,
    };
    const keptCounts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    const kept = new Set<number>();
    players
      .filter((p) => starting.has(p.game_player_id))
      .slice()
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .forEach((p) => {
        if (keptCounts[p.position] < (newQuota[p.position] ?? 0)) {
          keptCounts[p.position] += 1;
          kept.add(p.game_player_id);
        }
      });

    const droppedIds = Array.from(starting).filter((id) => !kept.has(id));
    setBenchOrderIds((prev) => {
      const next = prev.slice();
      droppedIds.forEach((id) => {
        const player = players.find((p) => p.game_player_id === id);
        if (player && player.position !== "GK" && !next.includes(id)) next.push(id);
      });
      return next;
    });
    setStarting(kept);
    setFormationCode(newFormation.code);
    setSelectedForSwapId(null);
  }

  function applySuggestion() {
    if (!suggestion) return;
    const suggestedStarting = new Set(suggestion.startingGamePlayerIds);
    setFormationCode(suggestion.formationCode);
    setStarting(suggestedStarting);
    setBenchOrderIds(defaultBenchOrder(players.filter((p) => !suggestedStarting.has(p.game_player_id))));
    setSelectedForSwapId(null);
  }

  // game_player_id -> 1/2/3 for the outfield bench, from benchOrderIds'
  // position in the array - shared by both save paths below.
  const benchOrderPayload = useMemo(() => Object.fromEntries(benchOrderIds.map((id, i) => [id, i + 1])), [benchOrderIds]);

  function handleSave() {
    setError(null);
    if (!formationCode) return;
    startTransition(async () => {
      const result = await saveLineup({
        squadId,
        formationCode,
        startingGamePlayerIds: Array.from(starting),
        benchOrder: benchOrderPayload,
      });
      if (result?.error) setError(result.error);
    });
  }

  function handleSaveTeam() {
    setError(null);
    if (!formationCode) return;
    startTransition(async () => {
      const result = await saveTeamForGameweek({
        squadId,
        formationCode,
        startingGamePlayerIds: Array.from(starting),
        benchOrder: benchOrderPayload,
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
              onClick={() => changeFormation(f)}
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
        <button
          onClick={handleSaveTeam}
          disabled={!isComplete || isPending}
          title="Press once you've locked this team in on the real FanTeam site - archives Mary's current recommendation so Performance Lab can grade it against what actually happened."
          className="rounded-lg border border-emerald-700 bg-emerald-950 px-4 py-1.5 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? "Saving..." : "Save Team"}
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

      {gameweekData && seasonGameweeks && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-navy-700 bg-navy-900 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedGameweek((gw) => Math.max(1, gw - 1))}
              disabled={selectedGameweek <= 1}
              className="rounded-md px-2 py-1 text-sm text-navy-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Previous gameweek"
            >
              ‹
            </button>
            <span className="text-sm font-semibold text-white">GW{selectedGameweek}</span>
            <select
              value={selectedGameweek}
              onChange={(e) => setSelectedGameweek(Number(e.target.value))}
              className="rounded-md border border-navy-700 bg-navy-950 px-2 py-1 text-xs text-white"
            >
              {Array.from({ length: seasonGameweeks }, (_, i) => i + 1).map((gw) => (
                <option key={gw} value={gw}>
                  GW{gw}
                </option>
              ))}
            </select>
            <button
              onClick={() => setSelectedGameweek((gw) => Math.min(seasonGameweeks, gw + 1))}
              disabled={selectedGameweek >= seasonGameweeks}
              className="rounded-md px-2 py-1 text-sm text-navy-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Next gameweek"
            >
              ›
            </button>
          </div>
          <div className="flex gap-4 text-xs">
            <span className="text-navy-300">
              Expected <span className="font-semibold text-sky-400">{(gwSnapshot?.squadExpected ?? 0).toFixed(1)} pts</span>
            </span>
            <span className="text-navy-300">
              Actual{" "}
              <span className="font-semibold text-white">
                {gwSnapshot?.squadActual != null ? `${gwSnapshot.squadActual.toFixed(1)} pts` : "—"}
              </span>
            </span>
          </div>
        </div>
      )}

      <p className="mb-2 text-xs text-navy-400">
        {selectedForSwapId !== null
          ? "Pick a highlighted player to complete the swap - any swap that leaves a valid formation is allowed, not just same-position."
          : "Tap a player for options - swap, transfer, remove, or add to your watchlist."}
      </p>

      <PitchView
        starting={startingPlayers.map((p) => ({ ...p, isCaptain: p.is_captain, isViceCaptain: p.is_vice_captain }))}
        bench={benchPlayers.map((p) => ({
          ...p,
          isCaptain: p.is_captain,
          isViceCaptain: p.is_vice_captain,
          benchOrder: p.position === "GK" ? null : benchOrderIds.indexOf(p.game_player_id) + 1 || null,
        }))}
        selectedId={selectedForSwapId}
        swappableIds={swappableIds}
        onSelect={handlePitchSelect}
        onReorderBench={setBenchPosition}
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
                    <span className="inline-flex items-center">
                      {m.candidate.fullName}
                      <FormPill status={m.candidate.formStatus} />
                    </span>
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
