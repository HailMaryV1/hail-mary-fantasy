"use client";

import Kit from "./Kit";
import StatusPill from "../StatusPill";
import { shortenPlayerName } from "@/lib/playerName";

export type NflRosterPlayer = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_name: string;
  price: number;
  score: number | null;
  lineup?: string | null;
  status?: string | null;
};

// Matches FanTeam's own real NFL roster layout exactly (confirmed by
// screenshot against the live site) - TE, then WR, then QB, then RB, then
// DST, top to bottom. Not the QB-first order every other fantasy site
// uses, but this is what FanTeam itself shows, and the point of this
// component is to look like the game the user is actually playing.
const POSITION_ORDER = ["TE", "WR", "QB", "RB", "DST"] as const;

/**
 * NFL equivalent of PitchView.tsx - no bench (NFL FanTeam squads have
 * none, every rostered player starts), no formation, just every position
 * group stacked vertically in FanTeam's own display order.
 */
export default function NflRosterView({
  players,
  selectedId,
  swappableIds,
  onSelect,
}: {
  players: NflRosterPlayer[];
  selectedId: number | null;
  swappableIds: Set<number> | null;
  onSelect: (player: NflRosterPlayer) => void;
}) {
  const rows = POSITION_ORDER.map((pos) => ({ pos, players: players.filter((p) => p.position === pos) }));

  function chip(player: NflRosterPlayer) {
    const isSelected = selectedId === player.game_player_id;
    const isClickable = isSelected || swappableIds === null || swappableIds.has(player.game_player_id);
    return (
      <button
        key={player.game_player_id}
        onClick={() => isClickable && onSelect(player)}
        disabled={!isClickable}
        className={`flex w-16 flex-col items-center rounded-lg px-1 py-1.5 text-center transition-opacity sm:w-20 md:w-24 ${
          isSelected
            ? "bg-navy-900 ring-2 ring-sky-400"
            : isClickable
              ? "bg-navy-900/90 ring-1 ring-navy-700 hover:ring-sky-500"
              : "cursor-not-allowed bg-navy-900/40 opacity-40"
        }`}
      >
        <Kit teamName={player.team_name} size="lg" />
        <span className="w-full min-w-0 truncate text-[10px] font-medium text-white sm:text-xs" title={player.full_name}>
          {shortenPlayerName(player.full_name)}
        </span>
        <span className="flex items-center justify-center">
          <StatusPill lineup={player.lineup} status={player.status} />
        </span>
        {player.score != null && <span className="text-[10px] text-sky-400">{player.score.toFixed(1)} pts</span>}
        {player.price != null && <span className="text-[10px] text-navy-300">£{Number(player.price).toFixed(1)}m</span>}
      </button>
    );
  }

  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-emerald-900"
      style={{ background: "linear-gradient(180deg, #1b5e3a 0%, #164a2e 100%)" }}
    >
      {/* Gridiron yard lines - horizontal stripes down a vertical field,
          same "real but simplified" spirit as PitchView's soccer markings. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-evenly">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="h-px w-full bg-white/10" />
        ))}
      </div>

      <div className="relative flex flex-col gap-3 px-1 py-6 sm:gap-5 sm:px-3">
        {rows.map(({ pos, players: rowPlayers }) => (
          <div key={pos}>
            <div className="flex justify-evenly gap-0.5 sm:gap-1">{rowPlayers.map((p) => chip(p))}</div>
            <p className="mt-1 text-center text-[10px] font-semibold uppercase tracking-widest text-white/60">
              {pos === "DST" ? "DST" : pos === "TE" ? "Tight End" : pos === "WR" ? "Wide Receiver" : pos === "QB" ? "Quarterback" : "Running Back"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
