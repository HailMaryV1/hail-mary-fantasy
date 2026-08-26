"use client";

import { useEffect, useState } from "react";
import { searchTargetScorePool, type TargetScorePoolRow, type TargetScorePoolSortBy } from "@/lib/targetScoreActions";
import { type HorizonSelection } from "@/lib/horizonSelection";
import FixtureWindowPills from "@/components/FixtureWindowPills";
import HorizonSelector from "@/components/HorizonSelector";
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

// Real user request 2026-08-26: "make the options preset drop downs
// like every 0.5m and under for price. 5 and above, 6 and above etc for
// rating... Percentage owned 5% and below / 10 Percent and below then
// 15 / 25 and 40%" - replaces the earlier free-text min/max number
// inputs with fixed preset ladders, one direction each (rating floors,
// price/ownership ceilings), matching exactly what was asked for rather
// than keeping a more general but fiddlier min+max pair.
const RATING_PRESETS = [5, 6, 7, 8, 9, 10];
const OWNED_PRESETS = [5, 10, 15, 25, 40];
// £3.0m-£15.0m covers every real budget game's own price range
// (Dream Team ~£2-13m, Cloud FF/FanTeam ~£3-14m) - generated, not hand-
// typed, so the 0.5m step the user asked for stays exact.
const PRICE_PRESETS = Array.from({ length: 25 }, (_, i) => Math.round((3.0 + i * 0.5) * 10) / 10);

type FilterState = {
  posFilter: PosFilter;
  teamFilter: string;
  sortBy: TargetScorePoolSortBy;
  minRating: number | "";
  maxOwned: number | "";
  maxPrice: number | "";
};

const DEFAULT_FILTERS: FilterState = { posFilter: "ALL", teamFilter: "ALL", sortBy: "rating", minRating: "", maxOwned: "", maxPrice: "" };

function storageKey(gameSlug: string) {
  return `ratingsBrowseFilters:${gameSlug}`;
}

// "when i click on a player and then go back.... all my filters have
// gone and reset. they should hold" (2026-08-26 user request) - a
// player click swaps this component's own JSX to PlayerInfoPanel and
// back, which alone doesn't touch React state, but a real browser-back
// or a horizon/gameweek change elsewhere on the page remounts this
// component fresh. Persisting to sessionStorage (keyed by game only,
// not gameweek/horizon - a "9+ rated, under 20% owned" preference is
// about the KIND of player, not the time window, so it should survive
// switching horizons) makes the filters survive any of those, not just
// the specific click-through case reported.
function loadFilters(gameSlug: string): FilterState {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  try {
    const raw = window.sessionStorage.getItem(storageKey(gameSlug));
    if (!raw) return DEFAULT_FILTERS;
    return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

// Every preset ladder here is numeric - the DOM always hands back a
// STRING from <select>'s onChange regardless of the option value's own
// type, so this converts back to a real number rather than leaving a
// "9" string masquerading as 9 (would silently break === comparisons
// against RATING_PRESETS/etc and the numeric RPC params downstream).
function PresetSelect({
  label,
  value,
  options,
  format,
  onChange,
}: {
  label: string;
  value: number | "";
  options: number[];
  format: (v: number) => string;
  onChange: (v: number | "") => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
    >
      <option value="">{label}: Any</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {format(o)}
        </option>
      ))}
    </select>
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
  viewedGameweek,
  horizonSelection,
  teams,
  hasClubPosition,
  hasBudget,
}: {
  gameSlug: string;
  gameweek: number;
  horizon: number;
  // Real gameweek switcher / raw horizon selection ("live" included) -
  // only needed to render the embedded HorizonSelector below with the
  // exact same URL shape the one at the top of the page uses.
  viewedGameweek: number;
  horizonSelection: HorizonSelection;
  teams: string[];
  hasClubPosition: boolean;
  hasBudget: boolean;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [filtersLoaded, setFiltersLoaded] = useState(false);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<TargetScorePoolRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [infoPlayerId, setInfoPlayerId] = useState<number | null>(null);

  const { posFilter, teamFilter, sortBy, minRating, maxOwned, maxPrice } = filters;
  const setField = <K extends keyof FilterState>(key: K, value: FilterState[K]) => setFilters((f) => ({ ...f, [key]: value }));

  // Load persisted filters once per game (not on every render) - a
  // lazy-mount effect rather than a useState initializer since
  // sessionStorage isn't available during SSR.
  useEffect(() => {
    setFilters(loadFilters(gameSlug));
    setFiltersLoaded(true);
  }, [gameSlug]);

  useEffect(() => {
    if (!filtersLoaded || typeof window === "undefined") return;
    window.sessionStorage.setItem(storageKey(gameSlug), JSON.stringify(filters));
  }, [gameSlug, filters, filtersLoaded]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [posFilter, teamFilter, sortBy, debouncedSearch, minRating, maxOwned, maxPrice, gameweek, horizon]);

  useEffect(() => {
    if (!filtersLoaded) return;
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
      maxOwned: maxOwned === "" ? null : maxOwned,
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
  }, [filtersLoaded, gameSlug, gameweek, horizon, posFilter, teamFilter, sortBy, debouncedSearch, minRating, maxOwned, maxPrice, page, hasClubPosition]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const positions: PosFilter[] = hasClubPosition ? ["ALL", "GK", "DEF", "MID", "FWD", "CLUB"] : ["ALL", "GK", "DEF", "MID", "FWD"];
  const filtersActive = posFilter !== "ALL" || teamFilter !== "ALL" || minRating !== "" || maxOwned !== "" || maxPrice !== "" || searchInput !== "";

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

      {/* "Allow me to switch gameweek option on there too rather than
          have to scroll to the top" (2026-08-26 user request) -
          scroll={false} is what actually satisfies "without scrolling",
          see HorizonSelector's own docstring. */}
      <div className="mt-3">
        <HorizonSelector activeSlug={gameSlug} viewedGameweek={viewedGameweek} horizonSelection={horizonSelection} scroll={false} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {positions.map((pos) => (
            <button
              key={pos}
              onClick={() => setField("posFilter", pos)}
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
          onChange={(e) => setField("teamFilter", e.target.value)}
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
          onChange={(e) => setField("sortBy", e.target.value as TargetScorePoolSortBy)}
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

      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-navy-800 pt-2">
        <PresetSelect label="Rating" value={minRating} options={RATING_PRESETS} format={(n) => `${n}+ rated`} onChange={(v) => setField("minRating", v)} />
        <PresetSelect
          label="% Owned"
          value={maxOwned}
          options={OWNED_PRESETS}
          format={(n) => `${n}% owned and below`}
          onChange={(v) => setField("maxOwned", v)}
        />
        {hasBudget && (
          <PresetSelect
            label="Price"
            value={maxPrice}
            options={PRICE_PRESETS}
            format={(n) => `£${n.toFixed(1)}m and under`}
            onChange={(v) => setField("maxPrice", v)}
          />
        )}
        {filtersActive && (
          <button
            onClick={() => {
              setFilters(DEFAULT_FILTERS);
              setSearchInput("");
            }}
            className="rounded-full border border-navy-700 px-3 py-1.5 text-xs font-medium text-navy-400 hover:border-navy-500 hover:text-white"
          >
            Reset filters
          </button>
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
