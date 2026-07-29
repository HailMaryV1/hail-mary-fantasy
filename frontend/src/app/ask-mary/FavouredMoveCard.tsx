"use client";

import { useState, useTransition } from "react";
import { applyRecommendation } from "../squads/actions";
import FormPill from "../FormPill";
import type { FavouredMove, BundleTransfer } from "@/lib/askMaryEngine";

const RISK_TONE: Record<BundleTransfer["risk"], string> = {
  low: "bg-emerald-950 text-emerald-400",
  medium: "bg-amber-950 text-amber-400",
  high: "bg-red-950 text-red-400",
};

const KIND_TONE: Record<FavouredMove["kind"], string> = {
  quick_win: "bg-sky-950 text-sky-400",
  momentum_3gw: "bg-sky-950 text-sky-400",
  long_term_5gw: "bg-sky-950 text-sky-400",
  hold: "bg-navy-800 text-navy-300",
  prepare_for_target: "bg-violet-950 text-violet-300",
};

/**
 * One of Ask Mary's "5 favoured moves" - a genuinely independent
 * alternative to pick from, not a step in a committed sequence (see
 * GameweekPlanRow for that). Reuses applyRecommendation directly since a
 * favoured move's single transfer leg is exactly what that action already
 * expects - no new server action needed for this feature.
 */
export default function FavouredMoveCard({ move, squadId }: { move: FavouredMove; squadId: number }) {
  const [expanded, setExpanded] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const leg = move.transfers[0];

  function handleApply() {
    if (!leg) return;
    setError(null);
    startTransition(async () => {
      const result = await applyRecommendation({
        squadId,
        transfers: [{ outGamePlayerId: leg.outGamePlayerId, inGamePlayerId: leg.inGamePlayerId }],
      });
      if (result?.error) setError(result.error);
      else setApplied(true);
    });
  }

  return (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${KIND_TONE[move.kind]}`}>{move.label}</span>
        {!move.hold && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              move.projectedGainOverHorizon >= 0 ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
            }`}
          >
            {move.projectedGainOverHorizon >= 0 ? "+" : ""}
            {move.projectedGainOverHorizon.toFixed(1)} pts
          </span>
        )}
      </div>

      {leg ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-navy-400">{leg.position} ·</span>
          <span className="text-white">{leg.outName}</span>
          <span className="text-navy-500">(£{leg.outPrice.toFixed(1)}m)</span>
          <span className="text-navy-500">→</span>
          <span className="inline-flex items-center font-medium text-white">
            {leg.inName}
            <FormPill status={leg.inFormStatus} />
          </span>
          <span className="text-navy-500">(£{leg.inPrice.toFixed(1)}m)</span>
          <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${RISK_TONE[leg.risk]}`}>{leg.risk} risk</span>
        </div>
      ) : (
        <p className="mt-2 text-sm text-navy-200">Make no transfers this gameweek.</p>
      )}

      <p className="mt-2 text-sm text-navy-300">{move.writeup}</p>

      {move.targetPlayer && (
        <p className="mt-1 text-xs text-violet-300">
          Target: {move.targetPlayer.fullName} ({move.targetPlayer.teamName}, £{move.targetPlayer.price.toFixed(1)}m)
        </p>
      )}

      {leg && (
        <>
          <button onClick={() => setExpanded((e) => !e)} className="mt-2 text-xs font-medium text-sky-400 hover:text-sky-300">
            {expanded ? "Hide detail" : "Why Mary suggests this"}
          </button>
          {expanded && (
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-400">Reasons</p>
                <ul className="mt-1 list-inside list-disc text-xs text-navy-300">
                  {leg.reasons.map((r) => (
                    <li key={r.code}>{r.text}</li>
                  ))}
                </ul>
              </div>
              {leg.warnings.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wide text-amber-400">Risks</p>
                  <ul className="mt-1 list-inside list-disc text-xs text-navy-300">
                    {leg.warnings.map((w) => (
                      <li key={w.code}>{w.text}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      {leg && !applied && (
        <button
          onClick={handleApply}
          disabled={isPending}
          className="mt-3 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-navy-950 hover:bg-sky-400 disabled:opacity-40"
        >
          {isPending ? "Applying..." : "Apply this move"}
        </button>
      )}
      {applied && <p className="mt-3 text-xs font-medium text-emerald-400">Applied to your squad.</p>}
    </div>
  );
}
