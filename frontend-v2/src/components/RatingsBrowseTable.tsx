"use client";

import { useEffect, useState } from "react";
import { searchPool, type PoolSearchRow, type PoolSortBy } from "@/lib/poolSearch";
import { formatRating, ratingTier, ratingBasisTag } from "@/lib/hailMaryRating";
import { formatFixtureShort } from "@/lib/fixtureFormat";
import Kit from "@/components/Kit";

const PAGE_SIZE = 20;

type PosFilter = "ALL" | "GK" | "DEF" | "MID" | "FWD" | "CLUB";

// Only the sort keys that make sense for a cross-position browse table -
// search_game_player_pool (migration 0135) also supports counting-stat
// sorts (tackles/saves/etc) but those are position-specific noise here,
// not something you'd browse the WHOLE pool by.
function sortOptions(hasBudget: boolean): [PoolSortBy, string][] {
  return [
    ["pts", "Rating"],
    ["real_pts", "Total Pts (real)"],
    ...(hasBudget ? ([["price", "Price"]] as [PoolSortBy, string][]) : []),
    ["owned", "% Owned"],
    ["goals", "Goals"],
    ["assists", "Assists"],
    ["bonus", "Bonus"],
  ];
}

export default function RatingsBrowseTable({
  gameSlug,
  gameweek,
  teams,
  hasClubPosition,
  hasBudget,
}: {
  gameSlug: string;
  gameweek: number;
  teams: string[];
  hasClubPosition: boolean;
  hasBudget: boolean;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [posFilter, setPosFilter] = useState<PosFilter>("ALL");
  const [teamFilter, setTeamFilter] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<PoolSortBy>("pts");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<PoolSearchRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [posFilter, teamFilter, sortBy, debouncedSearch]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    searchPool({
      gameSlug,
      gameweek,
      position: posFilter === "ALL" ? null : posFilter,
      teamName: teamFilter === "ALL" ? null : teamFilter,
      search: debouncedSearch,
      excludeIds: [],
      sortBy,
      // The "ALL" position view should default to the 4 player positions,
      // same as every other pool table in the app - CLUB is its own
      // explicit filter choice, not lumped in silently.
      excludeClub: posFilter === "ALL" && hasClubPosition,
      page,
      pageSize: PAGE_SIZE,
    }).then((result) => {
      if (cancelled) return;
      setRows(result.rows);
      setTotalCount(result.totalCount);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [gameSlug, gameweek, posFilter, teamFilter, sortBy, debouncedSearch, page, hasClubPosition]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const positions: PosFilter[] = hasClubPosition ? ["ALL", "GK", "DEF", "MID", "FWD", "CLUB"] : ["ALL", "GK", "DEF", "MID", "FWD"];

  return (
    <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-4">
      <h2 className="text-sm font-semibold text-white">Browse All Players</h2>
      <p className="mt-1 text-xs text-navy-400">Search and filter the full rated pool for this gameweek.</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {positions.map((pos) => (
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
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
        >
          <option value="ALL">All teams</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as PoolSortBy)}
          className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
        >
          {sortOptions(hasBudget).map(([value, label]) => (
            <option key={value} value={value}>
              Sort: {label}
            </option>
          ))}
        </select>
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search player..."
          className="ml-auto w-full max-w-[220px] rounded-lg border border-navy-700 bg-navy-950 px-3 py-1.5 text-xs text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
        />
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-navy-500">
              <th className="pb-2 pr-2 font-medium">Player</th>
              <th className="pb-2 pr-2 font-medium">Pos</th>
              <th className="pb-2 pr-2 font-medium">Rating</th>
              <th className="pb-2 pr-2 font-medium">Fixture</th>
              <th className="pb-2 pr-2 font-medium">Total Pts</th>
              {hasBudget && <th className="pb-2 pr-2 font-medium">Price</th>}
              <th className="pb-2 pr-2 font-medium">% Owned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const tier = ratingTier(r.hailMaryRating);
              const displayName = r.position === "CLUB" ? r.team_name : r.full_name;
              return (
                <tr key={r.game_player_id} className="border-t border-navy-800">
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-2">
                      <Kit teamName={r.team_name} size="sm" />
                      <span className="font-medium text-white">{displayName}</span>
                    </div>
                  </td>
                  <td className="py-2 pr-2 text-navy-400">{r.position}</td>
                  <td className="py-2 pr-2">
                    <span className="font-bold text-sky-300">{formatRating(r.hailMaryRating)}/10</span>
                    {tier && <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${tier.toneClass}`}>{tier.label}</span>}
                    {(() => {
                      const basisTag = ratingBasisTag(r.hailMaryRatingBasis);
                      return (
                        basisTag && (
                          <span
                            title={basisTag.title}
                            className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${basisTag.toneClass}`}
                          >
                            {basisTag.label}
                          </span>
                        )
                      );
                    })()}
                  </td>
                  <td className="py-2 pr-2 text-navy-400">{formatFixtureShort(r.opponentTeamName, r.fixtureIsHome, r.fixtureKickoffAt)}</td>
                  <td className="py-2 pr-2 text-navy-200">{r.realTotalPoints ?? "—"}</td>
                  {hasBudget && <td className="py-2 pr-2 text-navy-200">£{r.price.toFixed(1)}m</td>}
                  <td className="py-2 pr-2 text-navy-200">{r.ownershipPct != null ? `${r.ownershipPct.toFixed(1)}%` : "—"}</td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={hasBudget ? 7 : 6} className="py-6 text-center text-navy-500">
                  No players match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-navy-400">
        <span>
          {totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, totalCount)} of {totalCount}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-full px-2 py-1 font-medium text-navy-300 hover:bg-navy-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            ←
          </button>
          <span>
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="rounded-full px-2 py-1 font-medium text-navy-300 hover:bg-navy-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
}
