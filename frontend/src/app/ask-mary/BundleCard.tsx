"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { applyRecommendation } from "../squads/actions";
import AskMaryWatchlistButton from "./AskMaryWatchlistButton";
import type { AskMaryBundle, BundleTransfer } from "@/lib/askMaryEngine";

const RISK_TONE: Record<BundleTransfer["risk"], string> = {
  low: "bg-emerald-950 text-emerald-400",
  medium: "bg-amber-950 text-amber-400",
  high: "bg-red-950 text-red-400",
};

/**
 * One of the 3 "Best Transfer" recommendations (Next GW / Next 3 GW /
 * Next 5 GW). Shows its bundle sequentially (Transfer 1 -> Transfer 2 ->
 * Resulting squad) since a horizon can legally recommend more than one
 * simultaneous transfer - applying is one action for the whole bundle
 * (applyRecommendation), not one call per leg, so a multi-transfer
 * recommendation can never be applied half-legal.
 */
export default function BundleCard({
  label,
  bundle,
  squadId,
  gameId,
}: {
  label: string;
  bundle: AskMaryBundle;
  squadId: number;
  gameId: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  function handleApply() {
    setError(null);
    startTransition(async () => {
      const result = await applyRecommendation({
        squadId,
        transfers: bundle.transfers.map((t) => ({ outGamePlayerId: t.outGamePlayerId, inGamePlayerId: t.inGamePlayerId })),
      });
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">{label}</h3>
        {!bundle.hold && (
          <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-semibold text-emerald-400">
            {bundle.transfers.length} transfer{bundle.transfers.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {bundle.hold ? (
        <p className="mt-3 text-sm text-emerald-300">
          No transfer clears its own cost right now - holding is the right call for this horizon.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-col gap-3">
            {bundle.transfers.map((t, i) => (
              <div key={`${t.outGamePlayerId}-${t.inGamePlayerId}`}>
                {i > 0 && <p className="mb-2 text-center text-xs text-navy-500">↓</p>}
                <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Transfer {i + 1}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-navy-400">{t.position} ·</span>
                  <span className="text-white">{t.outName}</span>
                  <span className="text-navy-500">(£{t.outPrice.toFixed(1)}m)</span>
                  <span className="text-navy-500">→</span>
                  <span className="font-medium text-white">{t.inName}</span>
                  <span className="text-navy-500">(£{t.inPrice.toFixed(1)}m)</span>
                  <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${RISK_TONE[t.risk]}`}>{t.risk} risk</span>
                  <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[10px] font-medium text-navy-300">{t.confidence}% confidence</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-navy-300">
                  <span>Gain: {t.pointsGain >= 0 ? "+" : ""}{t.pointsGain.toFixed(1)} pts</span>
                  <span>Cost: {t.costPoints === 0 ? "free" : `${t.costPoints} pts`}</span>
                  <span>Mary Move Score: {t.overall}/100</span>
                  <AskMaryWatchlistButton
                    gameId={gameId}
                    gamePlayerId={t.inGamePlayerId}
                    defaultReasons={["buy_target"]}
                    notes={`Added from ASK MARY - ${label}. ${t.reasons[0]?.text ?? ""}`.trim()}
                  />
                </div>
                <button
                  onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
                  className="mt-1 text-xs font-medium text-sky-400 hover:text-sky-300"
                >
                  {expandedIdx === i ? "Hide detail" : "Why Mary recommends this"}
                </button>
                {expandedIdx === i && (
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
              £{bundle.budgetRemainingAfter.toFixed(1)}m in the bank · {bundle.resultingSquadExpectedPoints.toFixed(1)} pts projected over this horizon
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
              href={`/compare?ids=${bundle.transfers.map((t) => `${t.outGamePlayerId},${t.inGamePlayerId}`).join(",")}`}
              className="rounded-lg border border-navy-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800"
            >
              Compare Players
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
