/** Short "vs Team (H) · Sat 29 Aug" label for a rated player's real
 * fixture (2026-08-23 user request - see the Hail Mary Ratings page and
 * its browse table) - null when the row has no scored projection for
 * the exact requested gameweek (migration 0136/0137). */
export function formatFixtureShort(opponentTeamName: string | null, isHome: boolean | null, kickoffAt: string | null): string {
  if (!opponentTeamName) return "—";
  const venue = isHome === true ? "H" : isHome === false ? "A" : null;
  const dateLabel = kickoffAt
    ? new Date(kickoffAt).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    : null;
  const parts = [`vs ${opponentTeamName}`, venue ? `(${venue})` : null, dateLabel].filter(Boolean);
  return parts.join(" ");
}
