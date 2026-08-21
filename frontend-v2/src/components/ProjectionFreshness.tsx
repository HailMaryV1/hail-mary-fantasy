import { formatFreshness } from "@/lib/projectionFreshness";

/**
 * "When were these projections last actually recomputed" - real user
 * request 2026-08-21, shown at the bottom of every game's player pool
 * table so a stale/broken pipeline run is visible at a glance rather than
 * silently trusted. Shared across all 4 boards rather than duplicated -
 * see projectionFreshness.ts for why updatedAt is null-safe (a brand new
 * game with no projections computed yet has nothing to report).
 */
export default function ProjectionFreshness({ updatedAt }: { updatedAt: string | null }) {
  if (!updatedAt) return null;
  return (
    <p className="mt-2 text-center text-[10px] text-navy-600" title={new Date(updatedAt).toLocaleString("en-GB")}>
      {formatFreshness(updatedAt)}
    </p>
  );
}
