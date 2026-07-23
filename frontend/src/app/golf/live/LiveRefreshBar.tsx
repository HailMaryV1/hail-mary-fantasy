"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// The underlying data only actually changes when
// scripts/poll_golf_live_scores.py runs (every ~5 minutes) - refreshing
// more often than that just re-fetches the same numbers, so 30s is a
// reasonable "feels live" cadence without hammering the server for no
// reason.
const REFRESH_INTERVAL_MS = 30_000;

export default function LiveRefreshBar({ fetchedAt }: { fetchedAt: string }) {
  const router = useRouter();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // router.refresh() re-runs the server component with fresh data,
    // which re-renders this bar with a new fetchedAt too - no client-side
    // data-fetching of its own needed here.
    const interval = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [router]);

  useEffect(() => {
    // Rendered only on the client, after fetchedAt's parsed - avoids a
    // server/client hydration mismatch from toLocaleTimeString()
    // formatting differently on the server than in the browser's locale.
    setNow(new Date(fetchedAt));
  }, [fetchedAt]);

  return (
    <p className="mt-1 flex items-center gap-1.5 text-xs text-navy-500">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
      {now ? `Last updated ${now.toLocaleTimeString()} - refreshes automatically` : "Loading..."}
    </p>
  );
}
