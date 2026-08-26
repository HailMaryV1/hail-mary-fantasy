"use client";

import { useEffect, useState } from "react";
import {
  getPlayerExplanation,
  getPlayerExplanationForGameweek,
  getPlayerProjectionTrendAction,
  getPlayerRealStatsAction,
  type PlayerRealStats,
} from "@/lib/playerExplanationActions";
import {
  MODULAR_STATS,
  EXPECTED_STAT_DISPLAY_NAMES,
  confidenceTone,
  dataSourceTone,
  dataSourceLabel,
  competitionLabel,
  type EngineExplanation,
} from "@/lib/engineExplainability";
import { getTeamColors } from "@/lib/teamColors";
import HailMaryRatingBadge from "./HailMaryRatingBadge";
import TrendChart from "./TrendChart";
import type { TrendPoint } from "@/lib/projectionTrend";

function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

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
  viewedGameweek,
  horizon,
}: {
  gameSlug: string;
  gamePlayerId: number;
  onBack: () => void;
  // Optional colour-coded upcoming-fixture pills (EFL Fantasy today - see
  // EFLFantasyBoard.tsx's fixtureTilesFor). Omitted by games that don't
  // pass it, so this stays a no-op change for them.
  fixtures?: { label: string; colorClass: string }[];
  // Explicit gameweek override (EFL Fantasy only, 2026-08-21 user report) -
  // EFL Fantasy's own per-player locking (eflFixtureLocking.ts) can hold a
  // gameweek "current" after the shared player_projection_summary view's
  // own min-kickoff current_gw has already moved on, which showed the
  // wrong gameweek's projection/fixture here even while the pool/squad
  // board correctly stayed put. Omitted by every other game, which keeps
  // reading whatever the shared view considers current, unchanged.
  viewedGameweek?: number;
  // Which Target Score horizon (1/2/3/5) the caller is currently viewing
  // (2026-08-23 user request - /ratings' horizon selector) - threaded
  // into the downloadable card link only, so it can show that horizon's
  // breakdown. Omitted everywhere else (no horizon concept outside the
  // Ratings page), same no-op-elsewhere pattern as `fixtures` above.
  horizon?: number;
}) {
  // undefined = loading, null = no projection exists yet for this player
  const [data, setData] = useState<EngineExplanation | null | undefined>(undefined);
  const [trend, setTrend] = useState<TrendPoint[] | undefined>(undefined);
  const [realStats, setRealStats] = useState<PlayerRealStats | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    setTrend(undefined);
    setRealStats(undefined);
    const explanationPromise =
      viewedGameweek != null ? getPlayerExplanationForGameweek(gameSlug, gamePlayerId, viewedGameweek) : getPlayerExplanation(gameSlug, gamePlayerId);
    explanationPromise.then((result) => {
      if (cancelled) return;
      setData(result);
      if (result?.gameweek != null) {
        getPlayerProjectionTrendAction(gamePlayerId, result.gameweek).then((points) => {
          if (!cancelled) setTrend(points);
        });
      }
    });
    getPlayerRealStatsAction(gamePlayerId).then((result) => {
      if (!cancelled) setRealStats(result);
    });
    return () => {
      cancelled = true;
    };
  }, [gameSlug, gamePlayerId, viewedGameweek]);

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
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-base font-semibold text-white">{data.fullName}</h2>
              <a
                href={`/api/player-card?gameSlug=${gameSlug}&gamePlayerId=${gamePlayerId}${viewedGameweek != null ? `&gameweek=${viewedGameweek}` : ""}${horizon != null ? `&horizon=${horizon}` : ""}`}
                download={`hail-mary-${data.fullName.toLowerCase().replace(/\s+/g, "-")}.png`}
                className="flex shrink-0 items-center gap-1 rounded-full border border-navy-700 bg-navy-950 px-2.5 py-1 text-[10px] font-semibold text-sky-400 hover:border-sky-500 hover:text-sky-300"
                title="Download a shareable projection card for socials"
              >
                ⬇ Card
              </a>
            </div>
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

          {data.primaryFixture && (
            <div className="flex items-center gap-2 rounded-lg border border-navy-800 bg-navy-950 px-3 py-2 text-xs">
              {data.primaryFixture.opponentTeamName && (
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
                  style={{
                    backgroundColor: getTeamColors(data.primaryFixture.opponentTeamName).primary,
                    color: getTeamColors(data.primaryFixture.opponentTeamName).secondary,
                  }}
                >
                  {getTeamColors(data.primaryFixture.opponentTeamName).abbr}
                </span>
              )}
              <div>
                <p className="font-semibold text-white">
                  {data.primaryFixture.isHome ? "vs " : "at "}
                  {data.primaryFixture.opponentTeamName ?? "Unknown opponent"}
                </p>
                <p className="text-navy-500">
                  {formatKickoff(data.primaryFixture.kickoffAt)} · {competitionLabel(data.primaryFixture.competition)}
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg bg-navy-950 px-3 py-2">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Hail Mary Rating</p>
              <HailMaryRatingBadge rating={data.rating} size="lg" />
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${confidenceTone(data.dataConfidence.label)}`}>
              {data.dataConfidence.label} confidence
            </span>
          </div>

          {realStats && (
            <div className="rounded-lg border border-navy-800 bg-navy-950 p-3 text-xs">
              <p className="font-semibold text-white">Fantasy Stats</p>
              <p className="mt-0.5 text-navy-500">
                {realStats.season ? `Real ${realStats.season} season results, not a projection.` : "Real results, not a projection."}
              </p>
              {realStats.lastGwPoints != null && (
                <div className="mt-2 flex items-center justify-between rounded bg-navy-900 px-2 py-1.5">
                  <span className="text-navy-300">GW{realStats.lastGw} points</span>
                  <span className="font-semibold text-white">{realStats.lastGwPoints.toFixed(1)}</span>
                </div>
              )}
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {(
                  [
                    ["Total Pts", realStats.totalPoints],
                    ["Minutes", realStats.minutesPlayed],
                    ["Goals", realStats.goals],
                    ["Assists", realStats.assists],
                    ["Clean Sheets", realStats.cleanSheets],
                    ["Saves", realStats.saves],
                    ["Tackles", realStats.tackles],
                    // Clearances/Blocks/Interceptions/Key Passes are only
                    // ever real for EFL Fantasy (confirmed via
                    // game_scoring_rules - dreamteam/fanteam/cloudff don't
                    // score these at all) - showing them on Premier League
                    // player cards was real user-reported clutter.
                    ...(gameSlug === "eflfantasy"
                      ? ([
                          ["Clearances", realStats.clearances],
                          ["Blocks", realStats.blocks],
                          ["Interceptions", realStats.interceptions],
                          ["Key Passes", realStats.keyPasses],
                        ] as [string, number | null][])
                      : []),
                    ["Shots on Target", realStats.shotsOnTarget],
                  ] as [string, number | null][]
                )
                  .filter(([, value]) => value != null)
                  .map(([label, value]) => (
                    <div key={label} className="rounded bg-navy-900 px-2 py-1.5 text-center">
                      <p className="text-sm font-semibold text-white">{value}</p>
                      <p className="text-[9px] uppercase tracking-wide text-navy-500">{label}</p>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Gated on raw score, not rating - rating is never truly "0"
              (worst case is 1), so gating on it would keep this section
              visible even for a player with zero real projection history.
              The chart itself displays rating, per hailMaryRating.ts. */}
          {trend && trend.some((p) => p.score > 0) && (
            <div className="rounded-lg border border-navy-800 bg-navy-950 p-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Rating trend</p>
              <TrendChart points={trend.map((p) => ({ label: `GW${p.gameweek}`, value: p.rating ?? 0 }))} />
            </div>
          )}

          {data.additionalFixtures.count > 0 && (
            <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 p-2.5 text-xs text-amber-200">
              <p className="font-semibold">
                +{data.additionalFixtures.combinedContribution.toFixed(1)} more if also selected for{" "}
                {data.additionalFixtures.fixtures.map((fx) => competitionLabel(fx.competition)).join(" & ")} - total ~
                {(data.finalScore + data.additionalFixtures.combinedContribution).toFixed(1)} across both games
              </p>
              <p className="mt-0.5 text-amber-300/70">
                Projected Points above ({data.finalScore.toFixed(1)}) is for the primary fixture only. This extra
                amount is added on top, not included in it, and only applies if actually picked for the cup game too
                - rotation risk already discounts it for that uncertainty.
              </p>
            </div>
          )}

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

          {data.moduleDetail && (
            <div className="rounded-lg border border-navy-800 bg-navy-950 p-3 text-xs">
              <p className="font-semibold text-white">The Bookies Say</p>
              <p className="mt-0.5 text-navy-500">Real market prices, priced through this game&apos;s real scoring matrix.</p>
              <div className="mt-2 flex flex-col gap-1.5">
                {MODULAR_STATS.map((stat) => {
                  const detail = data.moduleDetail?.[stat];
                  if (!detail || detail.pointsEach == null) return null;
                  const count = detail.finalRate * (data.expectedMinutesFraction ?? 0);
                  const contribution = count * detail.pointsEach;
                  return (
                    <div key={stat} className="flex items-center justify-between text-navy-300">
                      <span className="flex items-center gap-1.5">
                        {EXPECTED_STAT_DISPLAY_NAMES[stat]}
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${dataSourceTone(detail.bookmakerDataSource)}`}
                          title={dataSourceLabel(detail.bookmakerDataSource)}
                        >
                          {detail.bookmakerDataSource}
                        </span>
                      </span>
                      <span className="text-navy-400">
                        {count.toFixed(2)} × {detail.pointsEach}pt = {contribution >= 0 ? "+" : ""}
                        {contribution.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
                {data.reconciliation && (
                  <div className="mt-0.5 flex items-center justify-between border-t border-navy-800 pt-1.5 text-navy-300">
                    <span>Other scoring (appearance, cards, bonus...)</span>
                    <span className="text-navy-400">
                      +{(data.reconciliation.nonModularSum + data.reconciliation.bonus).toFixed(2)}
                    </span>
                  </div>
                )}
                <div className="mt-0.5 flex items-center justify-between border-t border-navy-800 pt-1.5 font-semibold text-white">
                  <span>Total</span>
                  <span>{data.finalScore.toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}

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
