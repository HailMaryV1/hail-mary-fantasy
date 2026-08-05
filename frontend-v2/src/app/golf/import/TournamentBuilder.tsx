"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { importGolfTournament, importTournamentOdds, dispatchGolfCompute, type ImportResult, type OddsImportResult } from "./actions";

type Tournament = { id: number; fanteamId: string; name: string };

const STEPS = ["Import", "Odds", "Compute"] as const;

const MARKET_OPTIONS: { value: string; label: string }[] = [
  { value: "win", label: "Win (Outright)" },
  { value: "top5", label: "Top 5 Finish" },
  { value: "top10", label: "Top 10 Finish" },
  { value: "top20", label: "Top 20 Finish" },
];

function StepHeader({ step, furthestReached, onJump }: { step: number; furthestReached: number; onJump: (n: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const reachable = n <= furthestReached;
        const active = n === step;
        return (
          <button
            key={label}
            type="button"
            disabled={!reachable}
            onClick={() => reachable && onJump(n)}
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              active
                ? "bg-sky-500 text-navy-950"
                : reachable
                  ? "bg-navy-800 text-navy-200 hover:bg-navy-700"
                  : "cursor-not-allowed bg-navy-900 text-navy-600"
            }`}
          >
            <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${active ? "bg-navy-950 text-sky-400" : "bg-navy-700"}`}>
              {n}
            </span>
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default function TournamentBuilder({
  existingTournaments,
}: {
  // Lets step 1 be bypassed for a tournament that's already been
  // imported (by this wizard, or manually) - necessary since step 2/3
  // are otherwise unreachable whenever a fresh import fails (e.g.
  // FanTeam's player-pool endpoint currently rejects unauthenticated
  // requests - see golf/import/actions.ts's importGolfTournament).
  existingTournaments: { id: number; fanteamTournamentId: string; name: string }[];
}) {
  const [step, setStep] = useState(1);
  const [furthestReached, setFurthestReached] = useState(1);
  const [tournament, setTournament] = useState<Tournament | null>(null);

  // Step 1 state
  const [urlInput, setUrlInput] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, startImport] = useTransition();

  // Step 2 state
  const [market, setMarket] = useState("top10");
  const [oddsText, setOddsText] = useState("");
  const [oddsResult, setOddsResult] = useState<OddsImportResult | null>(null);
  const [oddsError, setOddsError] = useState<string | null>(null);
  const [isImportingOdds, startImportOdds] = useTransition();

  // Step 3 state
  const [computeState, setComputeState] = useState<"idle" | "started" | "not_configured">("idle");
  const [computeError, setComputeError] = useState<string | null>(null);
  const [isDispatching, startDispatch] = useTransition();

  function goTo(n: number) {
    setStep(n);
    setFurthestReached((f) => Math.max(f, n));
  }

  function handleContinueExisting(t: { id: number; fanteamTournamentId: string; name: string }) {
    setTournament({ id: t.id, fanteamId: t.fanteamTournamentId, name: t.name });
    goTo(2);
  }

  function handleImportSubmit(e: React.FormEvent) {
    e.preventDefault();
    setImportError(null);
    setImportResult(null);
    startImport(async () => {
      const { result, error } = await importGolfTournament(urlInput);
      if (error) setImportError(error);
      else if (result) {
        setImportResult(result);
        setTournament({ id: result.tournamentId, fanteamId: result.fanteamTournamentId, name: result.tournamentName });
      }
    });
  }

  function handleOddsSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tournament) return;
    setOddsError(null);
    setOddsResult(null);
    startImportOdds(async () => {
      const { result, error } = await importTournamentOdds(tournament.id, market, oddsText);
      if (error) setOddsError(error);
      else if (result) {
        setOddsResult(result);
        setOddsText("");
      }
    });
  }

  function handleCompute() {
    if (!tournament) return;
    setComputeError(null);
    startDispatch(async () => {
      const { dispatched, error } = await dispatchGolfCompute(tournament.fanteamId);
      if (dispatched) setComputeState("started");
      else {
        setComputeState("not_configured");
        setComputeError(error ?? null);
      }
    });
  }

  return (
    <div>
      <StepHeader step={step} furthestReached={furthestReached} onJump={goTo} />

      {step === 1 && (
        <div className="mt-6">
          <p className="text-sm text-navy-300">
            Paste this week&apos;s FanTeam Golf contest URL. Safe to re-run against the same tournament any time -
            prices/stats update in place, nothing duplicates.
          </p>
          <form onSubmit={handleImportSubmit} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://www.fanteam.com/fantasy/participate/1131817"
              className="flex-1 rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
            />
            <button
              type="submit"
              disabled={isImporting || !urlInput.trim()}
              className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isImporting ? "Importing..." : "Import tournament"}
            </button>
          </form>

          {importError && <p className="mt-4 rounded-lg bg-red-950 p-4 text-sm text-red-300">{importError}</p>}

          {importResult && (
            <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
              <p className="text-sm font-semibold text-white">&ldquo;{importResult.tournamentName}&rdquo; imported</p>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Matched (ID)</dt>
                  <dd className="text-white">{importResult.matchedBySportyId}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Matched (name)</dt>
                  <dd className="text-white">{importResult.matchedByName}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">New golfers</dt>
                  <dd className="text-white">{importResult.created}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Entries written</dt>
                  <dd className="text-white">{importResult.entriesWritten}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Changes detected</dt>
                  <dd className="text-white">{importResult.changesDetected}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Ambiguous</dt>
                  <dd className={importResult.ambiguous.length > 0 ? "text-amber-400" : "text-white"}>{importResult.ambiguous.length}</dd>
                </div>
              </dl>
              {importResult.ambiguous.length > 0 && (
                <div className="mt-3 rounded-lg bg-amber-950/60 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-amber-400">Needs manual review - no confident match</p>
                  <p className="mt-1 text-sm text-amber-200">{importResult.ambiguous.join(", ")}</p>
                </div>
              )}
              <button
                type="button"
                onClick={() => goTo(2)}
                className="mt-4 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400"
              >
                Continue to odds →
              </button>
            </div>
          )}

          {existingTournaments.length > 0 && (
            <div className="mt-6 border-t border-navy-800 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-navy-500">Already imported</p>
              <p className="mt-1 text-xs text-navy-400">Skip straight to odds/compute for a tournament that&apos;s already in the system.</p>
              <div className="mt-2 flex flex-col gap-2">
                {existingTournaments.slice(0, 5).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => handleContinueExisting(t)}
                    className="flex items-center justify-between rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-left text-sm text-navy-200 transition-colors hover:border-sky-500 hover:bg-navy-800"
                  >
                    {t.name}
                    <span className="text-xs font-medium text-sky-400">Continue →</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {step === 2 && tournament && (
        <div className="mt-6">
          <p className="text-sm text-navy-300">
            No golf odds API covers regular weekly Tour events at a reasonable cost, so this is manual: open a
            bookmaker or odds-comparison page (e.g. Oddschecker&apos;s Top 10 Finish page for &ldquo;{tournament.name}
            &rdquo;), copy the player + odds column, and paste it below. Handles fractional (11/1), American (+1200),
            and decimal (12.0) odds, and averages multiple bookmaker quotes on the same line. Optional - if odds
            aren&apos;t posted yet, just continue without pasting anything.
          </p>

          <form onSubmit={handleOddsSubmit} className="mt-4 flex flex-col gap-4">
            <div>
              <label className="text-xs uppercase tracking-wide text-navy-400">Market</label>
              <select
                value={market}
                onChange={(e) => setMarket(e.target.value)}
                className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-400/40 sm:max-w-xs"
              >
                {MARKET_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs uppercase tracking-wide text-navy-400">Paste player + odds (one per line)</label>
              <textarea
                value={oddsText}
                onChange={(e) => setOddsText(e.target.value)}
                rows={10}
                placeholder={"Scottie Scheffler 4/1\nMaverick McNealy 28/1\nKurt Kitayama 29/1"}
                className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 font-mono text-sm text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={isImportingOdds || !oddsText.trim()}
                className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isImportingOdds ? "Importing..." : "Import odds"}
              </button>
              <button type="button" onClick={() => goTo(3)} className="text-sm font-medium text-sky-400 hover:text-sky-300">
                Continue to compute →
              </button>
            </div>
          </form>

          {oddsError && <p className="mt-4 rounded-lg bg-red-950 p-4 text-sm text-red-300">{oddsError}</p>}

          {oddsResult && (
            <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
              <p className="text-sm font-semibold text-white">
                {MARKET_OPTIONS.find((m) => m.value === oddsResult.market)?.label} odds imported
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Rows parsed</dt>
                  <dd className="text-white">{oddsResult.rowsParsed}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Matched to a golfer</dt>
                  <dd className="text-white">{oddsResult.matched}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Unmatched</dt>
                  <dd className={oddsResult.unmatched.length > 0 ? "text-amber-400" : "text-white"}>{oddsResult.unmatched.length}</dd>
                </div>
              </dl>
              {oddsResult.unmatched.length > 0 && (
                <div className="mt-3 rounded-lg bg-amber-950/60 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-amber-400">
                    No matching golfer found - only relevant if they&apos;re in this tournament&apos;s FanTeam pool
                  </p>
                  <p className="mt-1 text-sm text-amber-200">{oddsResult.unmatched.join(", ")}</p>
                </div>
              )}
              <button
                type="button"
                onClick={() => goTo(3)}
                className="mt-4 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400"
              >
                Continue to compute →
              </button>
            </div>
          )}
        </div>
      )}

      {step === 3 && tournament && (
        <div className="mt-6">
          <p className="text-sm text-navy-300">
            Runs Hail Mary Golf&apos;s scoring model for &ldquo;{tournament.name}&rdquo; - per-stat shrinkage
            projections blended with whatever odds you just pasted, giving every golfer an expected-points, make-cut
            probability, and value (points-per-price - who&apos;s underpriced) figure.
          </p>

          <button
            type="button"
            onClick={handleCompute}
            disabled={isDispatching || computeState === "started"}
            className="mt-4 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isDispatching ? "Starting..." : computeState === "started" ? "Started" : "Compute Hail Mary Golf projections"}
          </button>

          {computeState === "started" && (
            <div className="mt-4 rounded-xl border border-emerald-800 bg-emerald-950/40 p-4">
              <p className="text-sm text-emerald-200">Started - usually finishes in under a minute.</p>
              <Link href={`/golf/rankings?tournament=${tournament.fanteamId}`} className="mt-2 inline-block text-sm font-medium text-sky-400 hover:text-sky-300">
                View rankings →
              </Link>
            </div>
          )}

          {computeState === "not_configured" && (
            <div className="mt-4 rounded-xl border border-amber-800 bg-amber-950/40 p-4">
              <p className="text-sm text-amber-200">
                Instant compute isn&apos;t configured yet{computeError ? ` (${computeError})` : ""}. Run this instead:
              </p>
              <code className="mt-2 block rounded bg-navy-900 px-3 py-2 text-xs text-navy-200">
                python3 scripts/compute_golf_projections.py {tournament.fanteamId}
              </code>
              <p className="mt-2 text-sm text-amber-200">
                Then check{" "}
                <Link href={`/golf/rankings?tournament=${tournament.fanteamId}`} className="text-sky-400 hover:text-sky-300">
                  rankings
                </Link>
                .
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
