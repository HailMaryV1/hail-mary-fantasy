export type TransferCandidate = {
  gamePlayerId: number;
  fullName: string;
  teamId: number;
  teamName: string;
  price: number;
  score: number;
  position: "GK" | "DEF" | "MID" | "FWD";
};

export type SquadMember = TransferCandidate;

export type MatchResult<T> = { candidate: T; delta: number };

/**
 * Given ONE fixed outgoing squad player, find every pool candidate that
 * could legally replace them (same position, budget/club-limit valid,
 * strictly better score), best-first. Extracted from
 * squads/[id]/transfers/page.tsx's recommendation loop (previously
 * inline there) so both that page and the watchlist "Transfer In" flow
 * share one implementation of this filter logic instead of two copies.
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
 * The mirror image: given ONE fixed incoming player (a watchlist target),
 * find every current squad member who could legally make way for them
 * (same position, affordable once sold, club-limit valid), sorted so the
 * biggest net score gain - i.e. the incumbent with the lowest score in
 * that position - comes first.
 */
export function findSellCandidatesForTarget(
  squadPlayers: SquadMember[],
  target: TransferCandidate,
  budgetRemaining: number,
  clubCounts: Map<number, number>,
  maxPerClub: number | null
): MatchResult<SquadMember>[] {
  const candidates = squadPlayers.filter((out) => {
    if (out.position !== target.position) return false;
    if (budgetRemaining + out.price < target.price) return false;
    if (maxPerClub) {
      const clubCountAfter = (clubCounts.get(target.teamId) ?? 0) - (out.teamId === target.teamId ? 1 : 0) + 1;
      if (clubCountAfter > maxPerClub) return false;
    }
    return true;
  });

  candidates.sort((a, b) => a.score - b.score);
  return candidates.map((candidate) => ({ candidate, delta: target.score - candidate.score }));
}
