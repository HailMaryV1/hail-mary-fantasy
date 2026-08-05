"use client";

import { useState, useTransition } from "react";
import { applyClubRecommendation } from "./actions";
import type { ClubRecommendation } from "@/lib/eflfantasyAskMaryEngine";

/**
 * A single current-gameweek club-pick recommendation - not a collapsible
 * multi-step plan like GameweekPlanRow, since clubs are recommended one
 * gameweek at a time (see eflfantasyAskMaryEngine.ts's docstring on why).
 */
export default function ClubRecommendationCard({ recommendation, squadId }: { recommendation: ClubRecommendation; squadId: number }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const netGain = recommendation.transfers.reduce((sum, t) => sum + t.pointsGain, 0);

  function handleApply() {
    setError(null);
    startTransition(async () => {
      const result = await applyClubRecommendation({
        squadId,
        legs: recommendation.transfers.map((t) => ({ outGamePlayerId: t.outGamePlayerId, inGamePlayerId: t.inGamePlayerId })),
      });
      if (result?.error) setError(result.error);
      else setApplied(true);
    });
  }

  return (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">Club Picks - GW{recommendation.gameweek}</h3>
        {!recommendation.hold && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${netGain >= 0 ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"}`}>
            {netGain >= 0 ? "+" : ""}
            {netGain.toFixed(1)}
          </span>
        )}
      </div>

      {recommendation.hold ? (
        <p className="mt-2 text-sm text-emerald-300">{recommendation.writeup}</p>
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-2">
            {recommendation.transfers.map((t) => (
              <div key={`${t.outGamePlayerId}-${t.inGamePlayerId}`} className="rounded-lg border border-navy-800 bg-navy-950 p-2.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-white">{t.outClubName}</span>
                  <span className="text-navy-500">→</span>
                  <span className="font-medium text-white">{t.inClubName}</span>
                  <span className={`ml-auto text-xs font-medium ${t.pointsGain >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {t.pointsGain >= 0 ? "+" : ""}
                    {t.pointsGain.toFixed(1)} pts
                  </span>
                </div>
                <p className="mt-1 text-xs text-navy-400">{t.reasoning}</p>
              </div>
            ))}
          </div>

          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          {applied && <p className="mt-2 text-xs text-emerald-400">Applied - your squad has been updated.</p>}

          <div className="mt-3">
            <button
              onClick={handleApply}
              disabled={isPending || applied}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-navy-950 hover:bg-sky-400 disabled:opacity-40"
            >
              {isPending ? "Applying..." : applied ? "Applied" : "Apply Recommendation"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
