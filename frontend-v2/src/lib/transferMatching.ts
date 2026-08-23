import type { FormStatus } from "./hailMaryForm";

export type TransferCandidate = {
  gamePlayerId: number;
  fullName: string;
  teamId: number;
  teamName: string;
  price: number;
  score: number;
  /** The 1-10 Hail Mary Rating (migration 0135) - the primary sort/gate
   * key for every function below now (score stays the tiebreak within a
   * tied rating - see pruneDominatedCandidates/findBuyCandidatesForOutgoing).
   * Comparisons here are always within one position (every caller filters
   * p.position === outgoing.position first), which is exactly rating's
   * own safe reference frame - see hailMaryRating.ts's own docstring for
   * why it's unsafe to compare ratings ACROSS positions. */
  rating: number | null;
  position: "GK" | "DEF" | "MID" | "FWD";
  formStatus?: FormStatus | null;
};

export type SquadMember = TransferCandidate;

export type MatchResult<T> = { candidate: T; delta: number };

/**
 * Drops every candidate that's Pareto-dominated by a cheaper-or-equal one
 * that scores the same or better - a rational buyer never prefers the
 * dominated option, so it should never win a search either. This is the
 * actual fix for a real reported case (2026-08-10): several near-
 * identical low-ceiling bench forwards (all ~2.1 projected pts) were
 * candidates for the same slot, and the search picked one of the pricier
 * ones purely because its raw score happened to round a hair higher -
 * with nothing to show for the extra spend. Sorting by price ascending
 * and keeping only strictly-improving scores as we go is the standard
 * skyline/Pareto-frontier computation, and it collapses that whole tied
 * cluster down to whichever is cheapest, while leaving genuine quality
 * tiers (a real starter at a real premium) completely untouched - a
 * higher-scoring candidate always survives regardless of price, this only
 * removes candidates that are strictly worse value than another option.
 */
export function pruneDominatedCandidates<T extends { price: number; score: number; rating: number | null }>(candidates: T[]): T[] {
  const byPrice = [...candidates].sort((a, b) => a.price - b.price);
  const kept: T[] = [];
  let bestRatingSoFar = -Infinity;
  let bestScoreAtThatRating = -Infinity;
  for (const c of byPrice) {
    const rating = c.rating ?? -Infinity;
    // Rating-primary, score-tiebreak within a tied rating - a real
    // improvement over the pure-score version for the bug this function
    // exists to fix: near-identical scorers now naturally share one
    // rating bucket and dedupe by price directly, instead of an
    // arbitrary fractional-point difference deciding survival.
    const improves = rating > bestRatingSoFar || (rating === bestRatingSoFar && c.score > bestScoreAtThatRating);
    if (improves) {
      kept.push(c);
      // Either a strictly new (higher) rating tier - score resets to this
      // candidate's own - or a same-tier improvement, where c.score is
      // already > the old bestScoreAtThatRating by the condition above.
      // Both cases land on the same assignment.
      bestScoreAtThatRating = c.score;
      bestRatingSoFar = rating;
    }
  }
  return kept;
}

/**
 * Given ONE fixed outgoing squad player, find every pool candidate that
 * could legally replace them (same position, budget/club-limit valid,
 * strictly better score), best-first.
 */
export function findBuyCandidatesForOutgoing(
  pool: TransferCandidate[],
  outgoing: SquadMember,
  squadIds: Set<number>,
  budgetRemaining: number,
  clubCounts: Map<number, number>,
  maxPerClub: number | null
): MatchResult<TransferCandidate>[] {
  const affordableBudget = budgetRemaining + outgoing.price;

  const candidates = pool.filter((p) => {
    if (squadIds.has(p.gamePlayerId)) return false;
    if (p.position !== outgoing.position) return false;
    if (p.price > affordableBudget) return false;
    if (maxPerClub) {
      const clubCountWithoutOut = (clubCounts.get(p.teamId) ?? 0) - (p.teamId === outgoing.teamId ? 1 : 0);
      if (clubCountWithoutOut + 1 > maxPerClub) return false;
    }
    // Rating-primary upgrade gate: a same-rating-but-higher-score
    // candidate still counts as a real (if small) upgrade; a same-rating-
    // and-not-higher-score one doesn't. Falls back to score-only if
    // either side has no rating yet (not recomputed this run).
    if (p.rating != null && outgoing.rating != null) {
      return p.rating > outgoing.rating || (p.rating === outgoing.rating && p.score > outgoing.score);
    }
    return p.score > outgoing.score;
  });

  candidates.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score);
  return candidates.map((candidate) => ({ candidate, delta: candidate.score - outgoing.score }));
}

/**
 * Every pool candidate LEGALLY able to replace one outgoing squad player -
 * same position, budget/club-limit valid - with no requirement that the
 * replacement actually be better, best-first by score. This is the manual-
 * browse counterpart to findBuyCandidatesForOutgoing above: that function
 * is deliberately upgrade-only because it drives Mary's automated
 * recommendations, which should never suggest a lateral or worse move.
 * This one drives a human picking from the pool themselves.
 *
 * `contestedPairs` (game_player_id -> game_player_id, both directions - see
 * rotationRisk.ts's buildContestedGamePlayerPairs) is optional and only
 * ever passed by the 3 real-Premier-League games (dreamteam/fanteam/
 * cloudff - see feedback_data_source_scope_correlation, the lineup-
 * probability data has zero EFL coverage). When present, a candidate whose
 * real rotation-battle rival is already elsewhere in the squad is filtered
 * out - the fix for a real reported case (2026-08-09): Mary kept
 * recommending both Cherki and Foden, who by the source data's own model
 * are competing for the same slot and can't both start.
 *
 * `highRiskGamePlayerIds` (see rotationRisk.ts's buildHighRiskGamePlayerIds,
 * same 3-game scope) excludes a candidate genuinely unlikely to start at
 * all, independent of any specific contender already being owned - the fix
 * for a second reported case the same day: a 20%-to-start player must never
 * be a fresh Mary recommendation, contested pair or not.
 */
export function findLegalReplacementsForOutgoing(
  pool: TransferCandidate[],
  outgoing: SquadMember,
  squadIds: Set<number>,
  budgetRemaining: number,
  clubCounts: Map<number, number>,
  maxPerClub: number | null,
  contestedPairs?: Map<number, number>,
  highRiskGamePlayerIds?: Set<number>
): MatchResult<TransferCandidate>[] {
  const affordableBudget = budgetRemaining + outgoing.price;

  const candidates = pool.filter((p) => {
    if (squadIds.has(p.gamePlayerId)) return false;
    if (p.position !== outgoing.position) return false;
    if (p.price > affordableBudget) return false;
    if (maxPerClub) {
      const clubCountWithoutOut = (clubCounts.get(p.teamId) ?? 0) - (p.teamId === outgoing.teamId ? 1 : 0);
      if (clubCountWithoutOut + 1 > maxPerClub) return false;
    }
    if (contestedPairs) {
      const contenderId = contestedPairs.get(p.gamePlayerId);
      if (contenderId != null && contenderId !== outgoing.gamePlayerId && squadIds.has(contenderId)) return false;
    }
    if (highRiskGamePlayerIds?.has(p.gamePlayerId)) return false;
    return true;
  });

  const pruned = pruneDominatedCandidates(candidates);
  pruned.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score);
  return pruned.map((candidate) => ({ candidate, delta: candidate.score - outgoing.score }));
}
