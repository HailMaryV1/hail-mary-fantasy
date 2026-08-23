export type Strategy = "balanced" | "safe" | "aggressive" | "differential" | "longterm";

export const STRATEGIES: { key: Strategy; label: string }[] = [
  { key: "balanced", label: "Balanced" },
  { key: "safe", label: "Safe" },
  { key: "aggressive", label: "Aggressive" },
  { key: "differential", label: "Differential" },
  { key: "longterm", label: "Long-term" },
];

type Weights = {
  expectedPoints: number;
  hailMaryScore: number;
  fixtureSwing: number;
  minutesSecurity: number;
  priceEfficiency: number;
  form: number;
  injurySafety: number;
  differential: number;
};

// One centrally-stored weight profile per strategy - never bury these in a
// UI component. Each sums to 1.0 (assertWeightsSumToOne below enforces it).
// Tunable by editing the numbers here only.
export const STRATEGY_WEIGHTS: Record<Strategy, Weights> = {
  balanced: {
    expectedPoints: 0.3,
    hailMaryScore: 0.15,
    fixtureSwing: 0.15,
    minutesSecurity: 0.15,
    priceEfficiency: 0.1,
    form: 0.05,
    injurySafety: 0.07,
    differential: 0.03,
  },
  safe: {
    expectedPoints: 0.2,
    hailMaryScore: 0.1,
    fixtureSwing: 0.1,
    minutesSecurity: 0.3,
    priceEfficiency: 0.05,
    form: 0.05,
    injurySafety: 0.18,
    differential: 0.02,
  },
  aggressive: {
    expectedPoints: 0.35,
    hailMaryScore: 0.2,
    fixtureSwing: 0.2,
    minutesSecurity: 0.05,
    priceEfficiency: 0.05,
    form: 0.1,
    injurySafety: 0.03,
    differential: 0.02,
  },
  differential: {
    expectedPoints: 0.25,
    hailMaryScore: 0.1,
    fixtureSwing: 0.15,
    minutesSecurity: 0.1,
    priceEfficiency: 0.05,
    form: 0.05,
    injurySafety: 0.05,
    differential: 0.25,
  },
  longterm: {
    expectedPoints: 0.25,
    hailMaryScore: 0.1,
    fixtureSwing: 0.25,
    minutesSecurity: 0.15,
    priceEfficiency: 0.15,
    form: 0.03,
    injurySafety: 0.05,
    differential: 0.02,
  },
};

function assertWeightsSumToOne(weights: Weights) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.001) {
    throw new Error(`Strategy weights must sum to 1.0, got ${sum.toFixed(3)} - check STRATEGY_WEIGHTS.`);
  }
}

export type MoveCandidateInput = {
  outGamePlayerId: number;
  inGamePlayerId: number;
  outName: string;
  inName: string;
  outTeam: string;
  inTeam: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  expectedPointsGain: number; // incoming avg-per-GW minus outgoing, x horizon gameweeks - already unnormalized points
  hailMaryScoreDiff: number; // incoming current single-GW score minus outgoing
  // The 1-10 Hail Mary Rating trio (migration 0135) - used ONLY for the
  // reasoning sentence below, never fed into the weighted blend above.
  // expectedPointsGain/hailMaryScoreDiff stay exactly as they are: two
  // genuinely different real-points time horizons (multi-gameweek vs
  // single-gameweek), both legitimately comparable ACROSS positions in
  // this function's own cross-position normalized blend - rating is not
  // safe to compare across positions (see hailMaryRating.ts's own
  // docstring), so it can only ever be a per-candidate qualitative note,
  // never a blended numeric input.
  ratingGain: number | null; // incomingRating - outgoingRating, null if either side has no rating yet
  incomingRating: number | null;
  outgoingRating: number | null;
  fixtureSwingDiff: number; // incoming team's swingValue minus outgoing team's
  priceDelta: number; // incoming price minus outgoing price (positive = costs more)
  incomingMinutesSecurity: number; // 0-1, from LINEUP_SECURITY_SCORES
  outgoingMinutesSecurity: number; // 0-1
  incomingInjuryAvailability: number; // 0-1, from INJURY_AVAILABILITY_SCORES
  incomingForm: number | null;
  outgoingForm: number | null;
  incomingIsConfirmedStarter: boolean;
  hasFixtureData: boolean;
  hasStatusData: boolean; // real lineup/status captured for both players, not a fallback default
};

export type MoveReason = { code: string; text: string };

export type MoveScore = {
  outGamePlayerId: number;
  inGamePlayerId: number;
  overall: number; // 0-100, "Mary Move Score"
  confidence: number; // 0-100
  risk: "low" | "medium" | "high";
  reasons: MoveReason[]; // supporting, built from real factor values
  warnings: MoveReason[]; // risks/concerns, same
};

function computeMinMax(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

/**
 * Scores every candidate move against the rest of the moves being
 * considered for THIS squad right now (min-max normalized within that
 * set), not the whole player pool - a squad only has as many candidate
 * moves as it has players, so this is intentionally a small, per-request
 * comparison rather than a league-wide one.
 */
export function scoreMoveCandidates(candidates: MoveCandidateInput[], strategy: Strategy): MoveScore[] {
  const weights = STRATEGY_WEIGHTS[strategy];
  assertWeightsSumToOne(weights);
  if (candidates.length === 0) return [];

  const epRange = computeMinMax(candidates.map((c) => c.expectedPointsGain));
  const hmRange = computeMinMax(candidates.map((c) => c.hailMaryScoreDiff));
  const swingRange = computeMinMax(candidates.map((c) => c.fixtureSwingDiff));
  const securityGainRange = computeMinMax(candidates.map((c) => c.incomingMinutesSecurity - c.outgoingMinutesSecurity));

  const formGains = candidates.map((c) => (c.incomingForm ?? 0) - (c.outgoingForm ?? 0));
  const formRange = computeMinMax(formGains);

  // Saving money is treated as automatically good value rather than
  // divided by a near-zero price delta (which would spike toward
  // infinity) - a free upgrade or a cheaper sideways move both count as
  // efficient use of budget.
  const rawEfficiency = candidates.map((c) => (c.priceDelta <= 0 ? c.expectedPointsGain + 1 : c.expectedPointsGain / Math.max(c.priceDelta, 0.5)));
  const efficiencyRange = computeMinMax(rawEfficiency);

  return candidates.map((c, i) => {
    const ep = normalize(c.expectedPointsGain, epRange.min, epRange.max);
    const hm = normalize(c.hailMaryScoreDiff, hmRange.min, hmRange.max);
    const swing = normalize(c.fixtureSwingDiff, swingRange.min, swingRange.max);
    const securityGain = normalize(c.incomingMinutesSecurity - c.outgoingMinutesSecurity, securityGainRange.min, securityGainRange.max);
    const efficiency = normalize(rawEfficiency[i], efficiencyRange.min, efficiencyRange.max);
    const form = normalize(formGains[i], formRange.min, formRange.max);
    // Absolute 0-1 gates, not renormalized - a fully-fit incoming player
    // shouldn't be dragged toward 0.5 just because everyone else in this
    // squad's candidate set also happens to be fit right now.
    const injurySafety = c.incomingInjuryAvailability;
    const differential = c.incomingIsConfirmedStarter ? 0 : 1;

    const overall =
      100 *
      (weights.expectedPoints * ep +
        weights.hailMaryScore * hm +
        weights.fixtureSwing * swing +
        weights.minutesSecurity * securityGain +
        weights.priceEfficiency * efficiency +
        weights.form * form +
        weights.injurySafety * injurySafety +
        weights.differential * differential);

    // Confidence drops when the inputs behind a factor are genuinely
    // missing/defaulted, not when a factor is simply unfavourable -
    // "skip or lower confidence, never fake" for unavailable data.
    let confidence = 100;
    const warnings: MoveReason[] = [];
    if (!c.hasStatusData) {
      confidence -= 20;
      warnings.push({ code: "status_unconfirmed", text: `${c.inName}'s starting status hasn't been confirmed yet.` });
    }
    if (!c.hasFixtureData) {
      confidence -= 10;
      warnings.push({ code: "fixture_data_missing", text: "Fixture ratings aren't available yet for one of these clubs." });
    }
    if (c.incomingForm == null || c.outgoingForm == null) {
      confidence -= 10;
    }
    if (c.incomingInjuryAvailability < 1) {
      confidence -= 25;
      warnings.push({ code: "injury_risk", text: `${c.inName} is currently flagged as unavailable or a fitness doubt.` });
    }
    if (c.incomingMinutesSecurity < 0.75) {
      warnings.push({ code: "rotation_risk", text: `${c.inName} carries some rotation risk (not a confirmed starter).` });
    }
    if (c.outgoingMinutesSecurity >= 0.9 && c.incomingMinutesSecurity < c.outgoingMinutesSecurity) {
      warnings.push({ code: "trading_down_minutes", text: `${c.outName} currently has more secure minutes than ${c.inName}.` });
    }
    confidence = Math.max(20, Math.min(100, confidence));

    let risk: MoveScore["risk"] = "low";
    if (c.incomingInjuryAvailability < 1 || c.incomingMinutesSecurity < 0.5) risk = "high";
    else if (c.incomingMinutesSecurity < 0.85 || confidence < 70) risk = "medium";

    const reasons: MoveReason[] = [];
    // Gated on rating (a bucket move), not the old expectedPointsGain >
    // 0.05 fractional-point threshold - a rating-bucket move is a more
    // meaningful signal now that raw points aren't user-facing anywhere.
    if (c.ratingGain != null && c.ratingGain > 0 && c.incomingRating != null && c.outgoingRating != null) {
      reasons.push({
        code: "expected_points",
        text: `${c.inName} rates higher than ${c.outName} for the coming gameweeks (${c.incomingRating}/10 vs ${c.outgoingRating}/10).`,
      });
    }
    if (c.fixtureSwingDiff > 0.05) {
      reasons.push({ code: "fixture_swing", text: `${c.inTeam}'s fixture outlook is improving relative to ${c.outTeam}'s.` });
    }
    if (c.incomingMinutesSecurity - c.outgoingMinutesSecurity > 0.1) {
      reasons.push({ code: "minutes_security", text: `${c.inName} has stronger expected minutes than ${c.outName}.` });
    }
    if (c.priceDelta < 0) {
      reasons.push({ code: "frees_budget", text: `Frees up £${Math.abs(c.priceDelta).toFixed(1)}m in the bank.` });
    }
    if (differential === 1 && strategy === "differential") {
      reasons.push({ code: "differential_pick", text: `${c.inName} isn't yet a confirmed starter - a lower-profile pick with upside.` });
    }
    if (reasons.length === 0) {
      reasons.push({ code: "marginal", text: `A small projected upgrade over ${c.outName}.` });
    }

    return {
      outGamePlayerId: c.outGamePlayerId,
      inGamePlayerId: c.inGamePlayerId,
      overall: round1(overall),
      confidence: Math.round(confidence),
      risk,
      reasons,
      warnings,
    };
  });
}
