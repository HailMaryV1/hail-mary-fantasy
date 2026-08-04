"use client";

import { useState } from "react";
import Badge from "../Badge";
import { getTeamColors } from "@/lib/teamColors";

export type SwingRecPlayer = {
  label: string;
  gamePlayerId: number;
  fullName: string;
  position: string;
  price: number;
  hailMaryScore: number | null;
  expectedPointsNext5: number | null;
};

export type SwingFixtureStripEntry = { gameweek: number; opponent: string; isHome: boolean; ratio: number | null };

/**
 * Collapsed by default - just the team, swing direction, and starting
 * gameweek, matching every other filter-pill/summary-row idiom already in
 * this app. Expanding reveals the same detail FixtureSwingPanel always
 * showed (fixture run, current->upcoming/swing stats, recommended
 * players or sell candidates) - nothing removed, just deferred until
 * asked for, so the panel reads as a scannable list rather than a wall
 * of cards.
 */
export default function SwingTeamRow({
  teamName,
  kind,
  startsInGameweek,
  currentRating,
  upcomingRating,
  swingValue,
  strip,
  recs,
  noRecsMessage,
}: {
  teamName: string;
  kind: "good" | "bad";
  startsInGameweek: number | null;
  currentRating: number;
  upcomingRating: number;
  swingValue: number;
  strip: SwingFixtureStripEntry[];
  recs: SwingRecPlayer[];
  noRecsMessage: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`rounded-xl border ${kind === "good" ? "border-emerald-900" : "border-red-900"} bg-navy-900`}>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between gap-2 p-3 text-left hover:bg-navy-800/60"
      >
        <div className="flex items-center gap-2">
          <Badge teamName={teamName} size="sm" />
          <p className="font-medium text-white">{teamName}</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              kind === "good" ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
            }`}
          >
            {kind === "good" ? "↑ Improving" : "↓ Declining"}
          </span>
          <span className="text-xs text-navy-400">{startsInGameweek != null ? `GW${startsInGameweek}` : "-"}</span>
          <span className={`text-navy-400 transition-transform ${expanded ? "rotate-90" : ""}`}>▶</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-navy-800 p-4">
          <div className="grid grid-cols-2 gap-2 text-center text-xs">
            <div>
              <p className="text-navy-400">Current → Upcoming</p>
              <p className="font-medium text-white">
                {currentRating.toFixed(2)} → {upcomingRating.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-navy-400">Swing</p>
              <p className={`font-medium ${swingValue >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {swingValue >= 0 ? "+" : ""}
                {swingValue.toFixed(2)}
              </p>
            </div>
          </div>

          <p className="mt-3 text-[10px] font-medium uppercase tracking-wide text-navy-500">Fixture run</p>
          <div className="mt-1 flex gap-1">
            {strip.map((fx) => (
              <div
                key={fx.gameweek}
                title={`GW${fx.gameweek}: ${fx.isHome ? "vs" : "@"} ${fx.opponent}`}
                className={`flex-1 rounded px-1 py-1 text-center text-[9px] font-medium ${
                  fx.ratio == null
                    ? "bg-navy-800 text-navy-400"
                    : fx.ratio >= 1.15
                      ? "bg-emerald-950 text-emerald-400"
                      : fx.ratio <= 0.85
                        ? "bg-red-950 text-red-400"
                        : "bg-navy-800 text-navy-300"
                }`}
              >
                {getTeamColors(fx.opponent).abbr}
              </div>
            ))}
            {strip.length === 0 && <p className="text-[10px] text-navy-500">No upcoming fixtures found.</p>}
          </div>

          <p className="mt-3 text-[10px] font-medium uppercase tracking-wide text-navy-500">
            {kind === "good" ? "Recommended players" : "Consider selling"}
          </p>
          {recs.length > 0 ? (
            <div className="mt-1 flex flex-col gap-2">
              {recs.map((r) => (
                <div key={`${r.label}-${r.gamePlayerId}`} className="rounded-lg border border-navy-800 bg-navy-950 p-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-sky-400">{r.label}</p>
                  <p className="mt-0.5 text-sm font-medium text-white">{r.fullName}</p>
                  <p className="text-[11px] text-navy-400">
                    {r.position} · £{r.price.toFixed(1)}m · HMS {r.hailMaryScore != null ? r.hailMaryScore.toFixed(1) : "-"} · xPts5{" "}
                    {r.expectedPointsNext5 != null ? r.expectedPointsNext5.toFixed(1) : "-"}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-xs text-navy-400">{noRecsMessage}</p>
          )}
        </div>
      )}
    </div>
  );
}
