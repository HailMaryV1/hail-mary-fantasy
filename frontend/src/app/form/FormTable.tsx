"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { computeRecentForm, computeWindowedAverage } from "@/lib/hailMaryForm";
import { resolveFormBadge } from "@/lib/formStatus";

export type FormPlayerRow = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_name: string;
  price: number;
  // Completed gameweeks' points_difference, most recent first - the badge
  // always comes from the fixed 4-GW recency window (computeRecentForm);
  // the WINDOWS below just change which plain average is displayed/sorted.
  diffsMostRecentFirst: number[];
};

const WINDOWS = [
  { key: "latest", label: "Latest GW", window: 1 as const },
  { key: "l3", label: "Last 3", window: 3 as const },
  { key: "l5", label: "Last 5", window: 5 as const },
  { key: "season", label: "Season", window: "season" as const },
];

type SortKey = "average" | "price";

export default function FormTable({ data }: { data: FormPlayerRow[] }) {
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState("ALL");
  const [team, setTeam] = useState("ALL");
  const [windowKey, setWindowKey] = useState<(typeof WINDOWS)[number]["key"]>("l3");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("average");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const positions = useMemo(() => ["ALL", ...Array.from(new Set(data.map((r) => r.position))).sort()], [data]);
  const teams = useMemo(() => Array.from(new Set(data.map((r) => r.team_name))).sort(), [data]);
  const activeWindow = WINDOWS.find((w) => w.key === windowKey)!;

  const enriched = useMemo(
    () =>
      data.map((r) => {
        const recent = computeRecentForm(r.diffsMostRecentFirst.slice(0, 4));
        const windowed = computeWindowedAverage(r.diffsMostRecentFirst, activeWindow.window);
        return { ...r, status: recent.status, windowedAverage: windowed.average, windowedGamesUsed: windowed.gamesUsed };
      }),
    [data, activeWindow]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = minPrice.trim() ? Number(minPrice) : null;
    const max = maxPrice.trim() ? Number(maxPrice) : null;
    return enriched
      .filter((r) => position === "ALL" || r.position === position)
      .filter((r) => team === "ALL" || r.team_name === team)
      .filter((r) => !q || r.full_name.toLowerCase().includes(q))
      .filter((r) => min === null || r.price >= min)
      .filter((r) => max === null || r.price <= max)
      .sort((a, b) => {
        const av = sortKey === "average" ? (a.windowedAverage ?? -Infinity) : a.price;
        const bv = sortKey === "average" ? (b.windowedAverage ?? -Infinity) : b.price;
        return sortDir === "desc" ? bv - av : av - bv;
      });
  }, [enriched, search, position, team, minPrice, maxPrice, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortIndicator(key: SortKey) {
    if (key !== sortKey) return null;
    return <span className="ml-1 text-navy-400">{sortDir === "desc" ? "↓" : "↑"}</span>;
  }

  return (
    <div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search player..."
          className="rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white placeholder:text-navy-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
        />
        <div className="flex flex-wrap gap-2">
          <div className="flex gap-1 rounded-lg bg-navy-900 p-1">
            {positions.map((p) => (
              <button
                key={p}
                onClick={() => setPosition(p)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  position === p ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <select
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className="rounded-lg border border-navy-700 bg-navy-900 px-2 py-1 text-xs text-white focus:outline-none"
          >
            <option value="ALL">All teams</option>
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-navy-400">Window</span>
        <div className="flex gap-1 rounded-lg bg-navy-900 p-1">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWindowKey(w.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                windowKey === w.key ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <span className="text-xs font-medium uppercase tracking-wide text-navy-400">Price</span>
        <input
          type="number"
          inputMode="decimal"
          value={minPrice}
          onChange={(e) => setMinPrice(e.target.value)}
          placeholder="Min"
          className="w-16 rounded-lg border border-navy-700 bg-navy-900 px-2 py-1 text-xs text-white focus:outline-none"
        />
        <span className="text-navy-500">–</span>
        <input
          type="number"
          inputMode="decimal"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          placeholder="Max"
          className="w-16 rounded-lg border border-navy-700 bg-navy-900 px-2 py-1 text-xs text-white focus:outline-none"
        />
      </div>

      <p className="mt-3 text-xs text-navy-400">{filtered.length} player{filtered.length === 1 ? "" : "s"}</p>

      <div className="mt-2 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
              <th className="px-4 py-3 font-medium">Player</th>
              <th className="hidden px-4 py-3 font-medium sm:table-cell">Team</th>
              <th className="hidden px-4 py-3 font-medium sm:table-cell">Pos</th>
              <th
                className="hidden cursor-pointer select-none px-4 py-3 text-right font-medium hover:text-white sm:table-cell"
                onClick={() => toggleSort("price")}
              >
                Price{sortIndicator("price")}
              </th>
              <th
                className="cursor-pointer select-none px-4 py-3 text-right font-medium hover:text-white"
                onClick={() => toggleSort("average")}
              >
                {activeWindow.label} avg{sortIndicator("average")}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const badge = resolveFormBadge(row.status);
              return (
                <tr key={row.game_player_id} className="border-b border-navy-800 last:border-0 hover:bg-navy-800">
                  <td className="px-4 py-3 font-medium text-white">
                    <Link href={`/players/${row.game_player_id}`} className="block">
                      <span className="inline-flex items-center">
                        {row.full_name}
                        {badge && (
                          <span title={badge.label} className="ml-1.5 text-sm">
                            {badge.icon}
                          </span>
                        )}
                      </span>
                      <span className="block text-xs font-normal text-navy-400 sm:hidden">
                        {row.team_name} · {row.position}
                      </span>
                    </Link>
                  </td>
                  <td className="hidden px-4 py-3 text-navy-300 sm:table-cell">{row.team_name}</td>
                  <td className="hidden px-4 py-3 text-navy-300 sm:table-cell">{row.position}</td>
                  <td className="hidden px-4 py-3 text-right text-navy-300 sm:table-cell">£{row.price.toFixed(1)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-sky-400">
                    {row.windowedAverage !== null ? (
                      <>
                        {row.windowedAverage >= 0 ? "+" : ""}
                        {row.windowedAverage.toFixed(1)}
                        <span className="ml-1 text-[10px] font-normal text-navy-500">({row.windowedGamesUsed} GW{row.windowedGamesUsed === 1 ? "" : "s"})</span>
                      </>
                    ) : (
                      <span className="text-navy-500">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-navy-400">
                  No players match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
