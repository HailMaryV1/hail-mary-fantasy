"use client";

import { Fragment, useMemo, useState } from "react";

export type GolfRankingRow = {
  gamePlayerId: number;
  fullName: string;
  price: number;
  lineup: string | null;
  status: string | null;
  expectedPoints: number | null;
  floor: number | null;
  ceiling: number | null;
  makeCutProbability: number | null;
  value: number | null;
  explanation: string | null;
};

const PERSPECTIVES = [
  { key: "expectedPoints", label: "Overall" },
  { key: "value", label: "Best Value" },
  { key: "floor", label: "Safest" },
  { key: "ceiling", label: "Highest Ceiling" },
] as const;

type PerspectiveKey = (typeof PERSPECTIVES)[number]["key"];

export default function GolfRankingsTable({ data }: { data: GolfRankingRow[] }) {
  const [search, setSearch] = useState("");
  const [perspective, setPerspective] = useState<PerspectiveKey>("expectedPoints");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data
      .filter((r) => !q || r.fullName.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (b[perspective] ?? -Infinity) - (a[perspective] ?? -Infinity));
  }, [data, search, perspective]);

  return (
    <div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search golfer..."
          className="rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white placeholder:text-navy-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
        />
        <div className="flex gap-1 rounded-lg bg-navy-900 p-1">
          {PERSPECTIVES.map((p) => (
            <button
              key={p.key}
              onClick={() => setPerspective(p.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                perspective === p.key ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-3 text-xs text-navy-400">{filtered.length} golfer{filtered.length === 1 ? "" : "s"}</p>

      <div className="mt-2 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
              <th className="px-4 py-3 font-medium">Golfer</th>
              <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">Price</th>
              <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">Floor</th>
              <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">Ceiling</th>
              <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">Cut %</th>
              <th className="px-4 py-3 text-right font-medium">Expected</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const withdrawn = row.lineup === "refuted" || row.status === "not_play";
              return (
                <Fragment key={row.gamePlayerId}>
                  <tr
                    onClick={() => setExpandedId(expandedId === row.gamePlayerId ? null : row.gamePlayerId)}
                    className="cursor-pointer border-b border-navy-800 last:border-0 hover:bg-navy-800"
                  >
                    <td className="px-4 py-3 font-medium text-white">
                      {row.fullName}
                      {withdrawn && (
                        <span
                          title="Withdrawn / not playing"
                          className="ml-1.5 inline-block shrink-0 rounded bg-red-950 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-red-400"
                        >
                          WD
                        </span>
                      )}
                      <span className="block text-xs font-normal text-navy-400 sm:hidden">£{row.price.toFixed(1)}m</span>
                    </td>
                    <td className="hidden px-4 py-3 text-right text-navy-300 sm:table-cell">£{row.price.toFixed(1)}m</td>
                    <td className="hidden px-4 py-3 text-right text-navy-300 sm:table-cell">
                      {row.floor != null ? row.floor.toFixed(1) : "—"}
                    </td>
                    <td className="hidden px-4 py-3 text-right text-navy-300 sm:table-cell">
                      {row.ceiling != null ? row.ceiling.toFixed(1) : "—"}
                    </td>
                    <td className="hidden px-4 py-3 text-right text-navy-300 sm:table-cell">
                      {row.makeCutProbability != null ? `${(row.makeCutProbability * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-sky-400">
                      {row.expectedPoints != null ? row.expectedPoints.toFixed(1) : "—"}
                    </td>
                  </tr>
                  {expandedId === row.gamePlayerId && row.explanation && (
                    <tr className="border-b border-navy-800 bg-navy-950/60 last:border-0">
                      <td colSpan={6} className="px-4 py-2 text-xs text-navy-400">
                        {row.explanation}
                        {row.value != null && <span className="ml-3 text-navy-500">Value: {row.value.toFixed(2)} pts/£</span>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-navy-400">
                  No golfers match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
