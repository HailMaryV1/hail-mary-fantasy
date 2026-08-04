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
 * strictly better score), best-first. Extracted from
 * squads/[id]/transfers/page.tsx's recommendation loop (previously
 * inline there) so it's one shared implementation of this filter logic
 * instead of duplicated copies.
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
 * This one drives a human picking from the pool themselves (the Transfer
 * Player / Remove Player actions on the squad page) - the same pattern
 * TransferBoard.tsx's own inline `canBringIn` check already used, factored
 * out here instead of staying a second copy.
 */
export function findLegalReplacementsForOutgoing(
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
    return true;
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((candidate) => ({ candidate, delta: candidate.score - outgoing.score }));
}
