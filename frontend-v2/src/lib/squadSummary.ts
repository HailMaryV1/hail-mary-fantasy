/**
 * "Mary's Squad Summary" - a real, data-derived paragraph explaining why
 * the squad is built the way it is. Same house style as squadHealth.ts/
 * boosterAdvice.ts's reasoning strings: every sentence is generated from
 * an actual computed number, never templated filler - a squad with
 * nothing notable to say about a given angle just skips that sentence
 * rather than padding with a generic line.
 */

export type SquadSummaryPlayer = {
  fullName: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  price: number;
  score: number | null;
};

export type SquadSummaryInput = {
  players: SquadSummaryPlayer[];
  totalProjectedPoints: number;
  teamValue: number;
  budgetRemaining: number;
  // The captain ACTUALLY set on the squad right now - not necessarily
  // Mary's optimal pick (the user can captain whoever they like), so the
  // sentence below only claims "highest-projected" when that's genuinely
  // true rather than asserting it unconditionally.
  captain: { fullName: string; score: number } | null;
  topStrength: string | null; // health.strengths[0]
  topWeakness: string | null; // health.weaknesses[0]
  nextStepTransferCount: number | null; // gameweekPlan[0]?.transfers.length, null if no plan
  nextStepGameweek: number | null;
};

export function buildSquadSummary(input: SquadSummaryInput): string[] {
  const { players, totalProjectedPoints, teamValue, budgetRemaining, captain, topStrength, topWeakness, nextStepTransferCount, nextStepGameweek } = input;

  const sentences: string[] = [];

  sentences.push(
    `This squad is projected for ${totalProjectedPoints.toFixed(1)} points this gameweek, built on a squad value of £${teamValue.toFixed(1)}m with £${budgetRemaining.toFixed(1)}m still in the bank.`
  );

  const topScorers = players
    .filter((p) => p.score != null)
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 3);
  if (topScorers.length > 0) {
    const names = topScorers.map((p) => `${p.fullName} (${p.score!.toFixed(1)} pts)`).join(", ");
    sentences.push(`The squad leans on ${names} as its biggest projected contributors.`);
  }

  if (captain) {
    const isTopScorer = topScorers.length > 0 && topScorers[0].fullName === captain.fullName;
    sentences.push(
      isTopScorer
        ? `${captain.fullName} carries the armband as the highest-projected starter this gameweek at ${captain.score.toFixed(1)} pts.`
        : `${captain.fullName} is captain this gameweek, projected for ${captain.score.toFixed(1)} pts.`
    );
  }

  // Price allocation - how much of the budget sits in the top-3 most
  // expensive players, a real signal for "is this a stars-and-scrubs
  // squad or an even spread."
  const sortedByPrice = players.slice().sort((a, b) => b.price - a.price);
  const topThreeSpend = sortedByPrice.slice(0, 3).reduce((sum, p) => sum + p.price, 0);
  const totalSpend = teamValue;
  if (totalSpend > 0) {
    const shareOfBudget = topThreeSpend / totalSpend;
    if (shareOfBudget >= 0.4) {
      sentences.push(`It's a stars-and-scrubs build - the top 3 most expensive players (${sortedByPrice.slice(0, 3).map((p) => p.fullName).join(", ")}) account for ${Math.round(shareOfBudget * 100)}% of squad value.`);
    }
  }

  if (topStrength) sentences.push(topStrength);
  if (topWeakness) sentences.push(topWeakness);

  if (nextStepTransferCount != null && nextStepGameweek != null) {
    sentences.push(
      nextStepTransferCount > 0
        ? `Looking ahead, Mary's plan for GW${nextStepGameweek} recommends ${nextStepTransferCount} transfer${nextStepTransferCount === 1 ? "" : "s"} to build on this.`
        : `Looking ahead, Mary's plan is to hold for GW${nextStepGameweek} - nothing currently clears its own cost.`
    );
  }

  return sentences;
}
