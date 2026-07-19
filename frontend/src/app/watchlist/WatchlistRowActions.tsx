"use client";

import Link from "next/link";
import { useTransition } from "react";
import { removeFromWatchlist } from "./actions";

export default function WatchlistRowActions({
  entryId,
  gamePlayerId,
  gameId,
}: {
  entryId: number;
  gamePlayerId: number;
  gameId: number;
}) {
  const [isPending, startTransition] = useTransition();

  function handleRemove() {
    startTransition(async () => {
      await removeFromWatchlist({ id: entryId });
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Link href={`/compare?ids=${gamePlayerId}`} className="text-sky-400 hover:text-sky-300">
        Compare
      </Link>
      <Link href={`/players/${gamePlayerId}`} className="text-sky-400 hover:text-sky-300">
        Open Profile
      </Link>
      <Link href={`/watchlist/transfer-in?player=${gamePlayerId}&game=${gameId}`} className="text-emerald-400 hover:text-emerald-300">
        Transfer In
      </Link>
      <button onClick={handleRemove} disabled={isPending} className="text-red-400 hover:text-red-300 disabled:opacity-40">
        {isPending ? "Removing..." : "Remove"}
      </button>
    </div>
  );
}
