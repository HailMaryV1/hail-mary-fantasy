"use client";

import { useEffect, useState } from "react";
import { getPlayerExplanation } from "@/lib/playerExplanationActions";
import {
  MODULE_DISPLAY_NAMES,
  MODULE_NAMES,
  MODULAR_STATS,
  STAT_DISPLAY_NAMES,
  confidenceTone,
  dataSourceTone,
  dataSourceLabel,
  type EngineExplanation,
} from "@/lib/engineExplainability";

/**
 * The friendly, sidebar-sized "why is Mary projecting this" view - a
 * deliberately condensed take on the full validation-grade
 * EngineExplanationCard (frontend/src/app/algorithm-explain), which is
 * dense reconciliation-math tooling aimed at checking the engine's own
 * working, not something to hand a non-technical user mid-team-pick.
 * This shows the same real numbers (bookmaker/fixture/form contribution,
 * availability, recent-form trend) in plain language instead.
 */
export default function PlayerInfoPanel({
  gameSlug,
  gamePlayerId,
  onBack,
  fixtures,
}: {
  gameSlug: string;
  gamePlayerId: number;
  onBack: () => void;
  // Optional colour-coded upcoming-fixture pills (EFL Fantasy today - see
  // EFLFantasyBoard.tsx's fixtureTilesFor). Omitted by games that don't
  // pass it, so this stays a no-op change for them.
  fixtures?: { label: string; colorClass: string }[];
}) {
  // undefined = loading, null = no projection exists yet for this player
  const [data, setData] = useState<EngineExplanation | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    getPlayerExplanation(gameSlug, gamePlayerId).then((result) => {
      if (!cancelled) setData(result);
    });
    return () => {
      cancelled = true;
    };
  }, [gameSlug, gamePlayerId]);

  return (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
      <button onClick={onBack} className="text-xs font-medium text-sky-400 hover:text-sky-300">
        ← Back to player pool
      </button>

      {data === undefined && <p className="mt-4 text-sm text-navy-400">Loading...</p>}
      {data === null && <p className="mt-4 text-sm text-navy-400">No projection available yet for this player.</p>}

      {data && (
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">{data.fullName}</h2>
            <p className="text-xs text-navy-400">
              {data.position} · {data.teamName} · £{data.price.toFixed(1)}m{data.gameweek != null ? ` · GW${data.gameweek}` : ""}
            </p>
            {fixtures && fixtures.length > 0 && (
              <div className="mt-1.5 flex items-center gap-1">
                <span className="text-[10px] uppercase tracking-wide text-navy-500">Upcoming</span>
                {fixtures.map((f, i) => (
                  <span key={i} className={`rounded px-1 py-0.5 text-[9px] font-bold text-white ${f.colorClass}`}>
                    {f.label}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg bg-navy-950 px-3 py-2">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Projected Points</p>
              <p className="text-xl font-bold text-sky-400">{data.finalScore.toFixed(1)}</p>
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${confidenceTone(data.dataConfidence.label)}`}>
              {data.dataConfidence.label} confidence
            </span>
          </div>

          {data.explanation && <p className="text-sm text-navy-200">{data.explanation}</p>}

          <div className="rounded-lg border border-navy-800 bg-navy-950 p-3 text-xs text-navy-300">
            <p className="font-semibold text-white">Availability</p>
            {data.opportunityDetail ? (
              <>
                <p className="mt-1">
                  Chance of starting: {(data.opportunityDetail.pStart * 100).toFixed(0)}% · Chance of appearing at all:{" "}
                  {(data.opportunityDetail.pAppear * 100).toFixed(0)}%
                </p>
                <p className="mt-0.5 text-navy-500">
                  Expected minutes: {data.expectedMinutesFraction != null ? `${Math.round(data.expectedMinutesFraction * 90)} min` : "—"}
                </p>
              </>
            ) : (
              <p className="mt-1">
                Status: {data.status.lineup ?? "unknown"} ({data.status.status ?? "unknown"}) · ×{data.status.multiplier.toFixed(2)}
              </p>
            )}
          </div>

          {data.moduleDetail &&
            MODULAR_STATS.map((stat) => {
              const detail = data.moduleDetail?.[stat];
              if (!detail) return null;
              const contributingModules = MODULE_NAMES.filter(
                (m) => detail.modules[m].rawRate != null && detail.modules[m].configuredWeight > 0
              );
              if (contributingModules.length === 0) return null;
              return (
                <div key={stat} className="rounded-lg border border-navy-800 bg-navy-950 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-white">{STAT_DISPLAY_NAMES[stat]}</p>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${dataSourceTone(detail.bookmakerDataSource)}`}
                      title={dataSourceLabel(detail.bookmakerDataSource)}
                    >
                      Bookies: {detail.bookmakerDataSource}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-col gap-1">
                    {contributingModules.map((m) => {
                      const entry = detail.modules[m];
                      return (
                        <div key={m} className="flex items-center justify-between text-[11px] text-navy-300">
                          <span>{MODULE_DISPLAY_NAMES[m]}</span>
                          <span className="text-navy-400">
                            {entry.weightedPointContribution != null
                              ? `${entry.weightedPointContribution >= 0 ? "+" : ""}${entry.weightedPointContribution.toFixed(2)} pts`
                              : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

          {data.recentFormDetail && (data.recentFormDetail.goal || data.recentFormDetail.assist) && (
            <div className="rounded-lg border border-navy-800 bg-navy-950 p-3 text-xs">
              <p className="font-semibold text-white">Recent Form</p>
              <p className="mt-1 text-navy-500">vs. this player&apos;s own established rate, last {data.recentFormDetail.lookbackGameweeks} gameweeks</p>
              <div className="mt-1.5 flex flex-col gap-1">
                {(["goal", "assist"] as const).map((s) => {
                  const d = data.recentFormDetail![s];
                  if (!d) return null;
                  return (
                    <div key={s} className="flex items-center justify-between text-navy-300">
                      <span>{s === "goal" ? "Goals" : "Assists"}</span>
                      <span className={d.priorPull > 0 ? "text-emerald-400" : d.priorPull < 0 ? "text-red-400" : "text-navy-400"}>
                        {d.priorPull > 0 ? "↑ trending up" : d.priorPull < 0 ? "↓ trending down" : "→ steady"} (
                        {d.finalShrunkRate.toFixed(2)}/90 vs {d.historicalPriorRate.toFixed(2)}/90 usual)
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
