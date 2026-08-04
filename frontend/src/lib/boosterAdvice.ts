// Dream Team's 3 season Boosters (rules section 1.2.5.8) - each
// evaluated as "how many extra points would this gameweek's starting XI
// be projected to score if I activated this booster now," using the same
// player_projection_summary data every other part of Ask Mary already
// trusts. Goal Bonus and 12th Man are real expected-value calculations.
// Max Captain is NOT - see its own doc comment below for why a point
// estimate can't honestly capture its value, and what this uses instead.

export type BoosterType = "goal_bonus" | "twelfth_man" | "max_captain";

export type BoosterOption = {
  booster: BoosterType;
  label: string;
  alreadyUsed: boolean;
  expectedGain: number;
  reasoning: string;
};

export type XIProjection = {
  game_player_id: number;
  full_name: string;
  isCaptain: boolean;
  goalProjected: number; // stats.goal.projected, summed across this gameweek's fixture(s)
  projectedScore: number; // this gameweek's overall hail_mary_score - NOT goalProjected, used for Max Captain
};

export type PoolProjection = {
  game_player_id: number;
  full_name: string;
  projectedScore: number; // this gameweek's hail_mary_score
};

/**
 * Goal Bonus (1.2.5.8): every goal scored by your XI this gameweek is
 * worth 9 instead of 6 (a real +3/goal), except the captain's (or vice-
 * captain's, if the captain doesn't play), which go from 12 to 18 (+6/
 * goal). A direct expected-value sum - goalProjected is already a real
 * per-gameweek probability-weighted rate from the projection engine, not
 * a guess.
 */
export function evaluateGoalBonus(startingXI: XIProjection[]): { gain: number; reasoning: string } {
  const gain = startingXI.reduce((sum, p) => sum + p.goalProjected * (p.isCaptain ? 6 : 3), 0);
  const topScorer = startingXI.slice().sort((a, b) => b.goalProjected - a.goalProjected)[0];
  const reasoning = topScorer
    ? `Projected +${gain.toFixed(1)} pts across your XI's goal threat this gameweek (${topScorer.full_name} carries the most of it).`
    : `Projected +${gain.toFixed(1)} pts across your XI's goal threat this gameweek.`;
  return { gain, reasoning };
}

/**
 * 12th Man (1.2.5.8): adds one extra player - any value, any position,
 * not captain-eligible - who scores real points alongside your normal
 * 11 this gameweek. Real rule places no budget or position constraint on
 * the pick, so the expected gain is simply the single highest-projected
 * player in the whole pool who isn't already in your XI.
 */
export function evaluateTwelfthMan(
  poolCandidates: PoolProjection[],
  startingXIIds: Set<number>
): { gain: number; reasoning: string; best: PoolProjection | null } {
  const eligible = poolCandidates.filter((p) => !startingXIIds.has(p.game_player_id));
  if (eligible.length === 0) return { gain: 0, reasoning: "No eligible 12th Man candidate found.", best: null };
  const best = eligible.reduce((a, b) => (b.projectedScore > a.projectedScore ? b : a));
  return {
    gain: best.projectedScore,
    reasoning: `${best.full_name} projects ${best.projectedScore.toFixed(1)} pts as your 12th Man this gameweek.`,
    best,
  };
}

/**
 * Max Captain (1.2.5.8): retroactively makes your gameweek's actual top
 * scorer the captain, after the fact. Its real value is a HEDGE against
 * captain-pick risk (your nominated captain blanking while someone else
 * on your team goes big), not an expected-points swing - since you
 * already captain your highest-projected player, the naive expected-value
 * comparison (top projection vs top projection) is ~0 by construction,
 * which would make this booster look worthless when the real site's own
 * managers clearly find it valuable in practice.
 *
 * What actually drives its value is how UNCERTAIN "who ends up top
 * scorer" really is - a close projected race between your captain and
 * your next-best options means a real chance someone else outscores them,
 * which Max Captain lets you capture after the fact; a clear standout
 * captain leaves nothing to hedge. This returns half the gap between your
 * captain's projection and the next-best starter's as a deliberately
 * conservative proxy for that hedge value - not a real expected-points
 * number, and labelled as such in the reasoning text so it's never
 * confused with the other two boosters' real EV calculations.
 */
export function evaluateMaxCaptain(startingXI: XIProjection[], captainProjected: number): { gain: number; reasoning: string } {
  const nonCaptainBest = startingXI
    .filter((p) => !p.isCaptain)
    .slice()
    .sort((a, b) => b.projectedScore - a.projectedScore)[0];
  if (!nonCaptainBest) return { gain: 0, reasoning: "Not enough starters to assess Max Captain." };

  const gap = Math.max(0, captainProjected - nonCaptainBest.projectedScore);
  const hedgeValue = gap * 0.5;
  return {
    gain: hedgeValue,
    reasoning:
      gap < 1
        ? `A close projected race for top scorer this gameweek - real hedge value if your captain blanks (not a guaranteed points swing).`
        : `Your captain looks like a clear standout this gameweek - little to hedge, Max Captain's real value is low here.`,
  };
}

export function rankBoosters(options: BoosterOption[]): BoosterOption[] {
  return options.slice().sort((a, b) => b.expectedGain - a.expectedGain);
}
