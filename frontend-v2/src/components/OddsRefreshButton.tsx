"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dispatchOddsRefresh, getOddsRefreshStatus, type OddsRefreshStatus } from "@/lib/oddsRefresh";

const POLL_INTERVAL_MS = 4000;
// GitHub Actions queue time + the odds-refresh job itself (odds imports
// + a handful of gameweek recomputes, see scripts/refresh_odds_for_game.py)
// can genuinely take a few minutes - stop polling well past that rather
// than spinning forever if something goes wrong silently upstream.
const MAX_POLL_MS = 8 * 60 * 1000;

type Phase = "idle" | "dispatching" | "running" | "done" | "error";

/** Shared across every game's page (see lib/oddsRefresh.ts's own
 * docstring for why this isn't per-game) - drop into any game's page
 * with its slug. */
export default function OddsRefreshButton({ gameSlug }: { gameSlug: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const dispatchedAtRef = useRef<number>(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer.current = setInterval(async () => {
      if (Date.now() - dispatchedAtRef.current > MAX_POLL_MS) {
        stopPolling();
        setPhase("error");
        setMessage("Taking longer than expected - check back shortly.");
        return;
      }
      const status = await getOddsRefreshStatus(gameSlug);
      if (!status) return;
      const completedAfterDispatch = status.completedAt && new Date(status.completedAt).getTime() >= dispatchedAtRef.current;
      if (!completedAfterDispatch) return; // still running, or a stale completedAt from before this click

      stopPolling();
      if (status.status === "ok") {
        setPhase("done");
        setMessage("Odds updated.");
        router.refresh();
      } else {
        setPhase("error");
        setMessage(status.errorMessage || "Odds refresh failed.");
      }
    }, POLL_INTERVAL_MS);
  }

  async function handleClick() {
    setPhase("dispatching");
    setMessage(null);
    dispatchedAtRef.current = Date.now();
    const { dispatched, error } = await dispatchOddsRefresh(gameSlug);
    if (!dispatched) {
      setPhase("error");
      setMessage(error || "Couldn't start the odds refresh.");
      return;
    }
    setPhase("running");
    startPolling();
  }

  const isBusy = phase === "dispatching" || phase === "running";

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={isBusy}
        className="flex items-center gap-2 rounded-lg border border-sky-700 bg-sky-950/40 px-3 py-1.5 text-xs font-medium text-sky-200 transition hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isBusy && (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" aria-hidden="true" />
        )}
        {phase === "dispatching" ? "Starting..." : phase === "running" ? "Updating odds..." : "Update Odds"}
      </button>
      {message && (
        <span className={`text-xs ${phase === "error" ? "text-red-400" : "text-emerald-400"}`}>{message}</span>
      )}
    </div>
  );
}
