/**
 * Mary Performance Lab, Part 2 - reusable analytics over the prediction
 * archive (frontend/src/lib/predictionArchive.ts) and its evaluations.
 * Pure functions only, no Supabase calls - the page fetches rows, this
 * module turns them into the numbers the dashboard renders. Same
 * "service, not embedded-in-JSX logic" pattern as squadHealth.ts and
 * recommendationScoring.ts.
 */

export type PredictionEvalRow = {
  id: number;
  squadId: number;
  squadName: string;
  gameweek: number | null;
  algorithmVersionId: number | null;
  strategy: string;
  planningHorizon: number;
  kind: "transfer" | "captain" | "hold";
  recommendationType: string;
  maryMoveScore: number | null;
  confidence: number | null;
  risk: string | null;
  expectedGain: number | null;
  createdAt: string;
  outGamePlayerId: number | null;
  inGamePlayerId: number | null;
  captainGamePlayerId: number | null;
  viceCaptainGamePlayerId: number | null;
  // Whether the user actually made this move/captain choice on this
  // squad, reconciled against squad_transfers/squad_captain_history at
  // read time (not a stored flag) - null for hold predictions, where
  // "applied" isn't a meaningful question.
  applied: boolean | null;
  evaluation: {
    actualGain: number | null;
    predictionError: number | null;
    transferSuccess: boolean | null;
    captainActualPoints: number | null;
    viceCaptainActualPoints: number | null;
    captainSuccess: boolean | null;
    errorAttribution: string[];
  } | null;
};

// Below this many evaluated transfer predictions, an "Algorithm Health
// Score" would just be noise dressed up as a number - shown as
// unavailable rather than computed on too small a sample.
const HEALTH_SCORE_MIN_SAMPLE = 15;

export type LifetimeSummary = {
  totalPredictions: number;
  transferPredictions: number;
  evaluatedTransfers: number;
  transferSuccessRate: number | null;
  lifetimeTransferGain: number | null;
  averageExpectedGain: number | null;
  averageActualGain: number | null;
  predictionBias: number | null; // expected - actual, averaged; positive = Mary is typically too optimistic
  captainPredictions: number;
  evaluatedCaptains: number;
  captainSuccessRate: number | null;
  lifetimeCaptainGain: number | null; // sum of (captain - vice) actual points
  holdPredictions: number;
  averageConfidence: number | null;
  algorithmHealthScore: number | null;
  applicationRate: number | null; // fraction of transfer+captain predictions the user actually made
};

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeLifetimeSummary(rows: PredictionEvalRow[]): LifetimeSummary {
  const transfers = rows.filter((r) => r.kind === "transfer");
  const evaluatedTransfers = transfers.filter((r) => r.evaluation != null);
  const captains = rows.filter((r) => r.kind === "captain");
  const evaluatedCaptains = captains.filter((r) => r.evaluation != null);
  const holds = rows.filter((r) => r.kind === "hold");

  const actualGains = evaluatedTransfers.map((r) => r.evaluation!.actualGain).filter((v): v is number => v != null);
  const expectedGains = evaluatedTransfers
    .filter((r) => r.evaluation!.actualGain != null)
    .map((r) => r.expectedGain)
    .filter((v): v is number => v != null);
  const successes = evaluatedTransfers.filter((r) => r.evaluation!.transferSuccess != null);
  const successRate =
    successes.length > 0 ? successes.filter((r) => r.evaluation!.transferSuccess).length / successes.length : null;

  const averageActualGain = average(actualGains);
  const averageExpectedGain = average(expectedGains);
  const predictionBias = averageExpectedGain != null && averageActualGain != null ? averageExpectedGain - averageActualGain : null;

  const captainGains = evaluatedCaptains
    .filter((r) => r.evaluation!.captainActualPoints != null && r.evaluation!.viceCaptainActualPoints != null)
    .map((r) => r.evaluation!.captainActualPoints! - r.evaluation!.viceCaptainActualPoints!);
  const captainSuccesses = evaluatedCaptains.filter((r) => r.evaluation!.captainSuccess != null);
  const captainSuccessRate =
    captainSuccesses.length > 0
      ? captainSuccesses.filter((r) => r.evaluation!.captainSuccess).length / captainSuccesses.length
      : null;

  const confidences = rows.map((r) => r.confidence).filter((v): v is number => v != null);

  let algorithmHealthScore: number | null = null;
  if (evaluatedTransfers.length >= HEALTH_SCORE_MIN_SAMPLE && successRate != null && predictionBias != null) {
    const biasPenalty = Math.min(1, Math.abs(predictionBias) / 5);
    algorithmHealthScore = Math.round(100 * (0.6 * successRate + 0.4 * (1 - biasPenalty)));
  }

  const applicable = rows.filter((r) => r.applied != null);
  const applicationRate = applicable.length > 0 ? applicable.filter((r) => r.applied).length / applicable.length : null;

  return {
    totalPredictions: rows.length,
    transferPredictions: transfers.length,
    evaluatedTransfers: evaluatedTransfers.length,
    transferSuccessRate: successRate,
    lifetimeTransferGain: actualGains.length > 0 ? actualGains.reduce((a, b) => a + b, 0) : null,
    averageExpectedGain,
    averageActualGain,
    predictionBias,
    captainPredictions: captains.length,
    evaluatedCaptains: evaluatedCaptains.length,
    captainSuccessRate,
    lifetimeCaptainGain: captainGains.length > 0 ? captainGains.reduce((a, b) => a + b, 0) : null,
    holdPredictions: holds.length,
    averageConfidence: average(confidences),
    algorithmHealthScore,
    applicationRate,
  };
}

export type BreakdownRow = {
  key: string;
  label: string;
  count: number;
  evaluatedCount: number;
  successRate: number | null;
  averageGain: number | null;
};

/**
 * Groups all rows (any kind) by an arbitrary key, but only computes
 * success-rate/average-gain from the transfer-kind rows within each
 * group - those two concepts are transfer-specific (see
 * prediction_evaluations.transfer_success/actual_gain).
 */
export function breakdownBy(rows: PredictionEvalRow[], keyFn: (r: PredictionEvalRow) => string, labelFn?: (key: string) => string): BreakdownRow[] {
  const groups = new Map<string, PredictionEvalRow[]>();
  for (const r of rows) {
    const key = keyFn(r);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([key, groupRows]) => {
      const transfers = groupRows.filter((r) => r.kind === "transfer" && r.evaluation != null);
      const gains = transfers.map((r) => r.evaluation!.actualGain).filter((v): v is number => v != null);
      const successes = transfers.filter((r) => r.evaluation!.transferSuccess != null);
      return {
        key,
        label: labelFn ? labelFn(key) : key,
        count: groupRows.length,
        evaluatedCount: transfers.length,
        successRate: successes.length > 0 ? successes.filter((r) => r.evaluation!.transferSuccess).length / successes.length : null,
        averageGain: average(gains),
      };
    })
    .sort((a, b) => b.count - a.count);
}

export type VersionComparisonRow = {
  algorithmVersionId: number;
  versionLabel: string;
  evaluatedTransfers: number;
  successRate: number | null;
  averageGain: number | null;
};

const MIN_SAMPLE_FOR_COMPARISON = 5;

export function compareAlgorithmVersions(rows: PredictionEvalRow[], labelById: Map<number, string>): VersionComparisonRow[] {
  const byVersion = breakdownBy(
    rows.filter((r) => r.algorithmVersionId != null),
    (r) => String(r.algorithmVersionId)
  );
  return byVersion.map((b) => ({
    algorithmVersionId: Number(b.key),
    versionLabel: labelById.get(Number(b.key)) ?? `#${b.key}`,
    evaluatedTransfers: b.evaluatedCount,
    successRate: b.successRate,
    averageGain: b.averageGain,
  }));
}

export type VersionVerdict = {
  hasEnoughData: boolean;
  winner: VersionComparisonRow | null;
  improvement: number | null; // average-gain delta, winner minus other
};

/** Compares exactly two version rows (typically the two most recent). */
export function compareTwoVersions(a: VersionComparisonRow, b: VersionComparisonRow): VersionVerdict {
  if (a.evaluatedTransfers < MIN_SAMPLE_FOR_COMPARISON || b.evaluatedTransfers < MIN_SAMPLE_FOR_COMPARISON) {
    return { hasEnoughData: false, winner: null, improvement: null };
  }
  const aGain = a.averageGain;
  const bGain = b.averageGain;
  if (aGain == null || bGain == null) {
    return { hasEnoughData: false, winner: null, improvement: null };
  }
  const winner = aGain >= bGain ? a : b;
  const improvement = Math.abs(aGain - bGain);
  return { hasEnoughData: true, winner, improvement };
}
