"use client";

import { useMemo, useState, useTransition } from "react";
import { saveSquad } from "../actions";

type Player = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_name: string;
  team_id: number;
  price: number;
  hail_mary_score: number | null;
};

type Formation = {
  code: string;
  gk_count: number;
  def_count: number;
  mid_count: number;
  fwd_count: number;
};

type Rules = {
  squad_size: number;
  budget: number;
  max_per_club: number | null;
  uses_formations: boolean;
  gk_quota: number | null;
  def_quota: number | null;
  mid_quota: number | null;
  fwd_quota: number | null;
};

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

export default function SquadBuilder({
  gameSlug,
  rules,
  formations,
  players,
}: {
  gameSlug: string;
  rules: Rules;
  formations: Formation[];
  players: Player[];
}) {
  const [formationCode, setFormationCode] = useState<string | null>(
    rules.uses_formations ? formations[0]?.code ?? null : null
  );
  const [name, setName] = useState(gameSlug === "dreamteam" ? "Dream Team Squad" : "FanTeam Squad");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [positionFilter, setPositionFilter] = useState<(typeof POSITIONS)[number] | "ALL">("ALL");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const quota = useMemo(() => {
    if (rules.uses_formations) {
      const f = formations.find((f) => f.code === formationCode);
      return { GK: f?.gk_count ?? 0, DEF: f?.def_count ?? 0, MID: f?.mid_count ?? 0, FWD: f?.fwd_count ?? 0 };
    }
    return { GK: rules.gk_quota ?? 0, DEF: rules.def_quota ?? 0, MID: rules.mid_quota ?? 0, FWD: rules.fwd_quota ?? 0 };
  }, [rules, formations, formationCode]);

  const selectedPlayers = useMemo(
    () => players.filter((p) => selected.has(p.game_player_id)),
    [players, selected]
  );

  const countsByPosition = useMemo(() => {
    const counts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    selectedPlayers.forEach((p) => (counts[p.position] += 1));
    return counts;
  }, [selectedPlayers]);

  const clubCounts = useMemo(() => {
    const counts = new Map<number, number>();
    selectedPlayers.forEach((p) => counts.set(p.team_id, (counts.get(p.team_id) ?? 0) + 1));
    return counts;
  }, [selectedPlayers]);

  const totalPrice = selectedPlayers.reduce((sum, p) => sum + Number(p.price), 0);
  const remainingBudget = rules.budget - totalPrice;
  const isComplete = POSITIONS.every((pos) => countsByPosition[pos] === quota[pos]) && remainingBudget >= 0;

  function canAdd(player: Player) {
    if (selected.has(player.game_player_id)) return true;
    if (countsByPosition[player.position] >= quota[player.position]) return false;
    if (Number(player.price) > remainingBudget) return false;
    if (rules.max_per_club) {
      const clubCount = clubCounts.get(player.team_id) ?? 0;
      if (clubCount >= rules.max_per_club) return false;
    }
    return true;
  }

  function toggle(player: Player) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(player.game_player_id)) {
        next.delete(player.game_player_id);
      } else {
        if (!canAdd(player)) return prev;
        next.add(player.game_player_id);
      }
      return next;
    });
  }

  const filteredPlayers = players
    .filter((p) => positionFilter === "ALL" || p.position === positionFilter)
    .filter((p) => !search.trim() || p.full_name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => (b.hail_mary_score ?? 0) - (a.hail_mary_score ?? 0));

  function handleSave() {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Give this squad a name.");
      return;
    }
    startTransition(async () => {
      const result = await saveSquad({
        gameSlug,
        formationCode,
        gamePlayerIds: Array.from(selected),
        name: trimmedName,
      });
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div>
      <div className="mb-4">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Squad name</p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Entry 2, Wildcard team"
          className="mt-1 w-full max-w-xs rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-black dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50"
        />
        <p className="mt-1 text-xs text-zinc-500">
          Running more than one {gameSlug === "fanteam" ? "FanTeam" : "Dream Team"} entry? Give each squad its own name so they&apos;re easy to tell apart on the squads list.
        </p>
      </div>

      {rules.uses_formations && (
        <div className="mb-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Formation</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {formations.map((f) => (
              <button
                key={f.code}
                onClick={() => {
                  setFormationCode(f.code);
                  setSelected(new Set());
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
      )}

      <div className="sticky top-0 z-10 -mx-6 mb-4 border-b border-zinc-200 bg-zinc-50/95 px-6 py-3 backdrop-blur dark:border-zinc-800 dark:bg-black/95">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className={`font-semibold ${remainingBudget < 0 ? "text-red-600" : "text-black dark:text-zinc-50"}`}>
            £{remainingBudget.toFixed(1)}m left
          </span>
          {POSITIONS.map((pos) => (
            <span
              key={pos}
              className={
                countsByPosition[pos] === quota[pos]
                  ? "text-green-600 dark:text-green-400"
                  : "text-zinc-500"
              }
            >
              {pos} {countsByPosition[pos]}/{quota[pos]}
            </span>
          ))}
          <span className="text-zinc-500">{selected.size}/{rules.squad_size} players</span>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <button
          onClick={handleSave}
          disabled={!isComplete || isPending}
          className="mt-2 rounded-lg bg-black px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {isPending ? "Saving..." : "Save squad"}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search player..."
          className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-black dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50"
        />
        <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
          {(["ALL", ...POSITIONS] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPositionFilter(p)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                positionFilter === p
                  ? "bg-white text-black shadow-sm dark:bg-zinc-700 dark:text-white"
                  : "text-zinc-500"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="px-4 py-2 font-medium"></th>
              <th className="px-4 py-2 font-medium">Player</th>
              <th className="px-4 py-2 font-medium">Team</th>
              <th className="px-4 py-2 font-medium">Pos</th>
              <th className="px-4 py-2 text-right font-medium">Price</th>
              <th className="px-4 py-2 text-right font-medium">Score</th>
            </tr>
          </thead>
          <tbody>
            {filteredPlayers.slice(0, 100).map((p) => {
              const isSelected = selected.has(p.game_player_id);
              const disabled = !isSelected && !canAdd(p);
              return (
                <tr
                  key={p.game_player_id}
                  onClick={() => !disabled && toggle(p)}
                  className={`border-b border-zinc-100 last:border-0 dark:border-zinc-900 ${
                    disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  } ${isSelected ? "bg-green-50 dark:bg-green-950/30" : ""}`}
                >
                  <td className="px-4 py-2">
                    <input type="checkbox" checked={isSelected} disabled={disabled} readOnly className="pointer-events-none" />
                  </td>
                  <td className="px-4 py-2 font-medium text-black dark:text-zinc-50">{p.full_name}</td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{p.team_name}</td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{p.position}</td>
                  <td className="px-4 py-2 text-right text-zinc-600 dark:text-zinc-400">{Number(p.price).toFixed(1)}</td>
                  <td className="px-4 py-2 text-right text-zinc-600 dark:text-zinc-400">
                    {p.hail_mary_score != null ? Number(p.hail_mary_score).toFixed(1) : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filteredPlayers.length > 100 && (
          <p className="border-t border-zinc-200 px-4 py-2 text-center text-xs text-zinc-500 dark:border-zinc-800">
            Showing top 100 of {filteredPlayers.length} - narrow your search to see more.
          </p>
        )}
      </div>
    </div>
  );
}
