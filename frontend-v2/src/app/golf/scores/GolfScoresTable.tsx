"use client";

import { useMemo, useState } from "react";

export type GolfScoreRow = {
  gamePlayerId: number;
  fullName: string;
  price: number | null;
  expectedPoints: number | null;
  expectedFloor: number | null;
  expectedCeiling: number | null;
  actualPoints: number | null;
  pointsDifference: number | null;
};

type SortKey = "fullName" | "price" | "expectedPoints" | "actualPoints" | "pointsDifference";

const ASCENDING_FIRST: Partial<Record<SortKey, boolean>> = { fullName: true };

const COLUMNS: { key: SortKey; label: string; align: "left" | "right"; hideOnMobile?: boolean }[] = [
  { key: "fullName", label: "Golfer", align: "left" },
  { key: "price", label: "Price", align: "right", hideOnMobile: true },
  { key: "expectedPoints", label: "Expected", align: "right" },
  { key: "actualPoints", label: "Actual", align: "right" },
  { key: "pointsDifference", label: "Diff", align: "right" },
];

// A golfer "called correctly" when the real result landed inside Hail
// Mary's own simulated floor-ceiling range (5th-95th percentile of the
// made/missed-cut-branched Monte Carlo, see compute_golf_projections.py's
// simulate()) - a bar that respects golf's genuinely bimodal outcomes,
// unlike a flat ±5pt window around one blended point estimate (the
// retired algorithm-performance page's definition, which fails almost
// every golfer by construction: made-cut golfers land ~20pts above their
// blended expectation, missed-cut golfers ~30pts below, see the
// 2026-08-06 investigation that replaced this metric).
function inRange(row: GolfScoreRow): boolean | null {
  if (row.actualPoints == null || row.expectedFloor == null || row.expectedCeiling == null) return null;
  return row.actualPoints >= row.expectedFloor && row.actualPoints <= row.expectedCeiling;
}

export default function GolfScoresTable({ data }: { data: GolfScoreRow[] }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("expectedPoints");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir(ASCENDING_FIRST[key] ? "asc" : "desc");
    }
  }

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

  // Graded-only stats - a golfer who hasn't posted a real score yet has
  // nothing to grade the model against, so pending rows are excluded
  // from these tiles the same way the retired algorithm-performance
  // page's whole query already did (.not("actual_points", "is", null)).
  const graded = useMemo(() => data.filter((r) => r.pointsDifference != null), [data]);
  const gradedCount = graded.length;
  const meanAbsoluteError = gradedCount > 0 ? graded.reduce((s, r) => s + Math.abs(r.pointsDifference!), 0) / gradedCount : null;
  const bias = gradedCount > 0 ? graded.reduce((s, r) => s + r.pointsDifference!, 0) / gradedCount : null;
  const overrated = graded.filter((r) => r.pointsDifference! < 0).length;
  const underrated = graded.filter((r) => r.pointsDifference! > 0).length;

  // "Called it" - actual landed inside the simulated floor-ceiling range,
  // not a flat ±Npt window - see inRange()'s docstring for why.
  const rangeGraded = useMemo(() => graded.filter((r) => inRange(r) != null), [graded]);
  const calledCount = rangeGraded.filter((r) => inRange(r) === true).length;
  const calledPct = rangeGraded.length > 0 ? (calledCount / rangeGraded.length) * 100 : null;

  return (
    <div>
      {gradedCount > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <p className="text-xs uppercase tracking-wide text-navy-400">Graded</p>
            <p className="mt-1 text-xl font-semibold text-white">
              {gradedCount}
              <span className="text-sm font-normal text-navy-400">/{data.length}</span>
            </p>
          </div>
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <p className="text-xs uppercase tracking-wide text-navy-400">Called it</p>
            <p className="mt-1 text-xl font-semibold text-emerald-400">{calledPct != null ? calledPct.toFixed(0) : "—"}%</p>
            <p className="mt-0.5 text-[11px] text-navy-500">actual within Mary&apos;s floor-ceiling</p>
          </div>
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <p className="text-xs uppercase tracking-wide text-navy-400">Mean error</p>
            <p className="mt-1 text-xl font-semibold text-white">{meanAbsoluteError?.toFixed(1)}</p>
          </div>
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <p className="text-xs uppercase tracking-wide text-navy-400">Bias</p>
            <p className={`mt-1 text-xl font-semibold ${bias != null && bias >= 0 ? "text-emerald-400" : "text-amber-400"}`}>
              {bias != null && bias >= 0 ? "+" : ""}
              {bias?.toFixed(1)}
            </p>
            <p className="mt-0.5 text-[11px] text-navy-500">{overrated} over / {underrated} under</p>
          </div>
        </div>
      )}

      <div className="mt-6">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search golfer..."
          className="w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white placeholder:text-navy-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40 sm:w-64"
        />
      </div>

      <p className="mt-3 text-xs text-navy-400">{filtered.length} golfer{filtered.length === 1 ? "" : "s"}</p>

      <div className="mt-2 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
              {COLUMNS.slice(0, 3).map((col) => (
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
              <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">Range</th>
              {COLUMNS.slice(3).map((col) => (
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
              const called = inRange(row);
              return (
                <tr key={row.gamePlayerId} className="border-b border-navy-800 last:border-0 hover:bg-navy-800/60">
                  <td className="px-4 py-3 font-medium text-white">
                    {row.fullName}
                    <span className="block text-xs font-normal text-navy-400 sm:hidden">
                      {row.price != null ? `£${row.price.toFixed(1)}m` : "—"}
                    </span>
                  </td>
                  <td className="hidden px-4 py-3 text-right text-navy-300 sm:table-cell">
                    {row.price != null ? `£${row.price.toFixed(1)}m` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-navy-300">
                    {row.expectedPoints != null ? row.expectedPoints.toFixed(1) : "—"}
                  </td>
                  <td className="hidden px-4 py-3 text-right text-xs text-navy-400 sm:table-cell">
                    {row.expectedFloor != null && row.expectedCeiling != null
                      ? `${row.expectedFloor.toFixed(0)}–${row.expectedCeiling.toFixed(0)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-white">
                    {row.actualPoints != null ? row.actualPoints.toFixed(1) : <span className="font-normal text-navy-500">Pending</span>}
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-semibold ${
                      row.pointsDifference == null ? "text-navy-600" : row.pointsDifference >= 0 ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {row.pointsDifference != null ? `${row.pointsDifference >= 0 ? "+" : ""}${row.pointsDifference.toFixed(1)}` : "—"}
                    {called != null && (
                      <span className={`block text-[10px] font-normal ${called ? "text-emerald-500/70" : "text-navy-500"}`}>
                        {called ? "in range" : "outside range"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="px-4 py-8 text-center text-navy-400">
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
