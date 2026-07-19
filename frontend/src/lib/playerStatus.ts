export type StatusBadge = { code: string; label: string; tone: "green" | "amber" | "red" | "gray" };

// Mirrors scripts/compute_projections.py's LINEUP_MULTIPLIERS/
// STATUS_MULTIPLIERS keys - keep these two in sync if the raw-string
// mapping gets corrected after running scripts/verify_player_status_mapping.py.
// Unconfirmed as of 2026-07-19 - see that script's docstring.
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

// Availability (injured/suspended/...) takes priority over lineup
// likelihood when both are known - an injured player shouldn't show
// "EXP" just because the lineup field hasn't caught up yet.
export function resolveStatusBadge(lineup: string | null, status: string | null): StatusBadge | null {
  if (status && STATUS_BADGES[status]) return STATUS_BADGES[status];
  if (lineup && LINEUP_BADGES[lineup]) return LINEUP_BADGES[lineup];
  return null;
}
