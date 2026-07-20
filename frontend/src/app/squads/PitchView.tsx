"use client";

import Kit from "./Kit";
import StatusPill from "../StatusPill";
import { shortenPlayerName } from "@/lib/playerName";

export type PitchPlayer = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_name: string;
  is_starting: boolean;
  price: number;
  score: number | null;
  lineup?: string | null;
  status?: string | null;
  nextFixture?: { opponentAbbr: string; isHome: boolean } | null;
};

type Formation = { gk: number; def: number; mid: number; fwd: number };

/**
 * Purely presentational - renders a formation on a pitch plus a bench
 * strip and reports clicks. What a click *does* (select for swap,
 * complete a swap, pick a transfer target...) is entirely up to whoever
 * uses this - kept that way so it's reusable between the lineup page
 * (Part 7) and the transfers page (Part 8), which have very different
 * click semantics.
 */
export default function PitchView({
  starting,
  bench,
  selectedId,
  swappableIds,
  onSelect,
}: {
  starting: PitchPlayer[];
  bench: PitchPlayer[];
  selectedId: number | null;
  swappableIds: Set<number> | null;
  onSelect: (player: PitchPlayer, zone: "pitch" | "bench") => void;
}) {
  const rows: { pos: PitchPlayer["position"]; players: PitchPlayer[] }[] = (["FWD", "MID", "DEF", "GK"] as const).map(
    (pos) => ({ pos, players: starting.filter((p) => p.position === pos) })
  );

  function chip(player: PitchPlayer, zone: "pitch" | "bench") {
    const isSelected = selectedId === player.game_player_id;
    // The selected player always stays clickable (so it can be deselected/
    // reconsidered) even if it wouldn't otherwise be in swappableIds.
    const isClickable = isSelected || swappableIds === null || swappableIds.has(player.game_player_id);
    return (
      <button
        key={player.game_player_id}
        onClick={() => isClickable && onSelect(player, zone)}
        disabled={!isClickable}
        className={`flex w-14 flex-col items-center rounded-lg px-1 py-1.5 text-center transition-opacity sm:w-20 md:w-24 ${
          isSelected
            ? "bg-navy-900 ring-2 ring-sky-400"
            : isClickable
              ? "bg-navy-900/90 ring-1 ring-navy-700 hover:ring-sky-500"
              : "cursor-not-allowed bg-navy-900/40 opacity-40"
        }`}
      >
        <Kit teamName={player.team_name} size="lg" />
        <span className="flex w-full min-w-0 items-center justify-center gap-0.5">
          <span className="min-w-0 truncate text-[10px] font-medium text-white sm:text-xs" title={player.full_name}>
            {shortenPlayerName(player.full_name)}
          </span>
          <StatusPill lineup={player.lineup} status={player.status} />
        </span>
        {player.score != null && <span className="text-[10px] text-sky-400">{player.score.toFixed(1)} pts</span>}
        {player.price != null && <span className="text-[10px] text-navy-300">£{Number(player.price).toFixed(1)}m</span>}
        {player.nextFixture && (
          <span className="text-[9px] text-navy-400">
            {player.nextFixture.isHome ? "vs" : "@"} {player.nextFixture.opponentAbbr}
          </span>
        )}
      </button>
    );
  }

  return (
    <div>
      <div className="relative overflow-hidden rounded-2xl border border-emerald-900" style={{ background: "linear-gradient(180deg, #1b5e3a 0%, #164a2e 100%)" }}>
        {/* Pitch markings */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-white/15" />
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15" />
        <div className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-10 w-32 rounded-b-lg border border-t-0 border-white/10" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 mx-auto h-10 w-32 rounded-t-lg border border-b-0 border-white/10" />

        <div className="relative flex flex-col gap-3 px-1 py-6 sm:gap-6 sm:px-3">
          {rows.map(({ pos, players }) => (
            <div key={pos} className="flex justify-evenly gap-0.5 sm:gap-1">
              {players.map((p) => chip(p, "pitch"))}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-navy-700 bg-navy-900 p-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-navy-400">Bench</p>
        <div className="flex flex-wrap gap-2">
          {bench.map((p) => chip(p, "bench"))}
          {bench.length === 0 && <span className="text-xs text-navy-400">No bench players.</span>}
        </div>
      </div>
    </div>
  );
}
