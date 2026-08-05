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
  // null for a game with no price/budget system at all (EFL Fantasy -
  // see gameConfig.ts's hasBudget) - distinct from a real £0.0m price,
  // which no game actually has.
  price: number | null;
  score: number | null;
  lineup?: string | null;
  status?: string | null;
  formStatus?: FormStatus | null;
  isCaptain?: boolean;
  isViceCaptain?: boolean;
  // Real bench priority (1/2/3 for the 3 outfield reserves, null/undefined
  // for starters and the single reserve GK). Only meaningful on bench
  // chips - drives whether a reorder control renders (see onReorderBench).
  benchOrder?: number | null;
  // Overrides the default "X.X pts" second line - lets a caller swap in
  // fixture info, price-vs-value, etc. (Dream Team's real "Show on
  // players" toggle) without this component needing to know what modes
  // exist. undefined keeps the normal score display.
  statText?: string;
  // Same idea as statText but renders as colored difficulty badges (the
  // caller supplies the color class, keeping this component purely
  // presentational) instead of plain text - used for the fixture display
  // modes so pitch chips match the player pool's difficulty coloring.
  // Takes priority over statText when present.
  statTiles?: { label: string; colorClass: string }[];
  // Renders a dashed placeholder instead of the real player chip - a slot
  // whose occupant has been sold but not yet replaced, still holding its
  // position in the formation. emptyLabel shows who was sold, so the
  // placeholder stays identifiable while it's waiting to be filled.
  isEmpty?: boolean;
  emptyLabel?: string;
};

type Formation = { gk: number; def: number; mid: number; fwd: number };

/**
 * Purely presentational - renders a formation on a pitch, reports clicks.
 * What a click *does* is entirely up to whoever uses this.
 */
export default function PitchView({
  starting,
  bench,
  clubs,
  selectedId,
  swappableIds,
  onSelect,
  onReorderBench,
}: {
  starting: PitchPlayer[];
  // Optional - games with a real bench (FanTeam) pass their reserves here,
  // already in real display order (reserve GK first, then outfield by
  // bench_order); games with no bench concept (Dream Team) omit it
  // entirely and nothing extra renders.
  bench?: PitchPlayer[];
  // Optional - EFL Fantasy's 2 "pick a whole club" slots (see migration
  // 0087's docstring - synthetic `players` rows, position 'CLUB'), shown
  // in their own bottom section same as `bench` above. No other game has
  // a slot type that isn't an individual player, so this stays fully
  // optional and every other board's PitchView call is unaffected.
  clubs?: PitchPlayer[];
  selectedId: number | null;
  swappableIds: Set<number> | null;
  onSelect: (player: PitchPlayer) => void;
  // Optional - only outfield bench chips (benchOrder != null) get a
  // reorder control when this is provided. targetOrder is the reserve
  // slot (1/2/3) to move this player into - whoever currently holds that
  // slot swaps back to this player's old one, a direct one-step swap
  // rather than nudging one place at a time.
  onReorderBench?: (gamePlayerId: number, targetOrder: number) => void;
}) {
  const rows: { pos: PitchPlayer["position"]; players: PitchPlayer[] }[] = (["FWD", "MID", "DEF", "GK"] as const).map(
    (pos) => ({ pos, players: starting.filter((p) => p.position === pos) })
  );
  const maxBenchOrder = Math.max(0, ...(bench ?? []).map((p) => p.benchOrder ?? 0));

  function chip(player: PitchPlayer, zone: "pitch" | "bench" = "pitch") {
    const isSelected = selectedId === player.game_player_id;
    const isClickable = isSelected || swappableIds === null || swappableIds.has(player.game_player_id);
    const showReorder = zone === "bench" && onReorderBench && player.benchOrder != null;

    if (player.isEmpty) {
      return (
        <div key={player.game_player_id} className="flex flex-col items-center">
          <button
            onClick={() => onSelect(player)}
            className="flex w-14 flex-col items-center justify-center gap-0.5 rounded-lg border-2 border-dashed border-navy-600 px-1 py-1.5 text-center text-navy-500 transition-colors hover:border-sky-500 hover:text-sky-400 sm:w-20 md:w-24"
            style={{ minHeight: "5.5rem" }}
          >
            <span className="text-lg leading-none">+</span>
            <span className="text-[9px] font-medium uppercase tracking-wide">{player.position}</span>
            {player.emptyLabel && (
              <span className="w-full min-w-0 truncate text-[9px]" title={player.emptyLabel}>
                {player.emptyLabel}
              </span>
            )}
          </button>
        </div>
      );
    }

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
          {player.statTiles !== undefined ? (
            <span className="mt-0.5 flex flex-wrap items-center justify-center gap-0.5">
              {player.statTiles.length === 0 ? (
                <span className="text-[10px] text-navy-600">-</span>
              ) : (
                player.statTiles.map((t, i) => (
                  <span key={i} className={`rounded px-1 py-0.5 text-[9px] font-bold text-white ${t.colorClass}`}>
                    {t.label}
                  </span>
                ))
              )}
            </span>
          ) : player.statText !== undefined ? (
            <span className="text-[10px] text-sky-400">{player.statText}</span>
          ) : (
            player.score != null && <span className="text-[10px] text-sky-400">{player.score.toFixed(1)} pts</span>
          )}
        </button>
        {zone === "bench" && player.position === "GK" && <span className="mt-0.5 text-[9px] text-white/40">Reserve GK</span>}
        {showReorder && (
          <label className="mt-0.5 flex items-center gap-1 text-[9px] text-white/40">
            Res
            <select
              value={player.benchOrder ?? ""}
              onChange={(e) => onReorderBench!(player.game_player_id, Number(e.target.value))}
              aria-label={`${player.full_name}'s bench order - swaps places with whoever's currently in the chosen slot`}
              className="rounded border border-navy-700 bg-navy-950 px-0.5 py-px text-[9px] text-navy-300"
            >
              {Array.from({ length: maxBenchOrder }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
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

      {bench !== undefined && bench.length > 0 && (
        <div className="relative border-t border-white/10 bg-black/20 px-1 py-3 sm:px-3">
          <p className="mb-2 text-center text-[10px] font-semibold uppercase tracking-wide text-white/50">Bench</p>
          <div className="flex justify-evenly gap-0.5 sm:gap-1">{bench.map((p) => chip(p, "bench"))}</div>
        </div>
      )}

      {clubs !== undefined && clubs.length > 0 && (
        <div className="relative border-t border-white/10 bg-black/20 px-1 py-3 sm:px-3">
          <p className="mb-2 text-center text-[10px] font-semibold uppercase tracking-wide text-white/50">Clubs</p>
          <div className="flex justify-evenly gap-0.5 sm:gap-1">{clubs.map((p) => chip(p))}</div>
        </div>
      )}
    </div>
  );
}
