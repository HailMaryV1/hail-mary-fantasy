"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { addToWatchlist, removeFromWatchlist } from "@/app/watchlist/actions";

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
  // How far this golfer's pasted top20 market odds sit above what their
  // price alone predicts (see golfValuePicks.ts) - null when there's no
  // odds for them or the gap doesn't clear VALUE_GAP_THRESHOLD.
  valueGapPercent: number | null;
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
  gameId,
  watched,
  isLoggedIn,
}: {
  data: GolfRankingRow[];
  gameId: number;
  watched: { gamePlayerId: number; entryId: number }[];
  isLoggedIn: boolean;
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("expectedPoints");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // gamePlayerId -> watchlist_entries.id (or null while an add is in
  // flight, so the button can't be double-clicked into two rows).
  const [watchMap, setWatchMap] = useState<Map<number, number>>(
    () => new Map(watched.map((w) => [w.gamePlayerId, w.entryId]))
  );
  const [pendingWatchId, setPendingWatchId] = useState<number | null>(null);
  const [, startWatchTransition] = useTransition();

  function toggleWatch(gamePlayerId: number) {
    if (!isLoggedIn || pendingWatchId === gamePlayerId) return;
    setPendingWatchId(gamePlayerId);
    const entryId = watchMap.get(gamePlayerId);
    startWatchTransition(async () => {
      if (entryId) {
        const result = await removeFromWatchlist({ id: entryId });
        if (!result?.error) {
          setWatchMap((prev) => {
            const next = new Map(prev);
            next.delete(gamePlayerId);
            return next;
          });
        }
      } else {
        const result = await addToWatchlist({ gameId, gamePlayerId, reasons: [] });
        if (!result?.error && result?.id) {
          setWatchMap((prev) => new Map(prev).set(gamePlayerId, result.id!));
        }
      }
      setPendingWatchId(null);
    });
  }

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
              const isWatched = watchMap.has(row.gamePlayerId);
              return (
                <Fragment key={row.gamePlayerId}>
                  <tr
                    onClick={() => setExpandedId(expandedId === row.gamePlayerId ? null : row.gamePlayerId)}
                    className="cursor-pointer border-b border-navy-800 last:border-0 hover:bg-navy-800"
                  >
                    <td className="px-4 py-3 font-medium text-white">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleWatch(row.gamePlayerId);
                        }}
                        disabled={!isLoggedIn || pendingWatchId === row.gamePlayerId}
                        title={
                          !isLoggedIn ? "Sign in to use the watchlist" : isWatched ? "Remove from watchlist" : "Add to watchlist"
                        }
                        className={`mr-1.5 disabled:cursor-not-allowed disabled:opacity-40 ${
                          isWatched ? "text-amber-400" : "text-navy-600 hover:text-amber-400"
                        }`}
                      >
                        {isWatched ? "★" : "☆"}
                      </button>
                      {row.fullName}
                      {withdrawn && (
                        <span
                          title="Withdrawn / not playing"
                          className="ml-1.5 inline-block shrink-0 rounded bg-red-950 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-red-400"
                        >
                          WD
                        </span>
                      )}
                      {row.valueGapPercent != null && (
                        <span
                          title={`Top20 market odds imply +${(row.valueGapPercent * 100).toFixed(1)}pts more chance than this golfer's price alone predicts`}
                          className="ml-1.5 inline-block shrink-0 animate-pulse rounded bg-amber-400 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-navy-950"
                        >
                          Value
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
                        {row.valueGapPercent != null && (
                          <span className="ml-3 font-semibold text-amber-400">
                            Market fancies +{(row.valueGapPercent * 100).toFixed(1)}pts top20 chance vs price
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
