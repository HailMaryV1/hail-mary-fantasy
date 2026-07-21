"use client";

import { useState, useTransition } from "react";
import { importGolfTournament, type ImportResult } from "./actions";

export default function ImportForm() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    startTransition(async () => {
      const { result, error } = await importGolfTournament(input);
      if (error) setError(error);
      else if (result) setResult(result);
    });
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="https://www.fanteam.com/fantasy/participate/1131817"
          className="flex-1 rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
        />
        <button
          type="submit"
          disabled={isPending || !input.trim()}
          className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? "Importing..." : "Import tournament"}
        </button>
      </form>

      {error && (
        <p className="mt-4 rounded-lg bg-red-950 p-4 text-sm text-red-300">{error}</p>
      )}

      {result && (
        <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
          <p className="text-sm font-semibold text-white">&ldquo;{result.tournamentName}&rdquo; imported</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Matched (ID)</dt>
              <dd className="text-white">{result.matchedBySportyId}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Matched (name)</dt>
              <dd className="text-white">{result.matchedByName}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">New golfers</dt>
              <dd className="text-white">{result.created}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Entries written</dt>
              <dd className="text-white">{result.entriesWritten}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Changes detected</dt>
              <dd className="text-white">{result.changesDetected}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Ambiguous</dt>
              <dd className={result.ambiguous.length > 0 ? "text-amber-400" : "text-white"}>{result.ambiguous.length}</dd>
            </div>
          </dl>
          {result.ambiguous.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber-950/60 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-amber-400">Needs manual review - no confident match</p>
              <p className="mt-1 text-sm text-amber-200">{result.ambiguous.join(", ")}</p>
            </div>
          )}
          <p className="mt-3 text-xs text-navy-400">
            Next: run the Hail Mary Golf algorithm for this tournament (
            <code className="rounded bg-navy-800 px-1 py-0.5">python3 scripts/compute_golf_projections.py</code>), then check{" "}
            <a href="/golf/rankings" className="text-sky-400 hover:text-sky-300">rankings</a>.
          </p>
        </div>
      )}
    </div>
  );
}
