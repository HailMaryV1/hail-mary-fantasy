"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { applyRecommendation } from "../squads/actions";
import AskMaryWatchlistButton from "./AskMaryWatchlistButton";
import FormPill from "../FormPill";
import type { GameweekPlanStep, BundleTransfer } from "@/lib/askMaryEngine";

const RISK_TONE: Record<BundleTransfer["risk"], string> = {
  low: "bg-emerald-950 text-emerald-400",
  medium: "bg-amber-950 text-amber-400",
  high: "bg-red-950 text-red-400",
};

/**
 * One step of Mary's sequential gameweek plan - collapsed by default (same
 * pattern as SwingTeamRow.tsx: a summary row that expands into detail),
 * since a full plan is 3 of these stacked and showing everything expanded
 * at once is what made the old 3-BundleCard layout take over the page.
 * Retires BundleCard.tsx - the per-leg detail rendering below is carried
 * over from it unchanged, just nested inside the collapse.
 */
export default function GameweekPlanRow({
  step,
  squadId,
  gameId,
}: {
  step: GameweekPlanStep;
  squadId: number;
  gameId: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedLegIdx, setExpandedLegIdx] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const netGain = step.transfers.reduce((sum, t) => sum + t.pointsGain + t.costPoints, 0);

  function handleApply() {
    setError(null);
    startTransition(async () => {
      const result = await applyRecommendation({
        squadId,
        transfers: step.transfers.map((t) => ({ outGamePlayerId: t.outGamePlayerId, inGamePlayerId: t.inGamePlayerId })),
      });
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div className="rounded-xl border border-navy-700 bg-navy-900">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-start justify-between gap-3 p-4 text-left hover:bg-navy-800/60"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-navy-800 px-2 py-0.5 text-xs font-semibold text-white">GW{step.gameweek}</span>
            {!step.hold && (
              <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-semibold text-emerald-400">
                {step.transfers.length} transfer{step.transfers.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-navy-200">{step.writeup}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!step.hold && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${netGain >= 0 ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"}`}>
              {netGain >= 0 ? "+" : ""}
              {netGain.toFixed(1)}
            </span>
          )}
          <span className={`text-navy-400 transition-transform ${expanded ? "rotate-90" : ""}`}>▶</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-navy-800 p-4">
          {step.hold ? (
            <p className="text-sm text-emerald-300">Nothing clears its own cost this gameweek - holding is the right call.</p>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {step.transfers.map((t, i) => (
                  <div key={`${t.outGamePlayerId}-${t.inGamePlayerId}`}>
                    {i > 0 && <p className="mb-2 text-center text-xs text-navy-500">↓</p>}
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Transfer {i + 1}</p>
                      {t.pairedLegIndex != null && (
                        <span
                          className="rounded-full bg-sky-950 px-2 py-0.5 text-[10px] font-medium text-sky-300"
                          title="These two transfers are evaluated together as one bundle - the combined gain across both is what has to clear the cost, not each one alone."
                        >
                          🔗 paired with Transfer {t.pairedLegIndex + 1}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-navy-400">{t.position} ·</span>
                      <span className="text-white">{t.outName}</span>
                      <span className="text-navy-500">(£{t.outPrice.toFixed(1)}m)</span>
                      <span className="text-navy-500">→</span>
                      <span className="inline-flex items-center font-medium text-white">
                        {t.inName}
                        <FormPill status={t.inFormStatus} />
                      </span>
                      <span className="text-navy-500">(£{t.inPrice.toFixed(1)}m)</span>
                      <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${RISK_TONE[t.risk]}`}>{t.risk} risk</span>
                      <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[10px] font-medium text-navy-300">{t.confidence}% confidence</span>
                    </div>
                    {t.pairedLegIndex != null && (
                      <p className="mt-1 text-xs text-sky-300">
                        {t.pointsGain < 0
                          ? `Sold to help fund Transfer ${t.pairedLegIndex + 1}'s upgrade - not a downgrade in isolation, a budget reallocation.`
                          : `Partly funded by Transfer ${t.pairedLegIndex + 1}'s sale, freeing up the budget to land this upgrade.`}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-navy-300">
                      <span>Gain: {t.pointsGain >= 0 ? "+" : ""}{t.pointsGain.toFixed(1)} pts</span>
                      <span>Cost: {t.costPoints === 0 ? "free" : `${t.costPoints} pts`}</span>
                      <span>Mary Move Score: {t.overall}/100</span>
                      <AskMaryWatchlistButton
                        gameId={gameId}
                        gamePlayerId={t.inGamePlayerId}
                        defaultReasons={["buy_target"]}
                        notes={`Added from ASK MARY - GW${step.gameweek} plan. ${t.reasons[0]?.text ?? ""}`.trim()}
                      />
                    </div>
                    {t.alternatives && t.alternatives.length > 0 && (
                      <p className="mt-1 text-xs text-sky-300">
                        Equally strong alternative: {t.alternatives[0].outName} → {t.alternatives[0].inName} (£{t.alternatives[0].inPrice.toFixed(1)}m,{" "}
                        {t.alternatives[0].pointsGain >= 0 ? "+" : ""}
                        {t.alternatives[0].pointsGain.toFixed(1)} pts)
                      </p>
                    )}
                    <button
                      onClick={() => setExpandedLegIdx(expandedLegIdx === i ? null : i)}
                      className="mt-1 text-xs font-medium text-sky-400 hover:text-sky-300"
                    >
                      {expandedLegIdx === i ? "Hide detail" : "Why Mary recommends this"}
                    </button>
                    {expandedLegIdx === i && (
                      <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-400">Reasons</p>
                          <ul className="mt-1 list-inside list-disc text-xs text-navy-300">
                            {t.reasons.map((r) => (
                              <li key={r.code}>{r.text}</li>
                            ))}
                          </ul>
                        </div>
                        {t.warnings.length > 0 && (
                          <div>
                            <p className="text-[10px] font-medium uppercase tracking-wide text-amber-400">Risks</p>
                            <ul className="mt-1 list-inside list-disc text-xs text-navy-300">
                              {t.warnings.map((w) => (
                                <li key={w.code}>{w.text}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-3 rounded-lg border border-navy-800 bg-navy-950 p-3">
                <p className="text-[10px] font-medium uppercase tracking-wide text-sky-400">Resulting squad</p>
                <p className="mt-1 text-sm text-navy-200">
                  £{step.budgetRemainingAfter.toFixed(1)}m in the bank · {step.resultingSquadExpectedPoints.toFixed(1)} pts projected for GW{step.gameweek}
                </p>
              </div>

              {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={handleApply}
                  disabled={isPending}
                  className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-navy-950 hover:bg-sky-400 disabled:opacity-40"
                >
                  {isPending ? "Applying..." : "Apply Recommendation"}
                </button>
                <Link
                  href={`/compare?ids=${step.transfers.map((t) => `${t.outGamePlayerId},${t.inGamePlayerId}`).join(",")}`}
                  className="rounded-lg border border-navy-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800"
                >
                  Compare Players
                </Link>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
