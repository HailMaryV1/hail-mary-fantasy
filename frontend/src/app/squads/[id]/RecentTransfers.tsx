"use client";

import { useState, useTransition } from "react";
import { reverseTransfer } from "../actions";

type RecentTransfer = { id: number; outName: string; inName: string };

/**
 * Pre-season only (page.tsx gates this) - transfers are free/unlimited
 * before the season starts, so undoing one is just another free swap.
 * reverseTransfer (squads/actions.ts) itself refuses once the season has
 * started, as a second line of defense.
 */
export default function RecentTransfers({ squadId, transfers }: { squadId: number; transfers: RecentTransfer[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  if (transfers.length === 0) return null;

  function handleUndo(transferId: number) {
    setError(null);
    setPendingId(transferId);
    startTransition(async () => {
      const result = await reverseTransfer({ squadId, transferId });
      if (result?.error) setError(result.error);
      setPendingId(null);
    });
  }

  return (
    <div>
      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-navy-400">Recent transfers</h2>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <div className="mt-3 flex flex-col gap-2">
        {transfers.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between rounded-xl border border-navy-700 bg-navy-900 p-3 text-sm"
          >
            <span className="text-white">
              <span className="text-navy-400">{t.outName}</span> <span className="text-navy-500">→</span> {t.inName}
            </span>
            <button
              onClick={() => handleUndo(t.id)}
              disabled={isPending}
              className="rounded-lg border border-navy-700 px-3 py-1 text-xs font-medium text-white hover:bg-navy-800 disabled:opacity-40"
            >
              {isPending && pendingId === t.id ? "Undoing..." : "Undo"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
