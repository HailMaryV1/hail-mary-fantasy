"use client";

import { useState, useTransition } from "react";
import { makeTransfer } from "../../actions";
import type { Recommendation } from "./page";

export default function TransferPlanner({
  squadId,
  recommendations,
  currentGameweek,
  freeTransfers,
  wildcardActiveThisWeek,
  wc1Available,
  wc2Available,
}: {
  squadId: number;
  recommendations: Recommendation[];
  currentGameweek: number | null;
  freeTransfers: number;
  wildcardActiveThisWeek: boolean;
  wc1Available: boolean;
  wc2Available: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [useWildcard, setUseWildcard] = useState(false);
  const [isPending, startTransition] = useTransition();

  const hasGameweek = currentGameweek !== null;
  const nextTransferFree = !hasGameweek || wildcardActiveThisWeek || useWildcard || freeTransfers > 0;

  function handleTransfer(rec: Recommendation) {
    setError(null);
    setPendingId(rec.outGamePlayerId);
    startTransition(async () => {
      const result = await makeTransfer({
        squadId,
        outGamePlayerId: rec.outGamePlayerId,
        inGamePlayerId: rec.inGamePlayerId,
        useWildcard,
      });
      if (result?.error) setError(result.error);
      setPendingId(null);
    });
  }

  if (recommendations.length === 0) {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        No improving transfers available right now within your budget and club limits.
      </p>
    );
  }

  return (
    <div>
      {hasGameweek && !wildcardActiveThisWeek && (wc1Available || wc2Available) && (
        <label className="mb-4 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={useWildcard} onChange={(e) => setUseWildcard(e.target.checked)} />
          Use {wc1Available ? "Wildcard 1" : "Wildcard 2"} on my next transfer (makes all transfers free this
          gameweek, resets banked free transfers)
        </label>
      )}

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <div className="flex flex-col gap-2">
        {recommendations.map((rec) => (
          <div
            key={rec.outGamePlayerId}
            className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <span className="text-zinc-500">{rec.position} · </span>
                <span className="text-black dark:text-zinc-50">{rec.outName}</span>
                <span className="text-zinc-500"> ({rec.outTeam}, £{rec.outPrice.toFixed(1)}m, {rec.outScore.toFixed(1)}) </span>
                <span className="text-zinc-400"> → </span>
                <span className="font-medium text-black dark:text-zinc-50">{rec.inName}</span>
                <span className="text-zinc-500"> ({rec.inTeam}, £{rec.inPrice.toFixed(1)}m, {rec.inScore.toFixed(1)})</span>
              </div>
              <span className="ml-3 shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-950 dark:text-green-400">
                +{rec.delta.toFixed(1)}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => handleTransfer(rec)}
                disabled={isPending}
                className="rounded-lg bg-black px-3 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              >
                {isPending && pendingId === rec.outGamePlayerId ? "Making transfer..." : "Make this transfer"}
              </button>
              {hasGameweek && (
                <span
                  className={`text-xs font-medium ${nextTransferFree ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                >
                  {nextTransferFree ? "Free transfer" : "Costs -4 points"}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
