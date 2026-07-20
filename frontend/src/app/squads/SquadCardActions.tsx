"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { deleteSquad, renameSquad } from "./actions";

export default function SquadCardActions({
  squadId,
  squadName,
  gameSlug,
}: {
  squadId: number;
  squadName: string;
  gameSlug: string;
}) {
  const [mode, setMode] = useState<"idle" | "rename" | "confirmDelete">("idle");
  const [name, setName] = useState(squadName);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleRename() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name can't be empty.");
      return;
    }
    startTransition(async () => {
      const result = await renameSquad({ squadId, name: trimmed });
      if (result?.error) setError(result.error);
      else setMode("idle");
    });
  }

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteSquad({ squadId });
      if (result?.error) setError(result.error);
      // On success the squad disappears from the revalidated list -
      // nothing left to reset mode on.
    });
  }

  if (mode === "rename") {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1 text-sm text-white"
          autoFocus
        />
        <button
          onClick={handleRename}
          disabled={isPending}
          className="rounded-lg bg-sky-500 px-3 py-1 text-xs font-medium text-navy-950 hover:bg-sky-400 disabled:opacity-40"
        >
          {isPending ? "Saving..." : "Save"}
        </button>
        <button
          onClick={() => {
            setMode("idle");
            setName(squadName);
            setError(null);
          }}
          className="text-xs font-medium text-navy-400 hover:text-white"
        >
          Cancel
        </button>
        {error && <p className="w-full text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  if (mode === "confirmDelete") {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-amber-400">Delete &quot;{squadName}&quot;? This removes its transfers, captain history, and Performance Lab predictions too.</span>
        <button
          onClick={handleDelete}
          disabled={isPending}
          className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-40"
        >
          {isPending ? "Deleting..." : "Yes, delete"}
        </button>
        <button onClick={() => setMode("idle")} className="text-xs font-medium text-navy-400 hover:text-white">
          Cancel
        </button>
        {error && <p className="w-full text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Link
        href={`/squads/new?game=${gameSlug}&squad=${squadId}`}
        className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
      >
        Edit squad
      </Link>
      <button
        onClick={() => setMode("rename")}
        className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
      >
        Rename
      </button>
      <button
        onClick={() => setMode("confirmDelete")}
        className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-red-400 hover:bg-red-950"
      >
        Delete
      </button>
    </div>
  );
}
