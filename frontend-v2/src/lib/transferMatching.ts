import type { FormStatus } from "./hailMaryForm";

export type TransferCandidate = {
  gamePlayerId: number;
  fullName: string;
  teamId: number;
  teamName: string;
  price: number;
  score: number;
  position: "GK" | "DEF" | "MID" | "FWD";
  formStatus?: FormStatus | null;
};

export type SquadMember = TransferCandidate;

export type MatchResult<T> = { candidate: T; delta: number };

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
    return p.score > outgoing.score;
  });

  candidates.sort((a, b) => b.score - a.score);
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

  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((candidate) => ({ candidate, delta: candidate.score - outgoing.score }));
}
