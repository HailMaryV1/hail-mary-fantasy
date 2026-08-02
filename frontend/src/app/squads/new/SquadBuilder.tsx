"use client";

import { useMemo, useState, useTransition } from "react";
import { saveSquad, updateSquadPlayers } from "../actions";
import { autoFillBestSquad, type OptimizerPlayer } from "@/lib/squadOptimizer";
import Badge from "../Badge";
import StatusPill from "../../StatusPill";

type Player = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_name: string;
  team_id: number;
  price: number;
  hail_mary_score: number | null;
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
  editingSquadId,
  initialName,
  initialSelected,
  isScratch,
}: {
  gameSlug: string;
  rules: Rules;
  formations: Formation[];
  players: Player[];
  editingSquadId?: number;
  initialName?: string;
  initialSelected?: number[];
  isScratch?: boolean;
}) {
  const [formationCode, setFormationCode] = useState<string | null>(() => {
    if (!rules.uses_formations) return null;
    // When editing an existing squad, detect which formation its real
    // player counts actually match, rather than always defaulting to the
    // first formation in the list - otherwise the quota bar shows a
    // misleading over/under-quota state for a perfectly legal squad.
    if (editingSquadId && initialSelected && initialSelected.length > 0) {
      const counts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
      const selectedSet = new Set(initialSelected);
      players.forEach((p) => {
        if (selectedSet.has(p.game_player_id)) counts[p.position] += 1;
      });
      const match = formations.find(
        (f) => f.gk_count === counts.GK && f.def_count === counts.DEF && f.mid_count === counts.MID && f.fwd_count === counts.FWD
      );
      if (match) return match.code;
    }
    return formations[0]?.code ?? null;
  });
  const [name, setName] = useState(
    initialName ?? (isScratch ? "Test Squad" : gameSlug === "dreamteam" ? "Dream Team Squad" : "FanTeam Squad")
  );
  const [selected, setSelected] = useState<Set<number>>(new Set(initialSelected ?? []));
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
      const result = editingSquadId
        ? await updateSquadPlayers({ squadId: editingSquadId, gamePlayerIds: Array.from(selected) })
        : await saveSquad({ gameSlug, formationCode, gamePlayerIds: Array.from(selected), name: trimmedName, isScratch });
      if (result?.error) setError(result.error);
    });
  }

  function handleClear() {
    setError(null);
    setSelected(new Set());
  }

  function handleAutoFill() {
    setError(null);
    const optimizerPool: OptimizerPlayer[] = players.map((p) => ({
      gamePlayerId: p.game_player_id,
      position: p.position,
      teamId: p.team_id,
      price: Number(p.price),
      score: p.hail_mary_score != null ? Number(p.hail_mary_score) : 0,
    }));
    const bestIds = autoFillBestSquad(optimizerPool, quota, rules.budget, rules.max_per_club);
    if (bestIds.length !== rules.squad_size) {
      setError("Couldn't find a fully budget-legal squad automatically - try adjusting manually from here.");
    }
    setSelected(new Set(bestIds));
  }

  return (
    <div>
      <div className="mb-4">
        <p className="text-xs font-medium uppercase tracking-wide text-navy-400">Squad name</p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Entry 2, Wildcard team"
          className="mt-1 w-full max-w-xs rounded-lg border border-navy-700 bg-navy-900 px-3 py-1.5 text-sm text-white"
        />
        {(gameSlug === "fanteam" || gameSlug === "dreamteam") && (
          <p className="mt-1 text-xs text-navy-400">
            Running more than one {gameSlug === "fanteam" ? "FanTeam" : "Dream Team"} entry? Give each squad its own name so they&apos;re easy to tell apart on the squads list.
          </p>
        )}
      </div>

      {rules.uses_formations && (
        <div className="mb-4">
          <p className="text-xs font-medium uppercase tracking-wide text-navy-400">Formation</p>
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
                    ? "bg-sky-500 text-navy-950"
                    : "bg-navy-900 text-navy-300 hover:text-white"
                }`}
              >
                {f.code}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="sticky top-0 z-10 -mx-6 mb-4 border-b border-navy-700 bg-navy-950/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className={`font-semibold ${remainingBudget < 0 ? "text-red-400" : "text-white"}`}>
            £{remainingBudget.toFixed(1)}m left
          </span>
          {POSITIONS.map((pos) => (
            <span
              key={pos}
              className={
                countsByPosition[pos] === quota[pos]
                  ? "text-emerald-400"
                  : "text-navy-400"
              }
            >
              {pos} {countsByPosition[pos]}/{quota[pos]}
            </span>
          ))}
          <span className="text-navy-400">{selected.size}/{rules.squad_size} players</span>
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            onClick={handleSave}
            disabled={!isComplete || isPending}
            className="rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPending ? "Saving..." : editingSquadId ? "Save changes" : "Save squad"}
          </button>
          <button
            onClick={handleAutoFill}
            disabled={isPending}
            className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-40"
            title="Fills every slot with the strongest budget-legal combination by Hail Mary Score - a strong heuristic, not a mathematically proven optimum."
          >
            Auto-fill best XI
          </button>
          <button
            onClick={handleClear}
            disabled={isPending || selected.size === 0}
            className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-navy-300 hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear squad
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search player..."
          className="rounded-lg border border-navy-700 bg-navy-900 px-3 py-1.5 text-sm text-white"
        />
        <div className="flex gap-1 rounded-lg bg-navy-900 p-1">
          {(["ALL", ...POSITIONS] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPositionFilter(p)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                positionFilter === p
                  ? "bg-sky-500 text-navy-950"
                  : "text-navy-300"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
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
                  className={`border-b border-navy-800 last:border-0 ${
                    disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-navy-800"
                  } ${isSelected ? "bg-sky-950/40" : ""}`}
                >
                  <td className="px-4 py-2">
                    <input type="checkbox" checked={isSelected} disabled={disabled} readOnly className="pointer-events-none accent-sky-500" />
                  </td>
                  <td className="px-4 py-2 font-medium text-white">
                    <div className="flex items-center gap-2">
                      <Badge teamName={p.team_name} size="sm" />
                      {p.full_name}
                      <StatusPill lineup={p.lineup} status={p.status} />
                    </div>
                  </td>
                  <td className="px-4 py-2 text-navy-300">{p.team_name}</td>
                  <td className="px-4 py-2 text-navy-300">{p.position}</td>
                  <td className="px-4 py-2 text-right text-navy-300">{Number(p.price).toFixed(1)}</td>
                  <td className="px-4 py-2 text-right text-navy-300">
                    {p.hail_mary_score != null ? Number(p.hail_mary_score).toFixed(1) : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filteredPlayers.length > 100 && (
          <p className="border-t border-navy-700 px-4 py-2 text-center text-xs text-navy-400">
            Showing top 100 of {filteredPlayers.length} - narrow your search to see more.
          </p>
        )}
      </div>
    </div>
  );
}
