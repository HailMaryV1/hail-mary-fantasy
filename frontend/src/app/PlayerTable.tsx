"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import StatusPill from "./StatusPill";

export type ProjectionRow = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_name: string;
  price: number;
  hail_mary_score: number;
  points_per_90: number;
  lineup?: string | null;
  status?: string | null;
};

type SortKey = "hail_mary_score" | "price" | "points_per_90";

const POSITIONS = ["ALL", "GK", "DEF", "MID", "FWD"] as const;
const MAX_COMPARE = 3;

export default function PlayerTable({ data, horizon }: { data: ProjectionRow[]; horizon: string }) {
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<(typeof POSITIONS)[number]>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("hail_mary_score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [compareIds, setCompareIds] = useState<number[]>([]);

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
    return <span className="ml-1 text-navy-400">{sortDir === "desc" ? "↓" : "↑"}</span>;
  }

  function toggleCompare(id: number) {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, id];
    });
  }

  return (
    <div className={compareIds.length >= 2 ? "pb-16" : undefined}>
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
            {POSITIONS.map((p) => (
              <button
                key={p}
                onClick={() => setPosition(p)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  position === p
                    ? "bg-sky-500 text-navy-950"
                    : "text-navy-300 hover:text-white"
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

      <p className="mt-3 text-xs text-navy-400">
        {filtered.length} player{filtered.length === 1 ? "" : "s"}
        {compareIds.length > 0 && ` · ${compareIds.length}/${MAX_COMPARE} selected to compare`}
      </p>

      <div className="mt-2 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
              <th className="w-8 px-4 py-3 font-medium"></th>
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
                className="hidden cursor-pointer select-none px-4 py-3 text-right font-medium hover:text-white sm:table-cell"
                onClick={() => toggleSort("points_per_90")}
              >
                Pts/90{sortIndicator("points_per_90")}
              </th>
              <th
                className="cursor-pointer select-none px-4 py-3 text-right font-medium hover:text-white"
                onClick={() => toggleSort("hail_mary_score")}
              >
                Hail Mary Score{sortIndicator("hail_mary_score")}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const checked = compareIds.includes(row.game_player_id);
              const disabled = !checked && compareIds.length >= MAX_COMPARE;
              return (
                <tr
                  key={row.game_player_id}
                  className="border-b border-navy-800 last:border-0 hover:bg-navy-800"
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleCompare(row.game_player_id)}
                      className="accent-sky-500 disabled:opacity-30"
                      title={disabled ? `Compare up to ${MAX_COMPARE} players` : "Add to comparison"}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-white">
                    <Link href={`/players/${row.game_player_id}?horizon=${horizon}`} className="block">
                      <span className="inline-flex items-center">
                        {row.full_name}
                        <StatusPill lineup={row.lineup} status={row.status} />
                      </span>
                      <span className="block text-xs font-normal text-navy-400 sm:hidden">
                        {row.team_name} · {row.position}
                      </span>
                    </Link>
                  </td>
                  <td className="hidden px-4 py-3 text-navy-300 sm:table-cell">
                    {row.team_name}
                  </td>
                  <td className="hidden px-4 py-3 text-navy-300 sm:table-cell">
                    {row.position}
                  </td>
                  <td className="hidden px-4 py-3 text-right text-navy-300 sm:table-cell">
                    {Number(row.price).toFixed(1)}
                  </td>
                  <td className="hidden px-4 py-3 text-right text-navy-300 sm:table-cell">
                    {Number(row.points_per_90).toFixed(1)}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-sky-400">
                    {Number(row.hail_mary_score).toFixed(1)}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-navy-400">
                  No players match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {compareIds.length >= 2 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-navy-700 bg-navy-900/95 px-6 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center justify-between">
            <span className="text-sm text-navy-300">
              {compareIds.length} player{compareIds.length === 1 ? "" : "s"} selected
            </span>
            <Link
              href={`/compare?ids=${compareIds.join(",")}&horizon=${horizon}`}
              className="rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-navy-950 hover:bg-sky-400"
            >
              Compare ({compareIds.length}) →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
