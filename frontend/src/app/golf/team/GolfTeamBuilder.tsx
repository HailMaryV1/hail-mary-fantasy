"use client";

import { useMemo, useState, useTransition } from "react";
import {
  buildGolfTeam,
  computeTeamTotal,
  GOLF_SQUAD_SIZE,
  GOLF_TEAM_VARIANTS,
  type GolfOptimizerPlayer,
  type GolfTeamVariant,
} from "@/lib/golfTeamOptimizer";
import { saveGolfTeam, deleteGolfTeam } from "./actions";

export default function GolfTeamBuilder({
  tournamentId,
  pool,
  budget,
  savedTeams,
  isLoggedIn,
}: {
  tournamentId: number;
  pool: GolfOptimizerPlayer[];
  budget: number;
  savedTeams: { id: number; name: string; players: string[] }[];
  isLoggedIn: boolean;
}) {
  const [variant, setVariant] = useState<GolfTeamVariant>("highest_projected");
  const [lockedIds, setLockedIds] = useState<number[]>([]);
  const [excludedIds, setExcludedIds] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [teamName, setTeamName] = useState("My Team");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [teams, setTeams] = useState(savedTeams);

  const byId = useMemo(() => new Map(pool.map((p) => [p.gamePlayerId, p])), [pool]);

  const teamIds = useMemo(
    () => buildGolfTeam(pool, variant, budget, lockedIds, excludedIds),
    [pool, variant, budget, lockedIds, excludedIds]
  );
  const team = useMemo(() => (teamIds ?? []).map((id) => byId.get(id)!).filter(Boolean), [teamIds, byId]);
  const { total, captainId, underdogId } = useMemo(() => computeTeamTotal(team), [team]);
  const totalPrice = team.reduce((s, p) => s + p.price, 0);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return pool.filter((p) => p.fullName.toLowerCase().includes(q) && !lockedIds.includes(p.gamePlayerId)).slice(0, 8);
  }, [pool, search, lockedIds]);

  function toggleLock(id: number) {
    setLockedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setExcludedIds((prev) => prev.filter((x) => x !== id));
  }
  function toggleExclude(id: number) {
    setExcludedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setLockedIds((prev) => prev.filter((x) => x !== id));
  }

  function handleSave() {
    setSaveError(null);
    setSaveMessage(null);
    if (!teamIds || teamIds.length !== GOLF_SQUAD_SIZE) {
      setSaveError("No valid team to save.");
      return;
    }
    startTransition(async () => {
      const result = await saveGolfTeam({ golfTournamentId: tournamentId, name: teamName, gamePlayerIds: teamIds });
      if ("error" in result && result.error) setSaveError(result.error);
      else {
        setSaveMessage("Team saved.");
        setTeams((prev) => [...prev, { id: result.squadId!, name: teamName, players: team.map((p) => p.fullName) }]);
      }
    });
  }

  function handleDelete(id: number) {
    startTransition(async () => {
      const result = await deleteGolfTeam(id);
      if (!("error" in result && result.error)) setTeams((prev) => prev.filter((t) => t.id !== id));
    });
  }

  return (
    <div>
      <div className="mt-6 flex flex-wrap gap-1 rounded-lg bg-navy-900 p-1">
        {GOLF_TEAM_VARIANTS.map((v) => (
          <button
            key={v.key}
            onClick={() => setVariant(v.key)}
            title={v.description}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              variant === v.key ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-navy-400">{GOLF_TEAM_VARIANTS.find((v) => v.key === variant)?.description}</p>

      <div className="relative mt-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search a golfer to lock into your team..."
          className="w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
        />
        {searchResults.length > 0 && (
          <div className="absolute z-10 mt-1 w-full rounded-lg border border-navy-700 bg-navy-900 shadow-lg">
            {searchResults.map((p) => (
              <button
                key={p.gamePlayerId}
                onClick={() => {
                  toggleLock(p.gamePlayerId);
                  setSearch("");
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-white hover:bg-navy-800"
              >
                <span>{p.fullName}</span>
                <span className="text-navy-400">£{p.price.toFixed(1)}m</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!teamIds && (
        <p className="mt-4 rounded-lg bg-red-950 p-4 text-sm text-red-300">
          No legal team fits under £{budget.toFixed(1)}m with your current locks/excludes - try unlocking or removing an exclude.
        </p>
      )}

      {team.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
                <th className="px-4 py-3 font-medium">Golfer</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">Expected</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {team.map((p) => {
                const isCaptain = p.gamePlayerId === captainId;
                const isUnderdog = p.gamePlayerId === underdogId;
                const isLocked = lockedIds.includes(p.gamePlayerId);
                return (
                  <tr key={p.gamePlayerId} className="border-b border-navy-800 last:border-0">
                    <td className="px-4 py-3 font-medium text-white">
                      {p.fullName}
                      {isCaptain && (
                        <span title="Captain - scores x1.25" className="ml-1.5 rounded bg-sky-950 px-1 py-0.5 text-[9px] font-bold text-sky-400">C</span>
                      )}
                      {isUnderdog && (
                        <span title="Underdog (cheapest pick) - scores x1.25, automatic" className="ml-1.5 rounded bg-emerald-950 px-1 py-0.5 text-[9px] font-bold text-emerald-400">UD</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-navy-300">£{p.price.toFixed(1)}m</td>
                    <td className="px-4 py-3 text-right text-sky-400">{p.expectedPoints.toFixed(1)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => toggleLock(p.gamePlayerId)}
                        className={`mr-1 rounded px-2 py-1 text-xs font-medium ${isLocked ? "bg-sky-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:text-white"}`}
                      >
                        {isLocked ? "Locked" : "Lock"}
                      </button>
                      <button
                        onClick={() => toggleExclude(p.gamePlayerId)}
                        className="rounded bg-navy-800 px-2 py-1 text-xs font-medium text-navy-300 hover:text-red-300"
                      >
                        Exclude
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-navy-700 px-4 py-3">
            <div className="text-sm text-navy-300">
              £{totalPrice.toFixed(1)}m / £{budget.toFixed(1)}m ·{" "}
              <span className="font-semibold text-sky-400">{total.toFixed(1)} pts</span> with captain/underdog applied
            </div>
          </div>
        </div>
      )}

      {isLoggedIn && team.length === GOLF_SQUAD_SIZE && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            className="rounded-lg border border-navy-700 bg-navy-900 px-3 py-1.5 text-sm text-white"
          />
          <button
            onClick={handleSave}
            disabled={isPending}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {isPending ? "Saving..." : "Save this team"}
          </button>
          {saveError && <span className="text-sm text-red-400">{saveError}</span>}
          {saveMessage && <span className="text-sm text-emerald-400">{saveMessage}</span>}
        </div>
      )}

      {teams.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Saved teams</h2>
          <div className="mt-2 flex flex-col gap-2">
            {teams.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded-lg border border-navy-700 bg-navy-900 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-white">{t.name}</p>
                  <p className="text-xs text-navy-400">{t.players.join(", ")}</p>
                </div>
                <button onClick={() => handleDelete(t.id)} className="text-xs text-navy-400 hover:text-red-300">
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
