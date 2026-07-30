import {
  MODULE_NAMES,
  MODULE_DISPLAY_NAMES,
  MODULAR_STATS,
  STAT_DISPLAY_NAMES,
  confidenceTone,
  dataSourceTone,
  dataSourceLabel,
  type EngineExplanation,
  type OpportunityDetail,
  type RecentFormDetail,
  type RecentFormStatDetail,
} from "@/lib/engineExplainability";

function fmt(value: number | null | undefined, digits = 3): string {
  return value == null ? "—" : value.toFixed(digits);
}

function fmtPts(value: number | null | undefined): string {
  if (value == null) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function structuralConfidenceTone(score: number): string {
  if (score >= 70) return "bg-emerald-950 text-emerald-400";
  if (score >= 40) return "bg-amber-950 text-amber-400";
  return "bg-red-950 text-red-400";
}

function OpportunityModelSection({ opp }: { opp: OpportunityDetail }) {
  const flags: string[] = [];
  if (opp.liveStatusApplied) flags.push("Live status applied");
  if (opp.isCongested) flags.push("Rotation/congestion discount applied");
  if (opp.isTransferred) flags.push("Transferred - wider shrinkage window");
  return (
    <div className="rounded-xl border border-sky-800/60 bg-navy-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">Opportunity Model - how much of this fixture they&apos;re expected to be on the pitch</h3>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${structuralConfidenceTone(opp.structuralConfidence)}`}>
          Structural Confidence: {opp.structuralConfidence}%
        </span>
      </div>
      <p className="mt-1 text-xs text-navy-500">
        Scoped strictly to playing time - never attacking quality, tactical role or goal/assist likelihood (those stay
        event-rate questions, handled by the modules below). Drives expected_minutes_fraction above plus the
        appearance / 60+ minutes / full match scoring stats.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm text-navy-200 sm:grid-cols-4">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">P(start)</p>
          <p className="font-medium text-white">{fmt(opp.pStart, 3)}</p>
          <p className="text-xs text-navy-500">Historical: {fmt(opp.pStartHistorical, 3)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">P(appear | didn&apos;t start)</p>
          <p className="font-medium text-white">{fmt(opp.pAppearIfNotStarted, 3)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">Opportunity if starting</p>
          <p className="font-medium text-white">{fmt(opp.opportunityIfStart, 1)} min</p>
          <p className="text-xs text-navy-500">Early-sub risk: {opp.earlySubstitutionRisk != null ? `${(opp.earlySubstitutionRisk * 100).toFixed(0)}%` : "N/A"}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">Opportunity if sub</p>
          <p className="font-medium text-white">{fmt(opp.opportunityIfSub, 1)} min</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">Start-share proxy</p>
          <p className="font-medium text-white">{fmt(opp.startShareProxy, 2)}</p>
          <p className="text-xs text-navy-500">Inferred from avg minutes/appearance - no real start/sub label exists yet</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">P(appear at all)</p>
          <p className="font-medium text-white">{fmt(opp.pAppear, 3)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">P(60+ minutes)</p>
          <p className="font-medium text-white">{fmt(opp.p60Plus, 3)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">P(full 90)</p>
          <p className="font-medium text-white">{fmt(opp.pFullMatch, 3)}</p>
        </div>
      </div>

      {flags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {flags.map((f) => (
            <span key={f} className="rounded-full bg-sky-950 px-2 py-0.5 text-[10px] font-medium text-sky-300">
              {f}
            </span>
          ))}
        </div>
      )}

      <p className="mt-3 border-t border-navy-800 pt-2 text-xs text-navy-500">
        Football uncertainty (rotation/tactical volatility, distinct from the structural confidence above):{" "}
        {opp.footballUncertainty != null ? `${opp.footballUncertainty}%` : "Not yet modelled - planned for a later phase, once a team-level rotation model exists to measure it from."}
      </p>
    </div>
  );
}

const RECENT_FORM_STAT_LABELS: Record<"goal" | "assist", string> = { goal: "Goals", assist: "Assists" };

function RecentFormStatCard({ label, d }: { label: string; d: RecentFormStatDetail }) {
  return (
    <div className="rounded-lg border border-navy-800 bg-navy-950 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-white">{label}</span>
        <span className="text-xs text-navy-400">
          {d.observedAppearancesForStat} real observation{d.observedAppearancesForStat === 1 ? "" : "s"} (GW{d.oldestGameweekUsed}-{d.newestGameweekUsed})
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-navy-200 sm:grid-cols-4">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">Final (shrunk) rate</p>
          <p className="font-medium text-white">{fmt(d.finalShrunkRate, 3)}/90</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">Historical prior</p>
          <p className="font-medium text-white">{fmt(d.historicalPriorRate, 3)}/90</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">Raw (recency-weighted)</p>
          <p className="font-medium text-white">{fmt(d.rawRecencyWeightedRate, 3)}/90</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-navy-500">Raw (unweighted)</p>
          <p className="font-medium text-white">{fmt(d.rawUnweightedRate, 3)}/90</p>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-navy-800">
          <div className="h-full bg-sky-500" style={{ width: `${d.observedWeight * 100}%` }} />
        </div>
        <span className="whitespace-nowrap text-[10px] text-navy-500">
          {(d.observedWeight * 100).toFixed(0)}% observed / {(d.priorWeight * 100).toFixed(0)}% prior
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-navy-500">
        effective_games90: {fmt(d.effectiveGames90, 2)} ({fmt(d.effectiveWeightedMinutes, 0)} recency-weighted minutes)
        {" · "}
        prior_pull:{" "}
        <span className={d.priorPull < 0 ? "text-red-400" : d.priorPull > 0 ? "text-emerald-400" : "text-navy-500"}>
          {fmtPts(d.priorPull)}/90
        </span>
        {" "}(shrinkage's net effect vs. the raw observed rate - negative pulls down, positive pulls up, 0 at k_recent=0)
      </p>
    </div>
  );
}

function RecentFormSection({ rf }: { rf: RecentFormDetail }) {
  const stats = (["goal", "assist"] as const).filter((s) => rf[s] != null);
  return (
    <div className="rounded-xl border border-emerald-800/60 bg-navy-900 p-4">
      <h3 className="text-sm font-semibold text-white">Recent Form - deviation from this player&apos;s own established baseline</h3>
      <p className="mt-1 text-xs text-navy-500">
        Recency-weighted (calendar gameweek distance, decay={rf.decay}, lookback={rf.lookbackGameweeks} GWs) then shrunk toward this
        player&apos;s OWN Historical Performance rate (k_recent={rf.kRecent} equivalent 90-minute games) - never a position average. A
        stat below is shown only when real observations exist for it this window; goal and assist availability are independent.
      </p>

      {stats.length === 0 ? (
        <p className="mt-3 text-xs text-navy-500">No real gameweek data in this window yet for either stat.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {stats.map((s) => (
            <RecentFormStatCard key={s} label={RECENT_FORM_STAT_LABELS[s]} d={rf[s]!} />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-navy-800 pt-2 text-[11px] text-navy-500">
        <span>Real appearances in window (any stat): {rf.playingAppearancesInWindow}</span>
        <span>Decay basis: {rf.decayBasis}</span>
        <span>
          Recent schedule strength:{" "}
          {rf.scheduleStrength != null
            ? fmt(rf.scheduleStrength, 2)
            : "Not available - no point-in-time-correct historical fixture-strength data exists yet (tracked for future capture, not fabricated)"}
        </span>
      </div>
    </div>
  );
}

function ReconciliationRow({ label, expected, actual, difference, tolerance, passed }: {
  label: string; expected: number; actual: number; difference: number; tolerance: number; passed: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 text-xs ${passed ? "border-navy-800 bg-navy-950" : "border-red-800 bg-red-950/40"}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium text-white">{label}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${passed ? "bg-emerald-950 text-emerald-400" : "bg-red-900 text-red-300"}`}>
          {passed ? "Reconciles" : "FAILED"}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-4 gap-2 text-navy-300">
        <span>Expected: {expected.toFixed(4)}</span>
        <span>Actual: {actual.toFixed(4)}</span>
        <span>Diff: {difference.toFixed(4)}</span>
        <span>Tolerance: ±{tolerance}</span>
      </div>
    </div>
  );
}

export default function EngineExplanationCard({ data }: { data: EngineExplanation }) {
  const reconciliationFailed = data.reconciliation != null && (!data.reconciliation.primaryFixtureCheck.passed || !data.reconciliation.fullScoreCheck.passed);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">{data.fullName}</h2>
            <p className="text-sm text-navy-400">
              {data.position} · {data.teamName} · £{data.price.toFixed(1)}m{data.gameweek != null ? ` · GW${data.gameweek}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Final Projected Score</p>
              <p className="text-2xl font-bold text-sky-400">{data.finalScore.toFixed(2)}</p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${confidenceTone(data.dataConfidence.label)}`}>
              Data Confidence: {data.dataConfidence.label} ({data.dataConfidence.score}%)
            </span>
          </div>
        </div>
        {data.explanation && <p className="mt-3 text-sm text-navy-200">{data.explanation}</p>}
        <p className="mt-2 text-[11px] text-navy-500">
          Data Confidence reflects source coverage, sample size and module availability - NOT predictive accuracy. Real,
          calibrated predictive confidence can only come from graded results (Performance Lab).
        </p>
      </div>

      {reconciliationFailed && (
        <div className="rounded-xl border border-red-700 bg-red-950/50 p-4">
          <p className="text-sm font-semibold text-red-300">⚠ This projection does not fully reconcile - treat with caution</p>
          <p className="mt-1 text-xs text-red-300/80">
            One or both independent reconciliation checks failed. See the Reconciliation section below for detail.
          </p>
        </div>
      )}

      {/* Scope + availability */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-navy-400">Availability</p>
          <div className="mt-2 flex flex-col gap-1 text-sm text-navy-200">
            <span>Expected minutes factor: {fmt(data.expectedMinutesFraction, 3)} ({data.expectedMinutesFraction != null ? `${Math.round(data.expectedMinutesFraction * 90)} min` : "—"})</span>
            {data.opportunityDetail ? (
              <span className="text-xs text-navy-500">
                Post-hoc status multiplier retired for this game - availability is computed directly inside the
                Opportunity Model below (×{data.status.multiplier.toFixed(2)} shown for reference only).
              </span>
            ) : (
              <span>Status multiplier: ×{data.status.multiplier.toFixed(2)}</span>
            )}
            <span className="text-xs text-navy-500">
              Lineup: {data.status.lineup ?? "unknown"} · Status: {data.status.status ?? "unknown"}
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-navy-400">Breakdown Scope</p>
          <p className="mt-2 text-sm text-navy-200">
            {data.moduleDetailScope.fixtureCount > 1
              ? `Primary Fixture Breakdown (1 of ${data.moduleDetailScope.fixtureCount} fixtures this period) - the module detail below covers only the first fixture. The final score includes ${data.moduleDetailScope.fixtureCount - 1} additional fixture(s) not decomposed here.`
              : "Primary Fixture Breakdown - this player has exactly one fixture this scoring period, so this covers the full projection."}
          </p>
        </div>
      </div>

      {/* Opportunity Model - playing-time-only breakdown (Phase A) */}
      {data.opportunityDetail && <OpportunityModelSection opp={data.opportunityDetail} />}

      {/* Recent Form - recency-weighted, historical-shrunk event-rate deviation */}
      {data.recentFormDetail && <RecentFormSection rf={data.recentFormDetail} />}

      {/* Per-stat module tables */}
      {data.moduleDetail &&
        MODULAR_STATS.map((stat) => {
          const detail = data.moduleDetail?.[stat];
          if (!detail) return null;
          return (
            <div key={stat} className="rounded-xl border border-navy-700 bg-navy-900 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-white">{STAT_DISPLAY_NAMES[stat]}</h3>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-navy-400">Final blended rate: <span className="text-white">{fmt(detail.finalRate, 4)}</span>/match</span>
                  <span className="text-navy-400">Points each: <span className="text-white">{detail.pointsEach ?? "N/A"}</span></span>
                  <span className={`rounded-full px-2 py-0.5 font-medium ${dataSourceTone(detail.bookmakerDataSource)}`} title={dataSourceLabel(detail.bookmakerDataSource)}>
                    Bookmaker: {detail.bookmakerDataSource}
                  </span>
                </div>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead>
                    <tr className="text-navy-500">
                      <th className="pb-1.5 pr-3 font-medium">Module</th>
                      <th className="pb-1.5 pr-3 font-medium">Raw Rate</th>
                      <th className="pb-1.5 pr-3 font-medium">Configured Weight</th>
                      <th className="pb-1.5 pr-3 font-medium">Effective Weight</th>
                      <th className="pb-1.5 pr-3 font-medium">Weighted Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {MODULE_NAMES.map((module) => {
                      const m = detail.modules[module];
                      const unavailable = m.rawRate == null;
                      return (
                        <tr key={module} className={`border-t border-navy-800 ${unavailable ? "text-navy-600" : "text-navy-200"}`}>
                          <td className="py-1.5 pr-3">{MODULE_DISPLAY_NAMES[module]}</td>
                          <td className="py-1.5 pr-3">{unavailable ? "N/A" : fmt(m.rawRate, 4)}</td>
                          <td className="py-1.5 pr-3">{(m.configuredWeight * 100).toFixed(0)}%</td>
                          <td className="py-1.5 pr-3">{unavailable ? "0%" : `${(m.effectiveWeight * 100).toFixed(0)}%`}</td>
                          <td className="py-1.5 pr-3 font-medium">{m.weightedPointContribution == null ? "N/A" : fmtPts(m.weightedPointContribution)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Scenario scores - explicitly separate, differently labelled */}
              <div className="mt-3 border-t border-navy-800 pt-3">
                <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">
                  Module Scenario Score - full projected points if this module ALONE had decided goals/assists/clean
                  sheets (everything else - saves, cards, bonus - unchanged). Not additive across modules; not the same
                  as Weighted Contribution above.
                </p>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-navy-300">
                  {MODULE_NAMES.map((module) => (
                    <span key={module}>
                      {MODULE_DISPLAY_NAMES[module]}: <span className="font-medium text-white">{data.moduleScenarios[module] == null ? "N/A" : data.moduleScenarios[module]!.toFixed(2)}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          );
        })}

      {/* Reconciliation */}
      {data.reconciliation && (
        <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
          <h3 className="text-sm font-semibold text-white">Reconciliation</h3>
          <p className="mt-1 text-xs text-navy-500">
            Two independent checks - neither compares a value against itself. Both must pass for this projection to be
            considered internally consistent.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <ReconciliationRow label="Primary fixture check (module detail vs. original pricing)" {...data.reconciliation.primaryFixtureCheck} />
            <ReconciliationRow label="Full score check (re-summed fixtures × availability vs. final score)" {...data.reconciliation.fullScoreCheck} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-navy-300 sm:grid-cols-3">
            <span>Modular sum: {data.reconciliation.modularSum.toFixed(3)}</span>
            <span>Non-modular sum: {data.reconciliation.nonModularSum.toFixed(3)}</span>
            <span>Bonus: {data.reconciliation.bonus.toFixed(3)}</span>
            <span>Primary fixture subtotal: {data.reconciliation.primaryFixtureSubtotal.toFixed(3)}</span>
            <span>Additional fixtures: {data.reconciliation.additionalFixturesSubtotal.toFixed(3)}</span>
            <span>Pre-availability total: {data.reconciliation.preAvailabilityTotal.toFixed(3)}</span>
            <span>Availability multiplier: ×{data.reconciliation.availabilityMultiplier.toFixed(2)}</span>
            <span className="font-medium text-white">Final score: {data.reconciliation.finalScore.toFixed(3)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
