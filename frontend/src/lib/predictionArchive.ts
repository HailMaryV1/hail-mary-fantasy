export type PredictionReason = { code: string; text: string };

/**
 * One immutable row for the `predictions` table (migration 0033) - the
 * shape is deliberately generic (no Ask Mary / FanTeam-specific types
 * imported here) so a future recommendation engine for another game or
 * sport can produce the same shape without depending on Ask Mary's own
 * types, per the "future extensibility" requirement.
 */
export type PredictionRecord = {
  squadId: number;
  gameId: number;
  gameweek: number | null;
  season: string;
  algorithmVersionId: number | null;
  recommendationWeights: Record<string, number>;
  planningHorizon: number;
  strategy: string;
  transferLimit: number | null;

  kind: "transfer" | "captain" | "hold";
  recommendationType: string;
  rank: number | null;

  budgetRemainingBefore: number | null;
  freeTransfersBefore: number | null;

  outGamePlayerId: number | null;
  inGamePlayerId: number | null;
  outPrice: number | null;
  inPrice: number | null;
  transferCost: number | null;

  captainGamePlayerId: number | null;
  viceCaptainGamePlayerId: number | null;

  expectedPointsBefore: number | null;
  expectedPointsAfter: number | null;
  expectedGain: number | null;
  hailMaryScoreDiff: number | null;
  fixtureSwingDiff: number | null;
  maryMoveScore: number | null;
  confidence: number | null;
  risk: string | null;
  reasons: PredictionReason[];
  warnings: PredictionReason[];
};

/** Maps a PredictionRecord to `predictions` table column names for insert. */
export function toPredictionRow(r: PredictionRecord, userId: string) {
  return {
    user_id: userId,
    squad_id: r.squadId,
    game_id: r.gameId,
    gameweek: r.gameweek,
    season: r.season,
    algorithm_version_id: r.algorithmVersionId,
    recommendation_weights: r.recommendationWeights,
    planning_horizon: r.planningHorizon,
    strategy: r.strategy,
    transfer_limit: r.transferLimit,
    kind: r.kind,
    recommendation_type: r.recommendationType,
    rank: r.rank,
    budget_remaining_before: r.budgetRemainingBefore,
    free_transfers_before: r.freeTransfersBefore,
    out_game_player_id: r.outGamePlayerId,
    in_game_player_id: r.inGamePlayerId,
    out_price: r.outPrice,
    in_price: r.inPrice,
    transfer_cost: r.transferCost,
    captain_game_player_id: r.captainGamePlayerId,
    vice_captain_game_player_id: r.viceCaptainGamePlayerId,
    expected_points_before: r.expectedPointsBefore,
    expected_points_after: r.expectedPointsAfter,
    expected_gain: r.expectedGain,
    hail_mary_score_diff: r.hailMaryScoreDiff,
    fixture_swing_diff: r.fixtureSwingDiff,
    mary_move_score: r.maryMoveScore,
    confidence: r.confidence,
    risk: r.risk,
    reasons: r.reasons,
    warnings: r.warnings,
  };
}
