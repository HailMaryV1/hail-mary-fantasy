"use client";

import { useMemo, useState, useTransition } from "react";
import { saveAllTeamStrengthOverrides, saveTeamStrengthOverride, type TeamStrengthRow } from "@/lib/teamStrengthAdmin";

// Same red/green visual language fixtureDifficultyColor.ts already uses
// for fixture-difficulty pills elsewhere in the app (red = tough
// opponent, green = easy) - a team's OWN strength rating drives that
// same "how tough an opponent is this" read, so 4-5 (a strong team, a
// tough away day for anyone) gets the same red, 1-2 (a weak team, an
// easy fixture) gets the same green, 3 stays neutral. Reused here as
// hex, not the shared tier helper itself, since that one keys off a
// continuous 0-1 "ease" fraction, not a discrete 1-5 team rating.
function ratingTone(rating: number): { bg: string; fg: string } {
  if (rating >= 4) return { bg: "#451414", fg: "#f87171" };
  if (rating <= 2) return { bg: "#0f3d2e", fg: "#34d399" };
  return { bg: "#14203a", fg: "#a8b8cc" };
}

function formatRating(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function RatingSlider({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const tone = ratingTone(value);
  return (
    <div className="flex items-center gap-3">
      <span className="w-12 shrink-0 text-xs text-navy-400">{label}</span>
      <input
        type="range"
        min={1}
        max={5}
        step={0.5}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-navy-800 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <span
        className="flex w-9 shrink-0 items-center justify-center rounded px-1.5 py-1 text-xs font-bold"
        style={{ backgroundColor: disabled ? "#14203a" : tone.bg, color: disabled ? "#46617f" : tone.fg }}
      >
        {formatRating(value)}
      </span>
    </div>
  );
}

type Draft = { overrideOn: boolean; home: number; away: number };

function initialDraft(row: TeamStrengthRow): Draft {
  const overrideOn = row.overrideHomeRating != null || row.overrideAwayRating != null;
  return {
    overrideOn,
    home: row.overrideHomeRating ?? row.baselineHomeRating,
    away: row.overrideAwayRating ?? row.baselineAwayRating,
  };
}

// A row's draft no longer matches what's actually saved (rows) - drives
// both the per-card "unsaved changes" hint and which rows Save All
// actually submits (never the untouched ones).
function isDirty(row: TeamStrengthRow, draft: Draft): boolean {
  const saved = initialDraft(row);
  return saved.overrideOn !== draft.overrideOn || saved.home !== draft.home || saved.away !== draft.away;
}

export default function TeamStrengthGrid({ initialRows }: { initialRows: TeamStrengthRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [drafts, setDrafts] = useState<Record<number, Draft>>(
    Object.fromEntries(initialRows.map((r) => [r.teamId, initialDraft(r)]))
  );
  const [statuses, setStatuses] = useState<Record<number, { state: "idle" | "saving" | "saved" | "error"; message?: string }>>({});
  const [saveAllStatus, setSaveAllStatus] = useState<{ state: "idle" | "saving" | "saved" | "error"; message?: string }>({ state: "idle" });
  const [isPending, startTransition] = useTransition();

  const dirtyRows = useMemo(() => rows.filter((r) => isDirty(r, drafts[r.teamId])), [rows, drafts]);

  function updateDraft(teamId: number, patch: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [teamId]: { ...d[teamId], ...patch } }));
  }

  // Real user request 2026-08-27 - editing several teams one at a time
  // meant clicking Save once per team, each dispatching its own 3
  // recompute workflow runs (saveTeamStrengthOverride's own docstring) -
  // a real bulk-edit session fired off N*3 concurrent full-pipeline
  // recomputes that visibly contended with each other on the database
  // while this exact page was being used. Save All submits every
  // changed team in one request and triggers the recompute workflows
  // exactly once for the whole batch (saveAllTeamStrengthOverrides).
  function handleSaveAll() {
    const targets = dirtyRows;
    if (targets.length === 0) return;
    const updates = targets.map((r) => {
      const d = drafts[r.teamId];
      return { teamId: r.teamId, homeRating1to5: d.overrideOn ? d.home : null, awayRating1to5: d.overrideOn ? d.away : null };
    });
    targets.forEach((r) => setStatuses((s) => ({ ...s, [r.teamId]: { state: "saving" } })));
    setSaveAllStatus({ state: "saving" });
    startTransition(async () => {
      const result = await saveAllTeamStrengthOverrides(updates);
      if (!result.saved) {
        setSaveAllStatus({ state: "error", message: result.error });
        targets.forEach((r) => setStatuses((s) => ({ ...s, [r.teamId]: { state: "error", message: result.error } })));
        return;
      }
      const targetIds = new Set(targets.map((r) => r.teamId));
      setRows((prev) =>
        prev.map((r) => {
          if (!targetIds.has(r.teamId)) return r;
          const d = drafts[r.teamId];
          return { ...r, overrideHomeRating: d.overrideOn ? d.home : null, overrideAwayRating: d.overrideOn ? d.away : null };
        })
      );
      setSaveAllStatus({ state: result.error ? "error" : "saved", message: result.error });
      targets.forEach((r) => setStatuses((s) => ({ ...s, [r.teamId]: { state: result.error ? "error" : "saved", message: result.error } })));
    });
  }

  function handleSave(row: TeamStrengthRow) {
    const draft = drafts[row.teamId];
    setStatuses((s) => ({ ...s, [row.teamId]: { state: "saving" } }));
    startTransition(async () => {
      const result = await saveTeamStrengthOverride(row.teamId, draft.overrideOn ? draft.home : null, draft.overrideOn ? draft.away : null);
      if (!result.saved) {
        setStatuses((s) => ({ ...s, [row.teamId]: { state: "error", message: result.error } }));
        return;
      }
      setRows((prev) =>
        prev.map((r) =>
          r.teamId === row.teamId
            ? { ...r, overrideHomeRating: draft.overrideOn ? draft.home : null, overrideAwayRating: draft.overrideOn ? draft.away : null }
            : r
        )
      );
      setStatuses((s) => ({ ...s, [row.teamId]: { state: result.error ? "error" : "saved", message: result.error } }));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-navy-800 bg-navy-900/95 p-3 backdrop-blur">
        <span className="text-xs text-navy-300">
          {dirtyRows.length > 0 ? `${dirtyRows.length} team${dirtyRows.length === 1 ? "" : "s"} with unsaved changes` : "No unsaved changes"}
        </span>
        <div className="flex items-center gap-3">
          {saveAllStatus.state === "saving" && <span className="text-[11px] text-navy-400">Saving all…</span>}
          {saveAllStatus.state === "saved" && <span className="text-[11px] text-emerald-400">All saved - recompute triggered, allow a few minutes</span>}
          {saveAllStatus.state === "error" && saveAllStatus.message && <span className="text-[11px] text-rose-400">{saveAllStatus.message}</span>}
          <button
            type="button"
            disabled={dirtyRows.length === 0 || (isPending && saveAllStatus.state === "saving")}
            onClick={handleSaveAll}
            className="rounded bg-sky-500 px-4 py-1.5 text-xs font-semibold text-navy-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save All{dirtyRows.length > 0 ? ` (${dirtyRows.length})` : ""}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const draft = drafts[row.teamId];
          const status = statuses[row.teamId]?.state ?? "idle";
          const message = statuses[row.teamId]?.message;
          const dirty = isDirty(row, draft);
          return (
          <div key={row.teamId} className="rounded-xl border border-navy-800 bg-navy-900 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-semibold text-white">
                {row.teamName}
                {dirty && <span className="h-1.5 w-1.5 rounded-full bg-sky-400" title="Unsaved changes" />}
              </span>
              <label className="flex items-center gap-1.5 text-[11px] text-navy-400">
                <input
                  type="checkbox"
                  checked={draft.overrideOn}
                  onChange={(e) => updateDraft(row.teamId, { overrideOn: e.target.checked })}
                  className="accent-sky-500"
                />
                Override
              </label>
            </div>

            <div className="mt-3 flex flex-col gap-2">
              <RatingSlider
                label="Home"
                value={draft.overrideOn ? draft.home : row.baselineHomeRating}
                disabled={!draft.overrideOn}
                onChange={(v) => updateDraft(row.teamId, { home: v })}
              />
              <RatingSlider
                label="Away"
                value={draft.overrideOn ? draft.away : row.baselineAwayRating}
                disabled={!draft.overrideOn}
                onChange={(v) => updateDraft(row.teamId, { away: v })}
              />
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-[10px] text-navy-500">
                {draft.overrideOn ? "Overriding baseline" : `Baseline ${formatRating(row.baselineHomeRating)} / ${formatRating(row.baselineAwayRating)}`}
              </span>
              <button
                type="button"
                disabled={isPending && status === "saving"}
                onClick={() => handleSave(row)}
                className="rounded bg-sky-500 px-3 py-1 text-xs font-medium text-navy-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save
              </button>
            </div>
            {status === "saving" && <p className="mt-1.5 text-[10px] text-navy-400">Saving…</p>}
            {status === "saved" && <p className="mt-1.5 text-[10px] text-emerald-400">Saved - recompute triggered, allow a few minutes</p>}
            {status === "error" && message && <p className="mt-1.5 text-[10px] text-rose-400">{message}</p>}
          </div>
          );
        })}
      </div>
    </div>
  );
}
