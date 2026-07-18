"use client";

import { useMemo, useState, useTransition } from "react";
import { saveLineup } from "../../actions";

type Player = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_name: string;
  price: number;
  is_starting: boolean;
  score: number | null;
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
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const quota = useMemo(() => {
    const f = formations.find((f) => f.code === formationCode);
    return { GK: f?.gk_count ?? 0, DEF: f?.def_count ?? 0, MID: f?.mid_count ?? 0, FWD: f?.fwd_count ?? 0 };
  }, [formations, formationCode]);

  const startingPlayers = players.filter((p) => starting.has(p.game_player_id));
  const countsByPosition = useMemo(() => {
    const counts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    startingPlayers.forEach((p) => (counts[p.position] += 1));
    return counts;
  }, [startingPlayers]);

  const isComplete = POSITIONS.every((pos) => countsByPosition[pos] === quota[pos]);

  function canToggleOn(player: Player) {
    return countsByPosition[player.position] < quota[player.position];
  }

  function toggle(player: Player) {
    setStarting((prev) => {
      const next = new Set(prev);
      if (next.has(player.game_player_id)) {
        next.delete(player.game_player_id);
      } else {
        if (!canToggleOn(player)) return prev;
        next.add(player.game_player_id);
      }
      return next;
    });
  }

  function applySuggestion() {
    if (!suggestion) return;
    setFormationCode(suggestion.formationCode);
    setStarting(new Set(suggestion.startingGamePlayerIds));
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

  const byPosition = POSITIONS.map((pos) => ({
    pos,
    players: players.filter((p) => p.position === pos).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
  }));

  return (
    <div>
      <div className="mb-4">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Formation</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {formations.map((f) => (
            <button
              key={f.code}
              onClick={() => {
                setFormationCode(f.code);
                setStarting(new Set());
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                formationCode === f.code
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "bg-zinc-100 text-zinc-600 hover:text-black dark:bg-zinc-900 dark:text-zinc-400"
              }`}
            >
              {f.code}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {POSITIONS.map((pos) => (
          <span key={pos} className={countsByPosition[pos] === quota[pos] ? "text-green-600 dark:text-green-400" : "text-zinc-500"}>
            {pos} {countsByPosition[pos]}/{quota[pos]}
          </span>
        ))}
        <span className="text-zinc-500">{starting.size}/{startingSize} starting</span>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button
          onClick={handleSave}
          disabled={!isComplete || isPending}
          className="rounded-lg bg-black px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {isPending ? "Saving..." : "Save lineup"}
        </button>
        {suggestion && (
          <button
            onClick={applySuggestion}
            className="rounded-lg border border-zinc-200 px-4 py-1.5 text-sm font-medium text-black hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-800"
          >
            Auto-fill optimal XI ({suggestion.formationCode}, {suggestion.total.toFixed(1)} pts)
          </button>
        )}
      </div>

      {byPosition.map(({ pos, players: posPlayers }) => (
        <div key={pos} className="mb-4">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">{pos}</p>
          <div className="flex flex-col gap-1">
            {posPlayers.map((p) => {
              const isStarting = starting.has(p.game_player_id);
              const disabled = !isStarting && !canToggleOn(p);
              return (
                <div
                  key={p.game_player_id}
                  onClick={() => !disabled && toggle(p)}
                  className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                    disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  } ${
                    isStarting
                      ? "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30"
                      : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
                  }`}
                >
                  <span className="text-black dark:text-zinc-50">
                    {p.full_name} <span className="text-zinc-500">({p.team_name})</span>
                    {p.score != null && <span className="ml-2 text-xs text-zinc-500">{p.score.toFixed(1)} pts</span>}
                  </span>
                  <span className="text-xs text-zinc-500">{isStarting ? "Starting" : "Bench"}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
