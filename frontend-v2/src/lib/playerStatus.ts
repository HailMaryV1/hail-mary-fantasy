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

// Availability takes priority over lineup likelihood when both are known.
export function resolveStatusBadge(lineup: string | null, status: string | null): StatusBadge | null {
  if (status && STATUS_BADGES[status]) return STATUS_BADGES[status];
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
