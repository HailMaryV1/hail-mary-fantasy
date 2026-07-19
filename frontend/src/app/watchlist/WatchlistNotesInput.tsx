"use client";

import { useState, useTransition } from "react";
import { updateWatchlistNotes } from "./actions";

export default function WatchlistNotesInput({ entryId, initialNotes }: { entryId: number; initialNotes: string | null }) {
  const [value, setValue] = useState(initialNotes ?? "");
  const [isPending, startTransition] = useTransition();

  function handleBlur() {
    startTransition(async () => {
      await updateWatchlistNotes({ id: entryId, notes: value });
    });
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleBlur}
      placeholder="Add a note..."
      disabled={isPending}
      className="w-full min-w-[120px] rounded border border-navy-700 bg-navy-950 px-2 py-1 text-xs text-white placeholder:text-navy-500 disabled:opacity-60"
    />
  );
}
