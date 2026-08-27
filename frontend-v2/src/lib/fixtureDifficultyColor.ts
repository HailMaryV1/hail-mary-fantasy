// Real user request 2026-08-26: "use the difficulty pills with
// differing colours too" for a player's window fixtures on /ratings and
// the downloadable card. Same 5-tier palette as hailMaryRating.ts's
// rating tiers / playerCard.ts's RATING_TIER_COLORS - one consistent
// "how good is this" visual language across the whole ratings feature,
// not a second competing color scheme.
//
// Threshold values recalibrated 2026-08-27 (real user report: Crystal
// Palace at home to Manchester City - a genuine 58% away win favourite -
// showed as merely "Average", and Palace's own run showed 3 "Easy"
// fixtures out of 5). The original 0.6/0.45/0.35/0.25 cutoffs were
// picked without checking the real distribution of team_fixture_
// difficulty.attack_score across actual upcoming Premier League
// fixtures - confirmed live that real single-match win probabilities
// mostly cluster well below 0.6 (median 0.37, p90 0.71, max 0.78 across
// 420 real fixtures), so "Very Tough" (needing >0.75 hardship) was
// nearly unreachable while "Easy" silently absorbed roughly the bottom
// half of all real fixtures. Recalibrated to the real quintile
// breakpoints (p20/p40/p60/p80 of attack_score, ≈0.11/0.32/0.44/0.65)
// so each tier represents roughly the SAME real proportion of fixtures
// - Man City's 0.58 attack_score now correctly lands in "Tough" (the
// 60-80th percentile band), not "Average". Needs revisiting once a full
// season's worth of real odds has accumulated, not just pre-season/
// early-season pricing.
//
// Hex, not Tailwind classes - this needs to render identically in a
// plain DOM `style` prop (TargetScoreBoard.tsx/PlayerInfoPanel.tsx) AND
// inside the satori-rendered downloadable card (playerCard.ts), which
// can't resolve Tailwind class names at render time.
export type DifficultyTier = { label: string; bg: string; fg: string };

const TIERS: (DifficultyTier & { min: number })[] = [
  { min: 0.89, label: "Easy", bg: "#0f3d2e", fg: "#34d399" },
  { min: 0.68, label: "Favourable", bg: "#0f3d3a", fg: "#2dd4bf" },
  { min: 0.56, label: "Average", bg: "#0c2f4a", fg: "#38bdf8" },
  { min: 0.35, label: "Tough", bg: "#4a2c06", fg: "#fbbf24" },
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
