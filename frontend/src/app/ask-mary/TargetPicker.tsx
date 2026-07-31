"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { PlayerOption } from "@/lib/engineExplainability";

/**
 * "Fund a Target"'s player picker - same client-side filter pattern as
 * algorithm-explain/PlayerSearch.tsx (a few hundred rows, small enough
 * to ship once and filter locally), adapted to select a squad's own
 * `?player=` route instead of algorithm-explain's. `players` is already
 * pre-filtered by the caller to exclude anyone already owned - picking
 * your own player as a "target" makes no sense here.
 */
export default function TargetPicker({
  players,
  squadId,
  selectedId,
}: {
  players: PlayerOption[];
  squadId: number;
  selectedId: number | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return players.slice(0, 12);
    return players.filter((p) => p.fullName.toLowerCase().includes(q) || p.teamName.toLowerCase().includes(q)).slice(0, 20);
  }, [players, query]);

  function selectPlayer(gamePlayerId: number) {
    setQuery("");
    router.push(`/ask-mary/fund-a-target?squad=${squadId}&player=${gamePlayerId}`);
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search any player by name or team..."
        className="w-full rounded-lg border border-navy-700 bg-navy-950 px-3 py-2 text-sm text-white placeholder:text-navy-500"
      />
      {query.trim() !== "" && (
        <div className="absolute z-10 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-navy-700 bg-navy-900 shadow-lg">
          {filtered.length === 0 ? (
            <p className="px-3 py-3 text-xs text-navy-500">No players match.</p>
          ) : (
            filtered.map((p) => (
              <button
                key={p.gamePlayerId}
                onClick={() => selectPlayer(p.gamePlayerId)}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-navy-800 ${
                  p.gamePlayerId === selectedId ? "bg-navy-800" : ""
                }`}
              >
                <span className="text-white">{p.fullName}</span>
                <span className="text-xs text-navy-400">
                  {p.position} · {p.teamName} · £{p.price.toFixed(1)}m
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
