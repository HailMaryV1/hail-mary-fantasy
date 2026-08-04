"use client";

import { Fragment, useMemo, useState } from "react";
import { classifyMarketGap, type MarketGapInfo } from "@/lib/golfValuePicks";

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
  // Bookies-vs-price-predicted top20 info (see golfValuePicks.ts) - null
  // when there's no odds for them. Badge classification (VALUE/DANGER/
  // neither) happens via classifyMarketGap().
  marketGap: MarketGapInfo | null;
};

const PERSPECTIVES = [
  { key: "expectedPoints", label: "Overall" },
  { key: "value", label: "Best Value" },
  { key: "floor", label: "Safest" },
  { key: "ceiling", label: "Highest Ceiling" },
] as const;

type SortKey = "fullName" | "price" | "floor" | "ceiling" | "makeCutProbability" | "value" | "expectedPoints";

// Columns sort highest-first by default (rankings convention) except
// the name column, where Z-A on first click would be surprising.
const ASCENDING_FIRST: Partial<Record<SortKey, boolean>> = { fullName: true };

const COLUMNS: { key: SortKey; label: string; align: "left" | "right"; hideOnMobile?: boolean }[] = [
  { key: "fullName", label: "Golfer", align: "left" },
  { key: "price", label: "Price", align: "right", hideOnMobile: true },
  { key: "floor", label: "Floor", align: "right", hideOnMobile: true },
  { key: "ceiling", label: "Ceiling", align: "right", hideOnMobile: true },
  { key: "makeCutProbability", label: "Cut %", align: "right", hideOnMobile: true },
  { key: "value", label: "Value", align: "right", hideOnMobile: true },
  { key: "expectedPoints", label: "Expected", align: "right" },
];

export default function GolfRankingsTable({
  data,
}: {
  data: GolfRankingRow[];
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("expectedPoints");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir(ASCENDING_FIRST[key] ? "asc" : "desc");
    }
  }

  const activePerspective = sortDir === "desc" ? PERSPECTIVES.find((p) => p.key === sortKey)?.key : undefined;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const dir = sortDir === "desc" ? -1 : 1;
    return data
      .filter((r) => !q || r.fullName.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (typeof av === "string" || typeof bv === "string") {
          return dir * String(av ?? "").localeCompare(String(bv ?? ""));
        }
        const aNum = av ?? -Infinity;
        const bNum = bv ?? -Infinity;
        return dir * ((aNum as number) - (bNum as number));
      });
  }, [data, search, sortKey, sortDir]);

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
              onClick={() => {
                setSortKey(p.key);
                setSortDir("desc");
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                activePerspective === p.key ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
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
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  className={`cursor-pointer select-none px-4 py-3 font-medium hover:text-white ${
                    col.align === "right" ? "text-right" : "text-left"
                  } ${col.hideOnMobile ? "hidden sm:table-cell" : ""}`}
                >
                  {col.label}
                  {sortKey === col.key && <span className="ml-1 text-sky-400">{sortDir === "desc" ? "↓" : "↑"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const withdrawn = row.lineup === "refuted" || row.status === "not_play";
              const marketGapFlag = classifyMarketGap(row.price, row.marketGap);
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
                      {marketGapFlag === "value" && (
                        <span
                          title={`The bookies market says ${row.fullName} is ${(row.marketGap!.marketProbability * 100).toFixed(0)}% likely to finish top 20 - FanTeam's price only suggests ${(row.marketGap!.predictedProbability * 100).toFixed(0)}%.`}
                          className="ml-1.5 inline-block shrink-0 animate-pulse rounded bg-amber-400 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-navy-950"
                        >
                          Value
                        </span>
                      )}
                      {marketGapFlag === "danger" && (
                        <span
                          title={`FanTeam's £${row.price.toFixed(1)}m price suggests a ${(row.marketGap!.predictedProbability * 100).toFixed(0)}% chance of a top 20 - the bookies market only gives ${row.fullName} ${(row.marketGap!.marketProbability * 100).toFixed(0)}%.`}
                          className="ml-1.5 inline-block shrink-0 animate-pulse rounded bg-red-600 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white"
                        >
                          ⚠ Overpriced
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
                    <td className="hidden px-4 py-3 text-right text-navy-300 sm:table-cell">
                      {row.value != null ? row.value.toFixed(2) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-sky-400">
                      {row.expectedPoints != null ? row.expectedPoints.toFixed(1) : "—"}
                    </td>
                  </tr>
                  {expandedId === row.gamePlayerId && row.explanation && (
                    <tr className="border-b border-navy-800 bg-navy-950/60 last:border-0">
                      <td colSpan={COLUMNS.length} className="px-4 py-2 text-xs text-navy-400">
                        {row.explanation}
                        {row.value != null && <span className="ml-3 text-navy-500">Value: {row.value.toFixed(2)} pts/£</span>}
                        {marketGapFlag === "value" && (
                          <span className="ml-3 font-semibold text-amber-400">
                            The bookies market says he&apos;s {(row.marketGap!.marketProbability * 100).toFixed(0)}% likely to finish top 20 - FanTeam&apos;s price only suggests {(row.marketGap!.predictedProbability * 100).toFixed(0)}%.
                          </span>
                        )}
                        {marketGapFlag === "danger" && (
                          <span className="ml-3 font-semibold text-red-400">
                            FanTeam&apos;s price suggests a {(row.marketGap!.predictedProbability * 100).toFixed(0)}% chance of a top 20 - the bookies market only gives him {(row.marketGap!.marketProbability * 100).toFixed(0)}%.
                          </span>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-4 py-8 text-center text-navy-400">
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
