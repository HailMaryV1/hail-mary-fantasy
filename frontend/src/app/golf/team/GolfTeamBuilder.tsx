"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import {
  buildGolfTeam,
  computeTeamTotal,
  determineFavouriteId,
  GOLF_SQUAD_SIZE,
  GOLF_TEAM_VARIANTS,
  type GolfOptimizerPlayer,
  type GolfTeamVariant,
} from "@/lib/golfTeamOptimizer";
import { saveGolfTeam, deleteGolfTeam } from "./actions";
import PushNotificationToggle from "./PushNotificationToggle";

type PoolSortKey = "expectedPoints" | "price";

export default function GolfTeamBuilder({
  tournamentId,
  pool,
  budget,
  savedTeams,
  isLoggedIn,
  watchedIds,
}: {
  tournamentId: number;
  pool: GolfOptimizerPlayer[];
  budget: number;
  savedTeams: { id: number; name: string; players: string[] }[];
  isLoggedIn: boolean;
  watchedIds: number[];
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

  // Swap UI state - select a golfer already in the team as OUT, then pick
  // an affordable pool golfer as IN.
  const [selectedOutId, setSelectedOutId] = useState<number | null>(null);
  const [poolSearch, setPoolSearch] = useState("");
  const [poolSortKey, setPoolSortKey] = useState<PoolSortKey>("expectedPoints");
  const [poolSortDir, setPoolSortDir] = useState<"asc" | "desc">("desc");
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const watchedSet = useMemo(() => new Set(watchedIds), [watchedIds]);

  const byId = useMemo(() => new Map(pool.map((p) => [p.gamePlayerId, p])), [pool]);

  const optimizerIds = useMemo(
    () => buildGolfTeam(pool, variant, budget, lockedIds, excludedIds),
    [pool, variant, budget, lockedIds, excludedIds]
  );
  const favourite = useMemo(
    () => (variant === "fade_favourite" ? byId.get(determineFavouriteId(pool, lockedIds, excludedIds) ?? -1) ?? null : null),
    [variant, pool, lockedIds, excludedIds, byId]
  );

  // Manual swaps override the optimizer's suggestion until the user
  // regenerates (changes variant/locks/excludes), at which point this
  // resets so the fresh optimizer output takes over again.
  const [manualIds, setManualIds] = useState<number[] | null>(null);
  // Captain is a real pre-tournament choice, not automatic like underdog -
  // null means "no manual pick yet, default to highest scorer." Reset
  // alongside manualIds on a full regenerate; a swap that knocks the
  // picked captain out is already handled inside computeTeamTotal itself
  // (falls back to auto-pick rather than erroring).
  const [captainOverrideId, setCaptainOverrideId] = useState<number | null>(null);
  useEffect(() => {
    setManualIds(null);
    setSelectedOutId(null);
    setCaptainOverrideId(null);
  }, [optimizerIds]);

  const teamIds = manualIds ?? optimizerIds;
  const team = useMemo(() => (teamIds ?? []).map((id) => byId.get(id)!).filter(Boolean), [teamIds, byId]);
  const { total, captainId, underdogId } = useMemo(
    () => computeTeamTotal(team, captainOverrideId),
    [team, captainOverrideId]
  );
  // Rounded to £0.1m granularity - summing several decimal prices in JS
  // float arithmetic can land a fraction of a penny off zero (order-
  // dependent), which would otherwise flip "£0.0m left" to "over budget"
  // for a team that's actually exactly at budget.
  const totalPrice = Math.round(team.reduce((s, p) => s + p.price, 0) * 100) / 100;
  const remainingBudget = Math.round((budget - totalPrice) * 100) / 100;

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return pool.filter((p) => p.fullName.toLowerCase().includes(q) && !lockedIds.includes(p.gamePlayerId)).slice(0, 8);
  }, [pool, search, lockedIds]);

  const selectedOut = team.find((p) => p.gamePlayerId === selectedOutId) ?? null;

  function canBringIn(candidate: GolfOptimizerPlayer) {
    if (!selectedOut) return false;
    if (team.some((p) => p.gamePlayerId === candidate.gamePlayerId)) return false;
    const affordableBudget = remainingBudget + selectedOut.price;
    return candidate.price <= affordableBudget;
  }

  function handleSquadSelect(gamePlayerId: number) {
    setSelectedOutId((prev) => (prev === gamePlayerId ? null : gamePlayerId));
  }

  function handleSwap(inPlayer: GolfOptimizerPlayer) {
    if (!selectedOut || !canBringIn(inPlayer) || !teamIds) return;
    setManualIds(teamIds.map((id) => (id === selectedOutId ? inPlayer.gamePlayerId : id)));
    setSelectedOutId(null);
  }

  function togglePoolSort(key: PoolSortKey) {
    if (key === poolSortKey) {
      setPoolSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setPoolSortKey(key);
      setPoolSortDir("desc");
    }
  }

  const filteredPool = useMemo(() => {
    const q = poolSearch.trim().toLowerCase();
    return pool
      .filter((p) => !team.some((t) => t.gamePlayerId === p.gamePlayerId))
      .filter((p) => !q || p.fullName.toLowerCase().includes(q))
      .filter((p) => !watchlistOnly || watchedSet.has(p.gamePlayerId))
      .slice()
      .sort((a, b) => {
        const av = poolSortKey === "expectedPoints" ? a.expectedPoints : a.price;
        const bv = poolSortKey === "expectedPoints" ? b.expectedPoints : b.price;
        return poolSortDir === "desc" ? bv - av : av - bv;
      });
  }, [pool, team, poolSearch, poolSortKey, poolSortDir, watchlistOnly, watchedSet]);

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
    if (!teamIds || teamIds.length !== GOLF_SQUAD_SIZE || captainId == null) {
      setSaveError("No valid team to save.");
      return;
    }
    startTransition(async () => {
      const result = await saveGolfTeam({
        golfTournamentId: tournamentId,
        name: teamName,
        gamePlayerIds: teamIds,
        captainGamePlayerId: captainId,
      });
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
      {favourite && (
        <p className="mt-1 text-xs text-amber-400">
          Fading: {favourite.fullName} (£{favourite.price.toFixed(1)}m)
        </p>
      )}

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

      {selectedOut && (
        <p className="mt-4 text-sm text-navy-300">
          Swapping out <span className="font-medium text-white">{selectedOut.fullName}</span> - pick a replacement
          from the pool on the left (only affordable golfers are clickable).
        </p>
      )}

      {team.length > 0 && (
        <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
          <div className="min-w-0 rounded-xl border border-navy-700 bg-navy-900 p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-navy-400">
              Player pool {selectedOut ? "- pick a replacement" : "- select a golfer in your team to swap"}
            </p>
            <input
              type="text"
              value={poolSearch}
              onChange={(e) => setPoolSearch(e.target.value)}
              placeholder="Search player..."
              className="mb-2 w-full rounded-lg border border-navy-700 bg-navy-950 px-3 py-1.5 text-sm text-white"
            />
            <div className="mb-2 flex items-center gap-1 text-xs text-navy-400">
              <span>Sort:</span>
              <button
                onClick={() => togglePoolSort("expectedPoints")}
                className={`rounded-md px-2 py-1 font-medium ${poolSortKey === "expectedPoints" ? "bg-navy-800 text-white" : "hover:text-white"}`}
              >
                Expected{poolSortKey === "expectedPoints" ? (poolSortDir === "desc" ? " ↓" : " ↑") : ""}
              </button>
              <button
                onClick={() => togglePoolSort("price")}
                className={`rounded-md px-2 py-1 font-medium ${poolSortKey === "price" ? "bg-navy-800 text-white" : "hover:text-white"}`}
              >
                Price{poolSortKey === "price" ? (poolSortDir === "desc" ? " ↓" : " ↑") : ""}
              </button>
              <button
                onClick={() => setWatchlistOnly((v) => !v)}
                className={`ml-auto rounded-md px-2 py-1 font-medium ${watchlistOnly ? "bg-amber-950 text-amber-400" : "hover:text-white"}`}
                title="Show only golfers on your watchlist"
              >
                ★ Watchlist
              </button>
            </div>
            <div className="flex max-h-[28rem] flex-col gap-1 overflow-y-auto">
              {filteredPool.slice(0, 100).map((p) => {
                const clickable = canBringIn(p);
                const isWatched = watchedSet.has(p.gamePlayerId);
                return (
                  <button
                    key={p.gamePlayerId}
                    onClick={() => handleSwap(p)}
                    disabled={!clickable}
                    className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm ${
                      clickable ? "bg-navy-950 hover:bg-navy-800" : "cursor-not-allowed bg-navy-950/40 opacity-40"
                    }`}
                  >
                    <span className="min-w-0 text-white">
                      <span className="block truncate" title={p.fullName}>
                        {isWatched && <span className="mr-1 text-amber-400">★</span>}
                        {p.fullName}
                      </span>
                      <span className="block text-xs text-navy-400">£{p.price.toFixed(1)}m</span>
                    </span>
                    <span className="ml-2 shrink-0 text-sky-400">{p.expectedPoints.toFixed(1)}</span>
                  </button>
                );
              })}
              {filteredPool.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-navy-400">
                  {watchlistOnly ? "No watchlisted golfers left to bring in." : "No golfers match."}
                </p>
              )}
            </div>
          </div>

          <div className="min-w-0 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
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
                  const isSelectedOut = p.gamePlayerId === selectedOutId;
                  const isExpanded = expandedId === p.gamePlayerId;
                  return (
                    <Fragment key={p.gamePlayerId}>
                      <tr
                        onClick={() => handleSquadSelect(p.gamePlayerId)}
                        className={`cursor-pointer border-b border-navy-800 last:border-0 hover:bg-navy-800 ${
                          isSelectedOut ? "bg-sky-950/40" : ""
                        }`}
                      >
                        <td className="px-4 py-3 font-medium text-white">
                          {p.fullName}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setCaptainOverrideId(p.gamePlayerId);
                            }}
                            title={isCaptain ? "Captain - scores x1.25" : "Make captain (scores x1.25)"}
                            className={`ml-1.5 rounded px-1 py-0.5 text-[9px] font-bold ${
                              isCaptain ? "bg-sky-950 text-sky-400" : "bg-navy-800 text-navy-500 hover:text-sky-300"
                            }`}
                          >
                            C
                          </button>
                          {isUnderdog && (
                            <span title="Underdog (cheapest pick) - scores x1.25, automatic" className="ml-1.5 rounded bg-emerald-950 px-1 py-0.5 text-[9px] font-bold text-emerald-400">UD</span>
                          )}
                          {p.explanation && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedId(isExpanded ? null : p.gamePlayerId);
                              }}
                              title="Why is Mary picking this golfer?"
                              className={`ml-1.5 rounded px-1 py-0.5 text-[9px] font-bold ${
                                isExpanded ? "bg-emerald-900 text-emerald-300" : "bg-navy-800 text-navy-500 hover:text-emerald-300"
                              }`}
                            >
                              Why?
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-navy-300">£{p.price.toFixed(1)}m</td>
                        <td className="px-4 py-3 text-right text-sky-400">{p.expectedPoints.toFixed(1)}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleLock(p.gamePlayerId);
                            }}
                            className={`mr-1 rounded px-2 py-1 text-xs font-medium ${isLocked ? "bg-sky-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:text-white"}`}
                          >
                            {isLocked ? "Locked" : "Lock"}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExclude(p.gamePlayerId);
                            }}
                            className="rounded bg-navy-800 px-2 py-1 text-xs font-medium text-navy-300 hover:text-red-300"
                          >
                            Exclude
                          </button>
                        </td>
                      </tr>
                      {isExpanded && p.explanation && (
                        <tr className="border-b border-navy-800 bg-navy-950/60 last:border-0">
                          <td colSpan={4} className="px-4 py-2 text-xs text-navy-400">
                            {p.explanation}
                            {p.makeCutProbability != null && (
                              <span className="ml-3 text-navy-500">Make cut: {(p.makeCutProbability * 100).toFixed(0)}%</span>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-navy-700 px-4 py-3">
              <div className="text-sm text-navy-300">
                £{totalPrice.toFixed(1)}m / £{budget.toFixed(1)}m ({remainingBudget >= 0 ? "£" + remainingBudget.toFixed(1) + "m left" : "over budget"}) ·{" "}
                <span className="font-semibold text-sky-400">{total.toFixed(1)} pts</span> with captain/underdog applied
              </div>
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Saved teams</h2>
            {isLoggedIn && <PushNotificationToggle />}
          </div>
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
