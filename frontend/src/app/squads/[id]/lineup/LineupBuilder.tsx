"use client";

import { useMemo, useState, useTransition } from "react";
import { saveLineup } from "../../actions";
import PitchView from "../../PitchView";

type Player = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
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

export default function LineupBuilder({
  squadId,
  startingSize,
  formations,
  players,
  suggestion,
}: {
  squadId: number;
  startingSize: number;
  formations: Formation[];
  players: Player[];
  suggestion: Suggestion;
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
  const [selectedBenchId, setSelectedBenchId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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

  // Once a bench player is selected, the swappable set is: every other
  // bench player (so you can change your mind about who's coming on) plus
  // every pitch player whose swap would leave the XI matching one of the
  // 7 real formations - same position always qualifies (no count change),
  // but a cross-position swap (e.g. bench DEF for a pitch MID) also
  // qualifies whenever the resulting counts happen to match a formation
  // (4-4-2 -> 5-3-2 in that example). GK never mixes with an outfield
  // position since no formation has GK != 1.
  const swappableIds = useMemo(() => {
    if (selectedBenchId === null) return null;
    const benchPlayer = players.find((p) => p.game_player_id === selectedBenchId);
    if (!benchPlayer) return null;
    const ids = new Set<number>();
    benchPlayers.forEach((p) => ids.add(p.game_player_id));
    startingPlayers.forEach((pitchPlayer) => {
      if (pitchPlayer.position === benchPlayer.position) {
        ids.add(pitchPlayer.game_player_id);
        return;
      }
      const newCounts = { ...countsByPosition };
      newCounts[benchPlayer.position] += 1;
      newCounts[pitchPlayer.position] -= 1;
      if (formationForCounts(newCounts, formations)) ids.add(pitchPlayer.game_player_id);
    });
    return ids;
  }, [selectedBenchId, players, benchPlayers, startingPlayers, countsByPosition, formations]);

  function handlePitchSelect(player: Player, zone: "pitch" | "bench") {
    if (zone === "bench") {
      setSelectedBenchId((prev) => (prev === player.game_player_id ? null : player.game_player_id));
      return;
    }
    if (selectedBenchId === null) return;
    const benchPlayer = players.find((p) => p.game_player_id === selectedBenchId);
    if (!benchPlayer) return;

    let newFormationCode = formationCode;
    if (benchPlayer.position !== player.position) {
      const newCounts = { ...countsByPosition };
      newCounts[benchPlayer.position] += 1;
      newCounts[player.position] -= 1;
      const matched = formationForCounts(newCounts, formations);
      if (!matched) return; // shouldn't happen (dimmed already), but guard anyway
      newFormationCode = matched;
    }

    setStarting((prev) => {
      const next = new Set(prev);
      next.delete(player.game_player_id);
      next.add(selectedBenchId);
      return next;
    });
    setFormationCode(newFormationCode);
    setSelectedBenchId(null);
  }

  function applySuggestion() {
    if (!suggestion) return;
    setFormationCode(suggestion.formationCode);
    setStarting(new Set(suggestion.startingGamePlayerIds));
    setSelectedBenchId(null);
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
                setSelectedBenchId(null);
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
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
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={handleSave}
          disabled={!isComplete || isPending}
          className="rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? "Saving..." : "Save lineup"}
        </button>
        {suggestion && (
          <button
            onClick={applySuggestion}
            className="rounded-lg border border-navy-700 bg-navy-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
          >
            Auto-fill optimal XI ({suggestion.formationCode}, {suggestion.total.toFixed(1)} pts)
          </button>
        )}
      </div>

      <p className="mb-2 text-xs text-navy-400">
        {selectedBenchId !== null
          ? "Pick a pitch player to swap them for your selected substitute - any swap that leaves a valid formation is allowed, not just same-position."
          : "Select a bench player, then a pitch player to swap them in."}
      </p>

      <PitchView
        starting={startingPlayers}
        bench={benchPlayers}
        selectedId={selectedBenchId}
        swappableIds={swappableIds}
        onSelect={handlePitchSelect}
      />
    </div>
  );
}
