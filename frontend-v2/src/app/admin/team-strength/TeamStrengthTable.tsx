"use client";

import { useState, useTransition } from "react";
import { saveTeamStrengthOverride, type TeamStrengthRow } from "@/lib/teamStrengthAdmin";

function formatRating(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function RowStatus({ status }: { status: "idle" | "saving" | "saved" | "error"; message?: string }) {
  if (status === "saving") return <span className="text-xs text-navy-400">Saving…</span>;
  if (status === "saved") return <span className="text-xs text-emerald-400">Saved - recompute triggered, allow a few minutes</span>;
  return null;
}

export default function TeamStrengthTable({ initialRows }: { initialRows: TeamStrengthRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [drafts, setDrafts] = useState<Record<number, string>>(
    Object.fromEntries(initialRows.map((r) => [r.teamId, r.overrideRating != null ? formatRating(r.overrideRating) : ""]))
  );
  const [statuses, setStatuses] = useState<Record<number, { state: "idle" | "saving" | "saved" | "error"; message?: string }>>({});
  const [isPending, startTransition] = useTransition();

  function handleSave(teamId: number) {
    const raw = drafts[teamId]?.trim() ?? "";
    const rating = raw === "" ? null : Number(raw);
    if (rating !== null && (!Number.isFinite(rating) || rating < 1 || rating > 5)) {
      setStatuses((s) => ({ ...s, [teamId]: { state: "error", message: "Enter a rating between 1 and 5, or leave blank." } }));
      return;
    }
    setStatuses((s) => ({ ...s, [teamId]: { state: "saving" } }));
    startTransition(async () => {
      const result = await saveTeamStrengthOverride(teamId, rating);
      if (!result.saved) {
        setStatuses((s) => ({ ...s, [teamId]: { state: "error", message: result.error } }));
        return;
      }
      setRows((prev) => prev.map((r) => (r.teamId === teamId ? { ...r, overrideRating: rating } : r)));
      setStatuses((s) => ({ ...s, [teamId]: { state: result.error ? "error" : "saved", message: result.error } }));
    });
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-navy-800">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-navy-800 bg-navy-900/60 text-left text-xs uppercase tracking-wide text-navy-400">
            <th className="px-4 py-3 font-medium">Team</th>
            <th className="px-4 py-3 font-medium">Baseline (H / A)</th>
            <th className="px-4 py-3 font-medium">Override (1-5)</th>
            <th className="px-4 py-3 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = statuses[row.teamId]?.state ?? "idle";
            const message = statuses[row.teamId]?.message;
            const inEffect = row.overrideRating != null;
            return (
              <tr key={row.teamId} className="border-b border-navy-800/60 last:border-0">
                <td className="px-4 py-3 text-white">
                  {row.teamName}
                  {inEffect && <span className="ml-2 rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-400">Override active</span>}
                </td>
                <td className="px-4 py-3 text-navy-300">
                  {formatRating(row.baselineHomeRating)} / {formatRating(row.baselineAwayRating)}
                </td>
                <td className="px-4 py-3">
                  <input
                    type="number"
                    min={1}
                    max={5}
                    step={0.5}
                    placeholder="Baseline"
                    value={drafts[row.teamId] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [row.teamId]: e.target.value }))}
                    className="w-24 rounded border border-navy-700 bg-navy-900 px-2 py-1 text-white placeholder:text-navy-600 focus:border-sky-500 focus:outline-none"
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={isPending && status === "saving"}
                      onClick={() => handleSave(row.teamId)}
                      className="rounded bg-sky-500 px-3 py-1.5 text-xs font-medium text-navy-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Save
                    </button>
                    <RowStatus status={status} message={message} />
                    {status === "error" && message && <span className="text-xs text-rose-400">{message}</span>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
