import { LINEUP_SECURITY_SCORES, INJURY_AVAILABILITY_SCORES, DEFAULT_SECURITY_SCORE } from "./playerStatus";

export type SwingOpportunityInput = {
  gamePlayerId: number;
  fullName: string;
  teamId: number;
  teamName: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  price: number;
  hailMaryScore: number | null; // game_player_pool.hail_mary_score
  expectedPointsNext5: number | null; // avg_score * gameweeks_included from player_score_by_horizon_from(..., 5)
  fixtureSwingValue: number; // TeamFixtureRating.swingValue for this player's team
  lineup: string | null; // game_player_pool.lineup
  status: string | null; // game_player_pool.status
  form: number | null; // NEW: game_player_pool.form (migration 0029) - reads 0 for everyone pre-season
  // Deliberately no ownership field - FanTeam's own data has none (confirmed),
  // dropped from scoring entirely rather than faked.
};

export type SwingOpportunityScore = {
  gamePlayerId: number;
  overall: number; // 0-100
  rawValue: number; // expectedPointsNext5 / price, unnormalized - drives Best Value directly
  breakdown: {
    fixtureImprovement: number; // 0-1, normalized across the candidate pool
    expectedPoints: number;
    hailMaryScore: number;
    value: number;
    minutesSecurity: number; // 0-1, absolute (from LINEUP_SECURITY_SCORES, not renormalized)
    rotationRisk: number; // = 1 - minutesSecurity, informational only, not separately weighted
    form: number;
    injuryStatus: number; // 0-1, absolute (from INJURY_AVAILABILITY_SCORES, not renormalized)
  };
};

// Each weight's relative importance to the overall Swing Opportunity
// Score. Must sum to 1.0 - enforced below, not silently renormalized, so
// a typo here fails loudly instead of quietly skewing every
// recommendation. Tunable, same house style as compute_projections.py's
// LINEUP_MULTIPLIERS - just edit the numbers to retune.
export const DEFAULT_SWING_WEIGHTS = {
  fixtureImprovement: 0.25, // the core "why now" signal this whole feature exists for
  expectedPoints: 0.25, // raw ceiling over the horizon - a great swing for a bad player still isn't a good buy
  hailMaryScore: 0.15, // current single-GW quality signal, distinct from the 5-GW total above
  value: 0.15, // points-per-price - budget is always finite
  minutesSecurity: 0.1, // a swing means nothing if the player doesn't actually play
  form: 0.05, // FanTeam's own recent-form metric - low weight; reads 0 for everyone pre-season
  injuryStatus: 0.05, // hard availability gate, but binary and rare - doesn't need much weight
} as const;

function assertWeightsSumToOne(weights: Record<string, number>) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.001) {
    throw new Error(`Swing Opportunity weights must sum to 1.0, got ${sum.toFixed(3)} - check the weights passed in.`);
  }
}

function computeMinMax(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

function normalize(value: number, min: number, max: number): number {
  // No variance in the pool yet (e.g. `form` is 0 for everyone pre-season) -
  // midpoint keeps the weight structurally present without skewing rank order.
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

/**
 * Scores every candidate against the whole pool passed in (league-wide,
 * not per-club) so the same score is comparable across clubs - this is
 * what makes the service reusable by both the per-club Fixture Swing
 * Panel and the cross-club Watchlist page, rather than one baked into
 * each page separately. Missing data (no calendar yet, no historical
 * rate) is treated as the pool's own minimum for that factor rather than
 * excluding the candidate - "fail open," matching this codebase's
 * established pattern (compute_projections.py's status_multiplier
 * fallback, detectFixtureRuns' "missing gameweek breaks a run rather
 * than crashing").
 */
export function computeSwingOpportunityScores(
  candidates: SwingOpportunityInput[],
  weights: typeof DEFAULT_SWING_WEIGHTS = DEFAULT_SWING_WEIGHTS
): SwingOpportunityScore[] {
  assertWeightsSumToOne(weights);
  if (candidates.length === 0) return [];

  const expectedPointsValues = candidates.map((c) => c.expectedPointsNext5).filter((v): v is number => v != null);
  const hailMaryValues = candidates.map((c) => c.hailMaryScore).filter((v): v is number => v != null);
  const formValues = candidates.map((c) => c.form).filter((v): v is number => v != null);
  const fixtureValues = candidates.map((c) => c.fixtureSwingValue);

  const epRange = computeMinMax(expectedPointsValues.length > 0 ? expectedPointsValues : [0]);
  const hmRange = computeMinMax(hailMaryValues.length > 0 ? hailMaryValues : [0]);
  const formRange = computeMinMax(formValues.length > 0 ? formValues : [0]);
  const fixtureRange = computeMinMax(fixtureValues);

  const rawValues = candidates.map((c) => {
    const ep = c.expectedPointsNext5 ?? epRange.min;
    return ep / Math.max(c.price, 0.1); // guard against a zero/freak price value
  });
  const valueRange = computeMinMax(rawValues);

  return candidates.map((c, i) => {
    const ep = c.expectedPointsNext5 ?? epRange.min;
    const hm = c.hailMaryScore ?? hmRange.min;
    const form = c.form ?? formRange.min;

    // Already absolute 0-1 scores from the multiplier maps (playerStatus.ts)
    // - used directly, NOT min-max renormalized. Renormalizing a pool
    // where everyone is currently healthy (the common case) would
    // collapse every 1.0 into a meaningless 0.5 and erase the gate.
    const minutesSecurity = LINEUP_SECURITY_SCORES[c.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE;
    const injuryStatus = INJURY_AVAILABILITY_SCORES[c.status ?? ""] ?? DEFAULT_SECURITY_SCORE;

    const breakdown = {
      fixtureImprovement: normalize(c.fixtureSwingValue, fixtureRange.min, fixtureRange.max),
      expectedPoints: normalize(ep, epRange.min, epRange.max),
      hailMaryScore: normalize(hm, hmRange.min, hmRange.max),
      value: normalize(rawValues[i], valueRange.min, valueRange.max),
      minutesSecurity,
      rotationRisk: 1 - minutesSecurity,
      form: normalize(form, formRange.min, formRange.max),
      injuryStatus,
    };

    const overall =
      100 *
      (weights.fixtureImprovement * breakdown.fixtureImprovement +
        weights.expectedPoints * breakdown.expectedPoints +
        weights.hailMaryScore * breakdown.hailMaryScore +
        weights.value * breakdown.value +
        weights.minutesSecurity * breakdown.minutesSecurity +
        weights.form * breakdown.form +
        weights.injuryStatus * breakdown.injuryStatus);

    return {
      gamePlayerId: c.gamePlayerId,
      overall: Math.round(overall * 10) / 10,
      rawValue: Math.round(rawValues[i] * 100) / 100,
      breakdown,
    };
  });
}

export type ClubRecommendations = {
  bestOverall: SwingOpportunityScore | null;
  bestValue: SwingOpportunityScore | null;
  bestDifferential: SwingOpportunityScore | null;
};

/**
 * Three sort/filter passes over the same scored list - not three
 * separate scoring systems. Best Differential has no ownership% to lean
 * on (dropped entirely, per the confirmed decision), so it's honestly
 * redefined as "the strongest scorer who isn't yet a confirmed starter" -
 * the closest real signal available - rather than faking a threshold.
 */
export function selectClubRecommendations(
  scores: SwingOpportunityScore[],
  candidates: SwingOpportunityInput[]
): ClubRecommendations {
  const byId = new Map(candidates.map((c) => [c.gamePlayerId, c]));

  const bestOverall = scores.slice().sort((a, b) => b.overall - a.overall)[0] ?? null;
  const bestValue = scores.slice().sort((a, b) => b.rawValue - a.rawValue)[0] ?? null;

  const differentialPool = scores.filter((s) => byId.get(s.gamePlayerId)?.lineup !== "confirmed_starting");
  const bestDifferential = differentialPool.slice().sort((a, b) => b.overall - a.overall)[0] ?? null;

  return { bestOverall, bestValue, bestDifferential };
}
