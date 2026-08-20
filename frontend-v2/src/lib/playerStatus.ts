export type StatusBadge = { code: string; label: string; tone: "green" | "amber" | "red" | "gray" };

const LINEUP_BADGES: Record<string, StatusBadge> = {
  confirmed_starting: { code: "STA", label: "Starting (confirmed)", tone: "green" },
  expected: { code: "EXP", label: "Expected to start", tone: "green" },
  might_start: { code: "MAY", label: "Might start", tone: "amber" },
  not_expected: { code: "NES", label: "Not expected to start", tone: "amber" },
  confirmed_benched: { code: "BEN", label: "Benched (confirmed)", tone: "red" },
  confirmed_not_in_squad: { code: "NOT", label: "Not in squad (confirmed)", tone: "red" },
};

const STATUS_BADGES: Record<string, StatusBadge> = {
  injured: { code: "INJ", label: "Injured", tone: "red" },
  suspended: { code: "SUS", label: "Suspended", tone: "red" },
  not_available: { code: "N/A", label: "Not available", tone: "red" },
  gameweek_off: { code: "OFF", label: "Gameweek off", tone: "gray" },
};

// Real team news from fantasyfootballscout.co.uk (2026-08-19 user request
// - see migration 0122/0123, compute_projections.py's fetch_ffscout_
// player_status()) - the same signal already feeding expected_minutes in
// the engine, surfaced here for display. 25% (or below) is treated as
// essentially a non-starter (matches common FPL convention of reading a
// 25%-or-less "chance of playing" figure as functionally unavailable) -
// tuned to the real tiers FFScout actually publishes (25/50/75%),
// adjustable later if that convention doesn't hold up.
const FFSCOUT_INJURY_LIKE_THRESHOLD = 25;

// Real injury type/description + expected return date (2026-08-20 user
// request, see migration 0127) - appended to the badge's tooltip label
// only, never a new badge/page (explicit user scope correction: "I just
// want the data feeding into Ask Mary - the player pools with player
// status... just like we have with the predicted lineups and the little
// injury snippet. this is more extensive").
function appendDetail(label: string, ffscoutDetail: string | null, ffscoutExpectedReturnDate: string | null): string {
  const parts = [label];
  if (ffscoutDetail) parts.push(ffscoutDetail);
  if (ffscoutExpectedReturnDate) {
    const [year, month, day] = ffscoutExpectedReturnDate.split("-");
    parts.push(`Expected back ${day}/${month}/${year}`);
  }
  return parts.join(" — ");
}

function resolveFfscoutBadge(
  ffscoutStatus: string | null,
  ffscoutStartProbability: number | null,
  ffscoutDetail: string | null = null,
  ffscoutExpectedReturnDate: string | null = null
): StatusBadge | null {
  if (ffscoutStatus === "out") {
    return { code: "OUT", label: appendDetail("Ruled out (FFScout)", ffscoutDetail, ffscoutExpectedReturnDate), tone: "red" };
  }
  if (ffscoutStatus === "banned") {
    return { code: "BAN", label: appendDetail("Suspended (FFScout)", ffscoutDetail, ffscoutExpectedReturnDate), tone: "red" };
  }
  if (ffscoutStatus === "doubt" && ffscoutStartProbability != null) {
    const pct = Math.round(ffscoutStartProbability);
    const base = `Doubtful - ${pct}% chance of starting (FFScout)`;
    const label = appendDetail(base, ffscoutDetail, ffscoutExpectedReturnDate);
    if (pct <= FFSCOUT_INJURY_LIKE_THRESHOLD) return { code: "INJ", label, tone: "red" };
    return { code: "DBT", label, tone: "amber" };
  }
  return null;
}

// Availability takes priority over lineup likelihood when both are known.
// FFScout's real doubt/out signal sits between the two: more precise than
// a coarse lineup bucket, but a platform's own confirmed status (when one
// exists) still wins - same priority order compute_opportunity() already
// uses for the exact same signal.
export function resolveStatusBadge(
  lineup: string | null,
  status: string | null,
  ffscoutStatus: string | null = null,
  ffscoutStartProbability: number | null = null,
  ffscoutDetail: string | null = null,
  ffscoutExpectedReturnDate: string | null = null
): StatusBadge | null {
  if (status && STATUS_BADGES[status]) return STATUS_BADGES[status];
  const ffscoutBadge = resolveFfscoutBadge(ffscoutStatus, ffscoutStartProbability, ffscoutDetail, ffscoutExpectedReturnDate);
  if (ffscoutBadge) return ffscoutBadge;
  if (lineup && LINEUP_BADGES[lineup]) return LINEUP_BADGES[lineup];
  return null;
}

// Numeric counterparts of the badges above, for scoring code (squadHealth.ts,
// recommendationScoring.ts) that needs a 0-1 weight rather than a display
// label - same keys/meanings as LINEUP_BADGES/STATUS_BADGES.
export const LINEUP_SECURITY_SCORES: Record<string, number> = {
  confirmed_starting: 1.0,
  expected: 0.95,
  might_start: 0.75,
  not_expected: 0.35,
  confirmed_benched: 0.1,
  confirmed_not_in_squad: 0.0,
};

export const INJURY_AVAILABILITY_SCORES: Record<string, number> = {
  injured: 0.0,
  suspended: 0.0,
  not_available: 0.0,
  gameweek_off: 0.0,
};

// Fail open, same philosophy as compute_projections.py's
// DEFAULT_STATUS_MULTIPLIER - an unrecognized or missing raw value never
// wrongly tanks a player's score.
export const DEFAULT_SECURITY_SCORE = 1.0;
