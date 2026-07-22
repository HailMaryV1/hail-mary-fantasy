"use client";

import { useState, useTransition } from "react";
import { importTournamentOdds, type OddsImportResult } from "./actions";

const MARKET_OPTIONS: { value: string; label: string }[] = [
  { value: "win", label: "Win (Outright)" },
  { value: "top5", label: "Top 5 Finish" },
  { value: "top10", label: "Top 10 Finish" },
  { value: "top20", label: "Top 20 Finish" },
];

export default function OddsImportForm({ tournaments }: { tournaments: { id: number; name: string }[] }) {
  const [tournamentId, setTournamentId] = useState<string>(tournaments[0] ? String(tournaments[0].id) : "");
  const [market, setMarket] = useState("win");
  const [pastedText, setPastedText] = useState("");
  const [result, setResult] = useState<OddsImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!tournamentId) {
      setError("Select a tournament first.");
      return;
    }
    startTransition(async () => {
      const { result, error } = await importTournamentOdds(Number(tournamentId), market, pastedText);
      if (error) setError(error);
      else if (result) {
        setResult(result);
        setPastedText("");
      }
    });
  }

  return (
    <div className="mt-8">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="text-xs uppercase tracking-wide text-navy-400">Tournament</label>
          <select
            value={tournamentId}
            onChange={(e) => setTournamentId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-400/40"
          >
            {tournaments.length === 0 && <option value="">No tournaments imported yet</option>}
            {tournaments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-navy-400">Market</label>
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-400/40"
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
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            rows={12}
            placeholder={"Scottie Scheffler 4/1\nMaverick McNealy 28/1\nKurt Kitayama 29/1"}
            className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 font-mono text-sm text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
          />
        </div>

        <button
          type="submit"
          disabled={isPending || !pastedText.trim() || !tournamentId}
          className="self-start rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? "Importing..." : "Import odds"}
        </button>
      </form>

      {error && <p className="mt-4 rounded-lg bg-red-950 p-4 text-sm text-red-300">{error}</p>}

      {result && (
        <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
          <p className="text-sm font-semibold text-white">
            &ldquo;{result.tournamentName}&rdquo; - {MARKET_OPTIONS.find((m) => m.value === result.market)?.label} odds imported
          </p>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Rows parsed</dt>
              <dd className="text-white">{result.rowsParsed}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Matched to a golfer</dt>
              <dd className="text-white">{result.matched}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Unmatched</dt>
              <dd className={result.unmatched.length > 0 ? "text-amber-400" : "text-white"}>{result.unmatched.length}</dd>
            </div>
          </dl>
          {result.unmatched.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber-950/60 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-amber-400">
                No matching golfer found - only relevant if they&apos;re in this tournament&apos;s FanTeam pool
              </p>
              <p className="mt-1 text-sm text-amber-200">{result.unmatched.join(", ")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
