"use client";

import { useEffect, useState } from "react";
import { searchTargetScorePool, type TargetScorePoolRow, type TargetScorePoolSortBy } from "@/lib/targetScoreActions";
import FixtureWindowPills from "@/components/FixtureWindowPills";
import Kit from "@/components/Kit";
import PlayerInfoPanel from "@/components/PlayerInfoPanel";

const PAGE_SIZE = 20;

type PosFilter = "ALL" | "GK" | "DEF" | "MID" | "FWD" | "CLUB";

const SORT_OPTIONS: [TargetScorePoolSortBy, string][] = [
  ["rating", "Rating"],
  ["owned", "% Owned"],
  ["price", "Price"],
  ["real_pts", "Total Pts (real)"],
];

// A small labeled number input - shared shape for every min/max range
// filter below (rating/owned/price). Empty string clears the filter
// (sent as null), not 0 - a real user could genuinely want "0% owned
// and up", so an unset filter must be distinguishable from a 0 value.
function RangeInput({
  label,
  value,
  onChange,
  min,
  max,
  width = "w-14",
}: {
  label: string;
  value: number | "";
  onChange: (v: number | "") => void;
  min?: number;
  max?: number;
  width?: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      placeholder={label}
      title={label}
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      className={`${width} rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40`}
    />
  );
}

function SubStat({ label, value }: { label: string; value: number | null }) {
  return (
    <span title={label} className={`inline-flex items-baseline gap-0.5 ${value == null ? "text-navy-700" : "text-navy-300"}`}>
      <span className="text-[9px] font-semibold uppercase text-navy-600">{label[0]}</span>
      <span className="text-[10px] font-bold">{value ?? "—"}</span>
    </span>
  );
}

export default function RatingsBrowseTable({
  gameSlug,
  gameweek,
  horizon,
  teams,
  hasClubPosition,
  hasBudget,
}: {
  gameSlug: string;
  gameweek: number;
  horizon: number;
  teams: string[];
  hasClubPosition: boolean;
  hasBudget: boolean;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [posFilter, setPosFilter] = useState<PosFilter>("ALL");
  const [teamFilter, setTeamFilter] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<TargetScorePoolSortBy>("rating");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<TargetScorePoolRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [infoPlayerId, setInfoPlayerId] = useState<number | null>(null);

  // "I should be able to check boxes that narrows the players down to
  // what im after... a 9 or 10 rated defender for the next 3 gameweeks
  // that is under 20% owned" + "add the price points too - so player at
  // under 3.5m etc" (2026-08-26 user request).
  const [minRating, setMinRating] = useState<number | "">("");
  const [maxRating, setMaxRating] = useState<number | "">("");
  const [minOwned, setMinOwned] = useState<number | "">("");
  const [maxOwned, setMaxOwned] = useState<number | "">("");
  const [minPrice, setMinPrice] = useState<number | "">("");
  const [maxPrice, setMaxPrice] = useState<number | "">("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [posFilter, teamFilter, sortBy, debouncedSearch, minRating, maxRating, minOwned, maxOwned, minPrice, maxPrice, gameweek, horizon]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    searchTargetScorePool({
      gameSlug,
      gameweek,
      horizon,
      position: posFilter === "ALL" ? null : posFilter,
      teamName: teamFilter === "ALL" ? null : teamFilter,
      search: debouncedSearch,
      minRating: minRating === "" ? null : minRating,
      maxRating: maxRating === "" ? null : maxRating,
      minOwned: minOwned === "" ? null : minOwned,
      maxOwned: maxOwned === "" ? null : maxOwned,
      minPrice: minPrice === "" ? null : minPrice,
      maxPrice: maxPrice === "" ? null : maxPrice,
      sortBy,
      // Same convention as the top boxes above - the "ALL" position view
      // defaults to the 4 player positions, CLUB is its own explicit
      // filter choice, not lumped in silently.
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
  }, [gameSlug, gameweek, horizon, posFilter, teamFilter, sortBy, debouncedSearch, minRating, maxRating, minOwned, maxOwned, minPrice, maxPrice, page, hasClubPosition]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const positions: PosFilter[] = hasClubPosition ? ["ALL", "GK", "DEF", "MID", "FWD", "CLUB"] : ["ALL", "GK", "DEF", "MID", "FWD"];

  if (infoPlayerId != null) {
    return (
      <div className="mt-8">
        <PlayerInfoPanel
          gameSlug={gameSlug}
          gamePlayerId={infoPlayerId}
          viewedGameweek={gameweek}
          horizon={horizon}
          onBack={() => setInfoPlayerId(null)}
        />
      </div>
    );
  }

  return (
    <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-4">
      <h2 className="text-sm font-semibold text-white">Browse All Players</h2>
      <p className="mt-1 text-xs text-navy-400">Search and filter the full rated pool for this horizon.</p>

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
          onChange={(e) => setSortBy(e.target.value as TargetScorePoolSortBy)}
          className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
        >
          {SORT_OPTIONS.map(([value, label]) => (
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

      <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-navy-800 pt-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-navy-500">Rating</span>
          <RangeInput label="Min" value={minRating} onChange={setMinRating} min={1} max={10} width="w-12" />
          <span className="text-navy-600">–</span>
          <RangeInput label="Max" value={maxRating} onChange={setMaxRating} min={1} max={10} width="w-12" />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-navy-500">% Owned</span>
          <RangeInput label="Min" value={minOwned} onChange={setMinOwned} min={0} max={100} />
          <span className="text-navy-600">–</span>
          <RangeInput label="Max" value={maxOwned} onChange={setMaxOwned} min={0} max={100} />
        </div>
        {hasBudget && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-navy-500">Price £m</span>
            <RangeInput label="Min" value={minPrice} onChange={setMinPrice} min={0} />
            <span className="text-navy-600">–</span>
            <RangeInput label="Max" value={maxPrice} onChange={setMaxPrice} min={0} />
          </div>
        )}
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-navy-500">
              <th className="pb-2 pr-2 font-medium">Player</th>
              <th className="pb-2 pr-2 font-medium">Pos</th>
              <th className="pb-2 pr-2 font-medium">Rating</th>
              <th className="pb-2 pr-2 font-medium">Fixture(s)</th>
              <th className="pb-2 pr-2 font-medium">Total Pts</th>
              {hasBudget && <th className="pb-2 pr-2 font-medium">Price</th>}
              <th className="pb-2 pr-2 font-medium">% Owned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const displayName = r.position === "CLUB" ? r.teamName : r.fullName;
              return (
                <tr key={r.gamePlayerId} className="border-t border-navy-800">
                  <td className="py-2 pr-2">
                    <button onClick={() => setInfoPlayerId(r.gamePlayerId)} className="flex items-center gap-2 text-left hover:opacity-80">
                      <Kit teamName={r.teamName} size="sm" />
                      <span className="font-medium text-white">{displayName}</span>
                    </button>
                  </td>
                  <td className="py-2 pr-2 text-navy-400">{r.position}</td>
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sky-300">{r.displayedRating ?? "—"}/10</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <SubStat label="Form" value={r.formRating} />
                      <SubStat label="Difficulty" value={r.fixtureDifficultyRating} />
                      <SubStat label="Quantity" value={r.fixtureQuantityRating} />
                      <SubStat label="Odds" value={r.liveOddsRating} />
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <FixtureWindowPills fixtures={r.windowFixtures} />
                  </td>
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
