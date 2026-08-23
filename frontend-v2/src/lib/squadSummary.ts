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
  // The 1-10 Hail Mary Rating (migration 0135) - individual-player
  // mentions below name this, never raw points. The squad-total sentence
  // stays in real points (confirmed with the user - "how many points
  // will this XI score" is a different question from "how good is each
  // player," and ratings can't be summed).
  rating: number | null;
};

export type SquadSummaryInput = {
  players: SquadSummaryPlayer[];
  totalProjectedPoints: number;
  teamValue: number;
  budgetRemaining: number;
  // false for a game with no price/budget system at all (EFL Fantasy -
  // see gameConfig.ts's hasBudget) - the opening sentence and the
  // stars-and-scrubs price-spread sentence would otherwise talk about a
  // meaningless £0.0m every time. Defaults true so every existing
  // caller's behavior is unchanged.
  hasBudget?: boolean;
  // The captain ACTUALLY set on the squad right now - not necessarily
  // Mary's optimal pick (the user can captain whoever they like), so the
  // sentence below only claims "highest-projected" when that's genuinely
  // true rather than asserting it unconditionally.
  captain: { fullName: string; score: number; rating: number | null } | null;
  topStrength: string | null; // health.strengths[0]
  topWeakness: string | null; // health.weaknesses[0]
  nextStepTransferCount: number | null; // gameweekPlan[0]?.transfers.length, null if no plan
  nextStepGameweek: number | null;
};

export function buildSquadSummary(input: SquadSummaryInput): string[] {
  const { players, totalProjectedPoints, teamValue, budgetRemaining, captain, topStrength, topWeakness, nextStepTransferCount, nextStepGameweek } = input;
  const hasBudget = input.hasBudget ?? true;

  const sentences: string[] = [];

  sentences.push(
    hasBudget
      ? `This squad is projected for ${totalProjectedPoints.toFixed(1)} points this gameweek, built on a squad value of £${teamValue.toFixed(1)}m with £${budgetRemaining.toFixed(1)}m still in the bank.`
      : `This squad is projected for ${totalProjectedPoints.toFixed(1)} points this gameweek.`
  );

  const topScorers = players
    .filter((p) => p.rating != null)
    .slice()
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 3);
  if (topScorers.length > 0) {
    const names = topScorers.map((p) => `${p.fullName} (${p.rating}/10)`).join(", ");
    sentences.push(`The squad leans on ${names} as its biggest projected contributors.`);
  }

  if (captain) {
    const isTopScorer = topScorers.length > 0 && topScorers[0].fullName === captain.fullName;
    sentences.push(
      isTopScorer && captain.rating != null
        ? `${captain.fullName} carries the armband as the highest-rated starter this gameweek at ${captain.rating}/10.`
        : captain.rating != null
          ? `${captain.fullName} is captain this gameweek, rated ${captain.rating}/10.`
          : `${captain.fullName} is captain this gameweek.`
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
