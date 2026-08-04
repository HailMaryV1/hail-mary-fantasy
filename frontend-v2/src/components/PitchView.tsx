"use client";

import Kit from "./Kit";
import StatusPill from "./StatusPill";
import FormPill from "./FormPill";
import { shortenPlayerName } from "@/lib/playerName";
import type { FormStatus } from "@/lib/formStatus";

export type PitchPlayer = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_name: string;
  is_starting: boolean;
  price: number;
  score: number | null;
  lineup?: string | null;
  status?: string | null;
  formStatus?: FormStatus | null;
  isCaptain?: boolean;
  isViceCaptain?: boolean;
  // Overrides the default "X.X pts" second line - lets a caller swap in
  // fixture info, price-vs-value, etc. (Dream Team's real "Show on
  // players" toggle) without this component needing to know what modes
  // exist. undefined keeps the normal score display.
  statText?: string;
};

type Formation = { gk: number; def: number; mid: number; fwd: number };

/**
 * Purely presentational - renders a formation on a pitch, reports clicks.
 * What a click *does* is entirely up to whoever uses this.
 */
export default function PitchView({
  starting,
  selectedId,
  swappableIds,
  onSelect,
}: {
  starting: PitchPlayer[];
  selectedId: number | null;
  swappableIds: Set<number> | null;
  onSelect: (player: PitchPlayer) => void;
}) {
  const rows: { pos: PitchPlayer["position"]; players: PitchPlayer[] }[] = (["FWD", "MID", "DEF", "GK"] as const).map(
    (pos) => ({ pos, players: starting.filter((p) => p.position === pos) })
  );

  function chip(player: PitchPlayer) {
    const isSelected = selectedId === player.game_player_id;
    const isClickable = isSelected || swappableIds === null || swappableIds.has(player.game_player_id);
    return (
      <div key={player.game_player_id} className="flex flex-col items-center">
        <button
          onClick={() => isClickable && onSelect(player)}
          disabled={!isClickable}
          className={`relative flex w-14 flex-col items-center rounded-lg px-1 py-1.5 text-center transition-opacity sm:w-20 md:w-24 ${
            isSelected
              ? "bg-navy-900 ring-2 ring-sky-400"
              : isClickable
                ? "bg-navy-900/90 ring-1 ring-navy-700 hover:ring-sky-500"
                : "cursor-not-allowed bg-navy-900/40 opacity-40"
          }`}
        >
          {(player.isCaptain || player.isViceCaptain) && (
            <span
              title={player.isCaptain ? "Captain" : "Vice-captain"}
              className={`absolute left-0.5 top-0.5 rounded px-1 py-0.5 text-[9px] font-bold leading-none ${
                player.isCaptain ? "bg-amber-500 text-navy-950" : "bg-navy-700 text-white"
              }`}
            >
              {player.isCaptain ? "C" : "VC"}
            </span>
          )}
          <Kit teamName={player.team_name} size="lg" />
          <span className="w-full min-w-0 truncate text-[10px] font-medium text-white sm:text-xs" title={player.full_name}>
            {shortenPlayerName(player.full_name)}
          </span>
          <span className="flex items-center justify-center gap-0.5">
            <StatusPill lineup={player.lineup} status={player.status} />
            <FormPill status={player.formStatus} />
          </span>
          {player.price != null && <span className="text-[10px] text-navy-300">£{Number(player.price).toFixed(1)}m</span>}
          {player.statText !== undefined ? (
            <span className="text-[10px] text-sky-400">{player.statText}</span>
          ) : (
            player.score != null && <span className="text-[10px] text-sky-400">{player.score.toFixed(1)} pts</span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-emerald-900" style={{ background: "linear-gradient(180deg, #1b5e3a 0%, #164a2e 100%)" }}>
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-white/15" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15" />
      <div className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-10 w-32 rounded-b-lg border border-t-0 border-white/10" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 mx-auto h-10 w-32 rounded-t-lg border border-b-0 border-white/10" />

      <div className="relative flex flex-col gap-3 px-1 py-6 sm:gap-6 sm:px-3">
        {rows.map(({ pos, players }) => (
          <div key={pos} className="flex justify-evenly gap-0.5 sm:gap-1">
            {players.map((p) => chip(p))}
          </div>
        ))}
      </div>
    </div>
  );
}
