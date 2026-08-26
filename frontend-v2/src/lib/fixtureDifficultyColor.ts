// Real user request 2026-08-26: "use the difficulty pills with
// differing colours too" for a player's window fixtures on /ratings and
// the downloadable card. Same 5-tier palette as hailMaryRating.ts's
// rating tiers / playerCard.ts's RATING_TIER_COLORS - one consistent
// "how good is this" visual language across the whole ratings feature,
// not a second competing color scheme. Threshold values (0.6/0.45/0.35/
// 0.25) match the existing per-team fixture-difficulty tiering already
// used on pitch-chip fixture tiles (CloudFFBoard.tsx/DreamTeamBoard.tsx's
// own difficultyColor).
//
// Hex, not Tailwind classes - this needs to render identically in a
// plain DOM `style` prop (TargetScoreBoard.tsx/PlayerInfoPanel.tsx) AND
// inside the satori-rendered downloadable card (playerCard.ts), which
// can't resolve Tailwind class names at render time.
export type DifficultyTier = { label: string; bg: string; fg: string };

const TIERS: (DifficultyTier & { min: number })[] = [
  { min: 0.6, label: "Easy", bg: "#0f3d2e", fg: "#34d399" },
  { min: 0.45, label: "Favourable", bg: "#0f3d3a", fg: "#2dd4bf" },
  { min: 0.35, label: "Average", bg: "#0c2f4a", fg: "#38bdf8" },
  { min: 0.25, label: "Tough", bg: "#4a2c06", fg: "#fbbf24" },
  { min: 0, label: "Very Tough", bg: "#451414", fg: "#f87171" },
];

/**
 * ease: 0 (hardest) - 1 (easiest) - i.e. 1 minus the stored position-
 * weighted hardship `difficulty_raw` value (compute_target_scores.py's
 * single_fixture_difficulty_raw). Null (no real team_fixture_difficulty
 * coverage for this fixture) returns null - never a fabricated tier.
 */
export function fixtureDifficultyTier(difficultyRaw: number | null | undefined): DifficultyTier | null {
  if (difficultyRaw == null) return null;
  const ease = 1 - difficultyRaw;
  return TIERS.find((t) => ease >= t.min) ?? TIERS[TIERS.length - 1];
}
