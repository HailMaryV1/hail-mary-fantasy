"use client";

import { useState, useTransition } from "react";
import { applyRecommendation } from "../actions";

/**
 * Single-leg apply button for a fixture-block "replacement route" - the
 * exact same applyRecommendation bundle-of-1 call FavouredMoveCard already
 * uses, just without a FavouredMove wrapper around it (a replacement route
 * here is a direct legal-swap comparison, not a scored Favoured Move).
 */
export default function ApplyReplacementButton({
  squadId,
  outGamePlayerId,
  inGamePlayerId,
}: {
  squadId: number;
  outGamePlayerId: number;
  inGamePlayerId: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  function handleApply() {
    setError(null);
    startTransition(async () => {
      const result = await applyRecommendation({ squadId, transfers: [{ outGamePlayerId, inGamePlayerId }] });
      if (result?.error) setError(result.error);
      else setApplied(true);
    });
  }

  if (applied) return <p className="text-xs font-medium text-emerald-400">Applied to your squad.</p>;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleApply}
        disabled={isPending}
        className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-navy-950 hover:bg-sky-400 disabled:opacity-40"
      >
        {isPending ? "Applying..." : "Apply this swap"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
