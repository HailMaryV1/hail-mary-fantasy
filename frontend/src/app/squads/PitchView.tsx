"use client";

import Kit from "./Kit";
import StatusPill from "../StatusPill";
import FormPill from "../FormPill";
import { shortenPlayerName } from "@/lib/playerName";
import type { FormStatus } from "@/lib/hailMaryForm";

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
  nextFixture?: { opponentAbbr: string; isHome: boolean } | null;
  // Auto-substitution priority (1st/2nd/3rd reserve) for an outfield
  // bench player - null for starters, the reserve GK (always exactly
  // one, nothing to order), and any game with no bench concept at all.
  benchOrder?: number | null;
  // Real captain/vice-captain, straight from squads.captain_game_player_id/
  // vice_captain_game_player_id - shown as a plain pill on the chip
  // itself rather than a separate editable picker for provider-synced
  // squads (FanTeam), where captaincy comes from the real FanTeam team
  // and any manual change here would just be overwritten by the next
  // sync anyway.
  isCaptain?: boolean;
  isViceCaptain?: boolean;
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
  onReorderBench,
}: {
  starting: PitchPlayer[];
  bench: PitchPlayer[];
  selectedId: number | null;
  swappableIds: Set<number> | null;
  onSelect: (player: PitchPlayer, zone: "pitch" | "bench") => void;
  // Bench auto-substitution priority isn't editable unless the caller
  // wires this up (LineupBuilder does; the Transfers pool doesn't need
  // it) - omit it and the bench renders read-only, same as before.
  // targetOrder is the reserve slot (1/2/3) to swap this player into -
  // whoever currently holds that slot swaps back to this player's old
  // one, a direct one-step swap rather than nudging one place at a time.
  onReorderBench?: (gamePlayerId: number, targetOrder: number) => void;
}) {
  const rows: { pos: PitchPlayer["position"]; players: PitchPlayer[] }[] = (["FWD", "MID", "DEF", "GK"] as const).map(
    (pos) => ({ pos, players: starting.filter((p) => p.position === pos) })
  );
  const maxBenchOrder = Math.max(0, ...bench.map((p) => p.benchOrder ?? 0));
  // GK reserve first (a fixed, unordered role), then outfield reserves in
  // their actual auto-sub priority - display order should read the same
  // way the real substitution priority works, not just squad-array order.
  const orderedBench = bench.slice().sort((a, b) => {
    if (a.position === "GK" && b.position !== "GK") return -1;
    if (b.position === "GK" && a.position !== "GK") return 1;
    return (a.benchOrder ?? 99) - (b.benchOrder ?? 99);
  });

  function chip(player: PitchPlayer, zone: "pitch" | "bench") {
    const isSelected = selectedId === player.game_player_id;
    // The selected player always stays clickable (so it can be deselected/
    // reconsidered) even if it wouldn't otherwise be in swappableIds.
    const isClickable = isSelected || swappableIds === null || swappableIds.has(player.game_player_id);
    const showReorder = zone === "bench" && onReorderBench && player.benchOrder != null;
    return (
      <div key={player.game_player_id} className="flex flex-col items-center">
        <button
          onClick={() => isClickable && onSelect(player, zone)}
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
          {player.score != null && <span className="text-[10px] text-sky-400">{player.score.toFixed(1)} pts</span>}
          {player.price != null && <span className="text-[10px] text-navy-300">£{Number(player.price).toFixed(1)}m</span>}
          {player.nextFixture && (
            <span className="text-[9px] text-navy-400">
              {player.nextFixture.isHome ? "vs" : "@"} {player.nextFixture.opponentAbbr}
            </span>
          )}
        </button>
        {zone === "bench" && player.position === "GK" && <span className="mt-0.5 text-[9px] text-navy-500">Reserve GK</span>}
        {showReorder && (
          <label className="mt-0.5 flex items-center gap-1 text-[9px] text-navy-500">
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
          {orderedBench.map((p) => chip(p, "bench"))}
          {bench.length === 0 && <span className="text-xs text-navy-400">No bench players.</span>}
        </div>
      </div>
    </div>
  );
}
