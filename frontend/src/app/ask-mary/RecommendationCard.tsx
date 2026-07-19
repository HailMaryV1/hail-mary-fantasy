"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { makeTransfer } from "../squads/actions";
import AskMaryWatchlistButton from "./AskMaryWatchlistButton";
import type { AskMaryRecommendation } from "./page";

const RISK_TONE: Record<AskMaryRecommendation["risk"], string> = {
  low: "bg-emerald-950 text-emerald-400",
  medium: "bg-amber-950 text-amber-400",
  high: "bg-red-950 text-red-400",
};

export default function RecommendationCard({ rec, gameId }: { rec: AskMaryRecommendation; gameId: number }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  function handleApply() {
    setError(null);
    startTransition(async () => {
      const result = await makeTransfer({
        squadId: rec.squadId,
        outGamePlayerId: rec.outGamePlayerId,
        inGamePlayerId: rec.inGamePlayerId,
      });
      if (result?.error) setError(result.error);
    });
  }

  if (dismissed) {
    return (
      <div className="rounded-xl border border-navy-800 bg-navy-950 px-4 py-2 text-xs text-navy-500">
        Dismissed: {rec.outName} → {rec.inName}.{" "}
        <button onClick={() => setDismissed(false)} className="text-sky-400 hover:text-sky-300">
          Undo
        </button>
      </div>
    );
  }

  const watchlistNotes = `Added from ASK MARY - ${rec.label ?? "recommended move"}. ${rec.reasons[0]?.text ?? ""}`.trim();

  return (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-500 text-xs font-bold text-navy-950">
            {rec.rank}
          </span>
          {rec.label && (
            <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-400">
              {rec.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${RISK_TONE[rec.risk]}`}>{rec.risk} risk</span>
          <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[10px] font-medium text-navy-300">{rec.confidence}% confidence</span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-navy-400">{rec.position} ·</span>
        <span className="text-white">{rec.outName}</span>
        <span className="text-navy-500">({rec.outTeam}, £{rec.outPrice.toFixed(1)}m)</span>
        <span className="text-navy-500">→</span>
        <span className="font-medium text-white">{rec.inName}</span>
        <span className="text-navy-500">({rec.inTeam}, £{rec.inPrice.toFixed(1)}m)</span>
        <span className="ml-auto rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-semibold text-emerald-400">
          Mary Move Score {rec.overall}/100
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
        <Stat label="Transfer cost" value={`${rec.transferCost >= 0 ? "£" + rec.transferCost.toFixed(1) : "-£" + Math.abs(rec.transferCost).toFixed(1)}m`} />
        <Stat label="Money remaining" value={`£${rec.moneyRemainingAfter.toFixed(1)}m`} />
        <Stat label="xPts before → after" value={`${rec.expectedPointsBefore.toFixed(1)} → ${rec.expectedPointsAfter.toFixed(1)}`} />
        <Stat label="Hail Mary Score diff" value={`${rec.hailMaryScoreDiff >= 0 ? "+" : ""}${rec.hailMaryScoreDiff.toFixed(1)}`} />
        <Stat label="Gain (1 GW)" value={rec.gain1 != null ? `${rec.gain1 >= 0 ? "+" : ""}${rec.gain1.toFixed(1)}` : "-"} />
        <Stat label="Gain (3 GW)" value={rec.gain3 != null ? `${rec.gain3 >= 0 ? "+" : ""}${rec.gain3.toFixed(1)}` : "-"} />
        <Stat label="Gain (5 GW)" value={rec.gain5 != null ? `${rec.gain5 >= 0 ? "+" : ""}${rec.gain5.toFixed(1)}` : "-"} />
        <Stat label="Fixture swing diff" value={`${rec.fixtureSwingDiff >= 0 ? "+" : ""}${rec.fixtureSwingDiff.toFixed(2)}`} />
      </div>

      <p className="mt-3 text-sm text-navy-200">{rec.reasons[0]?.text}</p>

      <button onClick={() => setExpanded((e) => !e)} className="mt-1 text-xs font-medium text-sky-400 hover:text-sky-300">
        {expanded ? "Hide detail" : "Why Mary recommends this"}
      </button>

      {expanded && (
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-400">Why Mary recommends this</p>
            <ul className="mt-1 list-inside list-disc text-xs text-navy-300">
              {rec.reasons.map((r) => (
                <li key={r.code}>{r.text}</li>
              ))}
            </ul>
          </div>
          {rec.warnings.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-amber-400">Risks</p>
              <ul className="mt-1 list-inside list-disc text-xs text-navy-300">
                {rec.warnings.map((w) => (
                  <li key={w.code}>{w.text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={handleApply}
          disabled={isPending}
          className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-navy-950 hover:bg-sky-400 disabled:opacity-40"
        >
          {isPending ? "Applying..." : "Apply Transfer"}
        </button>
        <Link
          href={`/compare?ids=${rec.outGamePlayerId},${rec.inGamePlayerId}`}
          className="rounded-lg border border-navy-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800"
        >
          Compare Players
        </Link>
        <AskMaryWatchlistButton
          gameId={gameId}
          gamePlayerId={rec.inGamePlayerId}
          defaultReasons={["buy_target"]}
          notes={watchlistNotes}
        />
        <button
          onClick={() => setDismissed(true)}
          className="ml-auto rounded-lg px-2 py-1.5 text-xs font-medium text-navy-500 hover:text-navy-300"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-navy-500">{label}</p>
      <p className="font-medium text-white">{value}</p>
    </div>
  );
}
