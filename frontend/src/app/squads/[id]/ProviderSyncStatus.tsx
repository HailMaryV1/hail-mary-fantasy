"use client";

import { useState, useTransition } from "react";
import { requestProviderSync } from "../actions";

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  fanteam_scoutgg: "FanTeam",
  dreamteamfc: "Dream Team",
  cloudff: "Cloud Fantasy Football",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// A "Sync Now" click is instant now (requestProviderSync dispatches
// .github/workflows/provider_sync_requested.yml directly via GitHub's
// API), but the background sweep that catches provider-side-only changes
// (.github/workflows/provider_sync_scheduled.yml) runs every 3 hours - 4
// hours is a generous multiple of that (covers one occasional missed/
// delayed tick) while still catching a genuinely broken/stuck sync
// rather than showing a false "Synced" for days.
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

function isStale(iso: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() > STALE_THRESHOLD_MS;
}

function statusTone(status: string, stale: boolean): string {
  if (status === "ok") return stale ? "bg-amber-950 text-amber-400" : "bg-emerald-950 text-emerald-400";
  if (status === "error") return "bg-red-950 text-red-400";
  return "bg-navy-800 text-navy-400";
}

export default function ProviderSyncStatus({
  squadId,
  provider,
  lastSyncedAt,
  lastSyncStatus,
  lastSyncError,
  lastChangeSummary,
  syncRequested,
}: {
  squadId: number;
  provider: string;
  lastSyncedAt: string | null;
  lastSyncStatus: "never" | "ok" | "error";
  lastSyncError: string | null;
  lastChangeSummary: string | null;
  syncRequested: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  // Only meaningful when dispatch failed (e.g. GITHUB_ACTIONS_TOKEN not
  // yet configured) - the request itself always succeeds either way
  // (sync_requested_at is durable), this is purely "how soon" feedback,
  // not an error the user needs to act on.
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);

  function handleSyncNow() {
    startTransition(async () => {
      const result = await requestProviderSync({ squadId });
      if (result && "success" in result && !result.dispatched) {
        setDispatchNote("Requested - will run on the next background sweep (instant trigger not configured yet).");
      } else {
        setDispatchNote(null);
      }
    });
  }

  const requestedButNotYetPicked = syncRequested;
  const stale = lastSyncStatus === "ok" && isStale(lastSyncedAt);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-navy-700 bg-navy-900 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-navy-400">Auto-synced from</span>
          <span className="text-sm font-medium text-white">{PROVIDER_DISPLAY_NAMES[provider] ?? provider}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusTone(lastSyncStatus, stale)}`}>
            {lastSyncStatus === "ok" ? (stale ? "Stale" : "Synced") : lastSyncStatus === "error" ? "Sync failed" : "Not yet synced"}
          </span>
        </div>
        <p className="mt-1 text-xs text-navy-400">
          Last synced: {timeAgo(lastSyncedAt)}
          {lastChangeSummary && lastSyncStatus === "ok" && !stale && ` — ${lastChangeSummary}`}
        </p>
        {lastSyncStatus === "error" && lastSyncError && <p className="mt-1 text-xs text-red-400">{lastSyncError}</p>}
        {stale && (
          <p className="mt-1 text-xs text-amber-400">
            This hasn&apos;t synced in a while - the data below may be out of date. Try Sync Now, or check back later.
          </p>
        )}
        {dispatchNote && <p className="mt-1 text-xs text-amber-400">{dispatchNote}</p>}
      </div>
      <button
        onClick={handleSyncNow}
        disabled={isPending || requestedButNotYetPicked}
        className="shrink-0 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? "Requesting..." : requestedButNotYetPicked ? "Sync requested..." : "Sync Now"}
      </button>
    </div>
  );
}
