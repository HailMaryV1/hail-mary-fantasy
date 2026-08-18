"use client";

import { useState, useTransition } from "react";
import { setMatchDayCaptain } from "../actions";
import type { MatchDayPlayer } from "@/lib/matchDayCaptains";

function formatMatchDate(matchDate: string): string {
  const d = new Date(`${matchDate}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

/**
 * Real site behavior, confirmed live: a single-tile click sets that
 * day's captain - no separate vice-captain selection anywhere in the
 * real "Captains" page. Not building a vice-captain-per-match-day
 * mechanic here since there's no real evidence Cloud FF has one -
 * migration 0083's vice_captain_game_player_id column stays available
 * for later if that turns out to be wrong, but the UI only exposes what's
 * actually confirmed. eligiblePlayers can now legitimately be empty -
 * getMatchDaysForSquad returns every real match-day in the window, not
 * just ones the squad has coverage for, specifically so a day with zero
 * eligible players surfaces as a visible "no captain today" alert rather
 * than silently disappearing from the list.
 */
export default function MatchDayCaptainPicker({
  squadId,
  matchDate,
  eligiblePlayers,
  currentCaptainId,
  autoPicked,
}: {
  squadId: number;
  matchDate: string;
  eligiblePlayers: MatchDayPlayer[];
  currentCaptainId: number | null;
  currentViceCaptainId: number | null;
  autoPicked: boolean;
}) {
  const [captainId, setCaptainId] = useState<number | null>(currentCaptainId);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isSingleOption = eligiblePlayers.length === 1;
  const hasNoOptions = eligiblePlayers.length === 0;

  function pick(gamePlayerId: number) {
    if (isSingleOption || isPending) return;
    setError(null);
    setCaptainId(gamePlayerId);
    startTransition(async () => {
      const result = await setMatchDayCaptain({ squadId, matchDate, captainGamePlayerId: gamePlayerId, viceCaptainGamePlayerId: null });
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div className={`rounded-xl border p-4 ${hasNoOptions ? "border-red-800 bg-red-950/20" : "border-navy-700 bg-navy-900"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">{formatMatchDate(matchDate)}</h3>
        {autoPicked && (
          <span className="text-xs font-medium text-navy-400">
            {isSingleOption ? "Auto-picked - only one player has a game" : "Mary picked this - tap another player to change"}
          </span>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {hasNoOptions ? (
        <p className="mt-3 text-sm font-medium text-red-300">No players available - none of your squad play this day.</p>
      ) : (
      <div className="mt-3 flex flex-wrap gap-2">
        {eligiblePlayers.map((p) => {
          const selected = captainId === p.gamePlayerId;
          return (
            <button
              key={p.gamePlayerId}
              onClick={() => pick(p.gamePlayerId)}
              disabled={isSingleOption || isPending}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                selected ? "border-amber-500 bg-amber-950/40 text-white" : "border-navy-700 bg-navy-950 text-navy-200 hover:border-navy-500"
              } ${isSingleOption ? "cursor-default" : "cursor-pointer"} disabled:opacity-80`}
            >
              <span className="font-medium">{p.fullName}</span>
              <span className="ml-1 text-xs text-navy-400">
                ({p.teamName}, {p.position})
              </span>
            </button>
          );
        })}
      </div>
      )}
    </div>
  );
}
