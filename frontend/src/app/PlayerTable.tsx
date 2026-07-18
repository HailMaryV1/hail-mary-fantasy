"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export type ProjectionRow = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_name: string;
  price: number;
  hail_mary_score: number;
  points_per_90: number;
};

type SortKey = "hail_mary_score" | "price" | "points_per_90";

const POSITIONS = ["ALL", "GK", "DEF", "MID", "FWD"] as const;

export default function PlayerTable({ data, horizon }: { data: ProjectionRow[]; horizon: string }) {
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<(typeof POSITIONS)[number]>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("hail_mary_score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const teams = useMemo(
    () => Array.from(new Set(data.map((r) => r.team_name))).sort(),
    [data]
  );
  const [team, setTeam] = useState("ALL");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data
      .filter((r) => position === "ALL" || r.position === position)
      .filter((r) => team === "ALL" || r.team_name === team)
      .filter((r) => !q || r.full_name.toLowerCase().includes(q))
      .sort((a, b) => (sortDir === "desc" ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));
  }, [data, search, position, team, sortKey, sortDir]);

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
    return <span className="ml-1 text-zinc-400">{sortDir === "desc" ? "↓" : "↑"}</span>;
  }

  return (
    <div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search player..."
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-black placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-black/10 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-white/20"
        />
        <div className="flex flex-wrap gap-2">
          <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
            {POSITIONS.map((p) => (
              <button
                key={p}
                onClick={() => setPosition(p)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  position === p
                    ? "bg-white text-black shadow-sm dark:bg-zinc-700 dark:text-white"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <select
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs text-black focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50"
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

      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
        {filtered.length} player{filtered.length === 1 ? "" : "s"}
      </p>

      <div className="mt-2 overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
              <th className="px-4 py-3 font-medium">Player</th>
              <th className="hidden px-4 py-3 font-medium sm:table-cell">Team</th>
              <th className="hidden px-4 py-3 font-medium sm:table-cell">Pos</th>
              <th
                className="hidden cursor-pointer select-none px-4 py-3 text-right font-medium hover:text-zinc-800 dark:hover:text-zinc-200 sm:table-cell"
                onClick={() => toggleSort("price")}
              >
                Price{sortIndicator("price")}
              </th>
              <th
                className="hidden cursor-pointer select-none px-4 py-3 text-right font-medium hover:text-zinc-800 dark:hover:text-zinc-200 sm:table-cell"
                onClick={() => toggleSort("points_per_90")}
              >
                Pts/90{sortIndicator("points_per_90")}
              </th>
              <th
                className="cursor-pointer select-none px-4 py-3 text-right font-medium hover:text-zinc-800 dark:hover:text-zinc-200"
                onClick={() => toggleSort("hail_mary_score")}
              >
                Hail Mary Score{sortIndicator("hail_mary_score")}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr
                key={row.game_player_id}
                className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900"
              >
                <td className="px-4 py-3 font-medium text-black dark:text-zinc-50">
                  <Link href={`/players/${row.game_player_id}?horizon=${horizon}`} className="block">
                    {row.full_name}
                    <span className="block text-xs font-normal text-zinc-500 sm:hidden">
                      {row.team_name} · {row.position}
                    </span>
                  </Link>
                </td>
                <td className="hidden px-4 py-3 text-zinc-600 dark:text-zinc-400 sm:table-cell">
                  {row.team_name}
                </td>
                <td className="hidden px-4 py-3 text-zinc-600 dark:text-zinc-400 sm:table-cell">
                  {row.position}
                </td>
                <td className="hidden px-4 py-3 text-right text-zinc-600 dark:text-zinc-400 sm:table-cell">
                  {Number(row.price).toFixed(1)}
                </td>
                <td className="hidden px-4 py-3 text-right text-zinc-600 dark:text-zinc-400 sm:table-cell">
                  {Number(row.points_per_90).toFixed(1)}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-black dark:text-zinc-50">
                  {Number(row.hail_mary_score).toFixed(1)}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
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
