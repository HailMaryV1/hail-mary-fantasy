"use client";

import { useState, useTransition } from "react";
import { addToWatchlist } from "../watchlist/actions";

/**
 * Same pattern as squads/[id]/transfers/AddToWatchlistButton.tsx, extended
 * with a `notes` prop - Ask Mary's recommendations carry real context
 * (why it was suggested, the gameweek it applies to, the numbers behind
 * it) worth preserving on the watchlist entry, not just a reason tag.
 */
export default function AskMaryWatchlistButton({
  gameId,
  gamePlayerId,
  defaultReasons,
  notes,
}: {
  gameId: number;
  gamePlayerId: number;
  defaultReasons: string[];
  notes?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await addToWatchlist({ gameId, gamePlayerId, reasons: defaultReasons, notes });
      if (result?.error) setError(result.error);
      else setAdded(true);
    });
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={isPending || added}
        className="rounded-lg border border-navy-700 bg-navy-950 px-2.5 py-1 text-[11px] font-medium text-navy-300 hover:bg-navy-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {added ? "Added to Watchlist" : isPending ? "Adding..." : "Add to Watchlist"}
      </button>
      {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
