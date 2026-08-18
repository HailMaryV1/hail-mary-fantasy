"use client";

import { useState, useTransition } from "react";

/**
 * Shared across every game that has this button (Dream Team, FanTeam,
 * Cloud FF) - real user request 2026-08-18: an explicit lock-in step,
 * re-pressable until the gameweek's deadline, after which the last save
 * is the permanent record (see gameweekHistory.ts's saveSquadGameweekLock/
 * isSquadSaved for the actual read/write logic this just triggers).
 * `onSave` is each game's own bound server action - this component knows
 * nothing about squad IDs or gameweeks, only whether the current state is
 * already saved.
 */
export default function SaveTeamButton({
  isSaved,
  onSave,
}: {
  isSaved: boolean;
  onSave: () => Promise<{ error?: string } | { success: true } | void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await onSave();
      if (result && "error" in result && result.error) setError(result.error);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleSave}
        disabled={isPending || isSaved}
        title={
          isSaved
            ? "Your current picks match what's saved for this gameweek."
            : "Lock in your current picks as this gameweek's official team. You can keep re-saving right up until the deadline."
        }
        className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
          isSaved
            ? "border-emerald-800 bg-emerald-950/40 text-emerald-400"
            : "border-amber-700 bg-amber-950 text-amber-300 hover:bg-amber-900"
        }`}
      >
        {isPending ? "Saving..." : isSaved ? "Saved" : "Save Team"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
