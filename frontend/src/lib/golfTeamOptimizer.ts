/**
 * FanTeam Golf's team-builder shape is genuinely simpler than football's
 * (see squadOptimizer.ts): no positions, no formations, no per-club
 * limit - just "pick SQUAD_SIZE golfers under BUDGET that maximise
 * <perspective>." That's a textbook 0/1 knapsack with an exact-cardinality
 * constraint (exactly 6 items, not "up to 6"), which is small enough here
 * (a ~140-golfer pool, £100m budget in £0.1m units = 1000 budget states)
 * to solve EXACTLY with dynamic programming rather than a greedy
 * heuristic - the earlier greedy "start from the best-by-objective picks,
 * then downgrade the least-costly swap until under budget" approach was
 * provably not optimal: a real run showed "Highest Projected" scoring
 * LOWER total expected points than "Safest" found by coincidence, because
 * single-swap greedy descent can get stuck short of the true best
 * combination. The DP below always finds the actual maximum.
 *
 * Captain (x1.25) and Underdog (x1.25, automatic on your cheapest pick -
 * both confirmed live from FanTeam's own in-app rules screen, see
 * compute_golf_projections.py's docstring) are applied when SCORING a
 * candidate team (computeTeamTotal), not during selection - captain
 * choice barely changes which team is best (whoever's picked, the
 * highest scorer should be captain regardless of the exact multiplier),
 * but it does change the honest total shown to the user.
 */

export type GolfOptimizerPlayer = {
  gamePlayerId: number;
  fullName: string;
  price: number;
  expectedPoints: number;
  floor: number;
  ceiling: number;
  makeCutProbability: number | null;
  explanation?: string | null;
};

export const GOLF_SQUAD_SIZE = 6;

export type GolfTeamVariant = "highest_projected" | "safest" | "highest_ceiling" | "best_value" | "balanced" | "differential";

export const GOLF_TEAM_VARIANTS: { key: GolfTeamVariant; label: string; description: string }[] = [
  { key: "highest_projected", label: "Highest Projected", description: "Maximises total expected FanTeam points" },
  { key: "safest", label: "Safest", description: "Maximises floor - the safe, made-the-cut-at-worst outcome" },
  { key: "highest_ceiling", label: "Highest Ceiling", description: "Maximises ceiling - built to win, not just cash" },
  {
    key: "best_value",
    label: "Best Value",
    description: "Best total points from golfers with strong points-per-£ - not just the cheapest options, spends the full budget",
  },
  { key: "balanced", label: "Balanced", description: "Blends projection, floor and ceiling evenly" },
  {
    key: "differential",
    label: "Differential",
    description: "Best total ceiling from golfers who offer it cheaply - avoids the obvious, already-expensive favourites",
  },
];

// How strongly best_value/differential tilt toward points-per-£ before
// spending pressure (see below) kicks in. A golfer priced at exactly the
// field's average ratio gets no adjustment; one at double the average
// ratio gets roughly a +VALUE_WEIGHT swing to their effective score, one
// at zero ratio gets roughly -VALUE_WEIGHT. Bounded and self-scaling
// (relative to the field, not an arbitrary point constant) rather than
// a magic number that'd need re-tuning if price/point scales ever shift.
const VALUE_WEIGHT = 0.3;

// The metric actually being summed/maximised by the knapsack for each
// variant. best_value and differential deliberately do NOT filter out or
// cap expensive golfers, and do NOT maximise a raw per-player ratio
// either - either of those silently left most of the £100m budget unused
// (a team of 6 minimum-priced golfers can have the best summed ratio, or
// be the only golfers a "good ratio" cutoff allows through, while never
// pricing anywhere near the cap - both were real bugs here). Instead the
// per-player value is the SAME points/ceiling metric as the non-value
// variants, nudged by how much better- or worse-than-average that
// golfer's points-per-£ is - so the knapsack still feels the same "spend
// the budget on the best total" pressure as Highest Projected, just
// biased toward efficient golfers rather than the single most expensive
// ones when points are otherwise close.
function baseMetric(variant: GolfTeamVariant, p: GolfOptimizerPlayer, meanRatio: number): number {
  switch (variant) {
    case "highest_projected":
      return p.expectedPoints;
    case "safest":
      return p.floor;
    case "highest_ceiling":
      return p.ceiling;
    case "balanced":
      return 0.5 * p.expectedPoints + 0.25 * p.floor + 0.25 * p.ceiling;
    case "best_value": {
      const ratio = p.price > 0 ? p.expectedPoints / p.price : 0;
      const relativeValue = meanRatio > 0 ? (ratio - meanRatio) / meanRatio : 0;
      return p.expectedPoints * (1 + VALUE_WEIGHT * relativeValue);
    }
    case "differential": {
      const ratio = p.price > 0 ? p.ceiling / p.price : 0;
      const relativeValue = meanRatio > 0 ? (ratio - meanRatio) / meanRatio : 0;
      return p.ceiling * (1 + VALUE_WEIGHT * relativeValue);
    }
  }
}

function meanRatioFor(variant: GolfTeamVariant, pool: GolfOptimizerPlayer[]): number {
  if (variant !== "best_value" && variant !== "differential") return 0;
  const ratios = pool
    .filter((p) => p.price > 0)
    .map((p) => (variant === "best_value" ? p.expectedPoints / p.price : p.ceiling / p.price));
  return ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
}

// £0.1m is the real price granularity FanTeam uses - working in these
// units keeps the DP's budget dimension a small integer range instead of
// needing float-keyed state.
const PRICE_UNIT = 0.1;
const toUnits = (price: number) => Math.round(price / PRICE_UNIT);

/**
 * Exact 0/1 knapsack, cardinality-constrained to exactly `slots` items,
 * maximising the sum of `metric(item)` subject to total price <= budget.
 * dp[c][b] = best objective sum using exactly c items with price <= b
 * (in price units). Standard knapsack space optimisation: iterate items
 * in the outer loop, count and budget descending in the inner loops, so
 * each item is only ever considered "taken" once per solution.
 */
function knapsack(
  items: GolfOptimizerPlayer[],
  slots: number,
  budgetUnits: number,
  metric: (p: GolfOptimizerPlayer) => number
): GolfOptimizerPlayer[] | null {
  const NEG = -Infinity;
  const dp: number[][] = Array.from({ length: slots + 1 }, () => new Array(budgetUnits + 1).fill(NEG));
  const choice: GolfOptimizerPlayer[][][] = Array.from({ length: slots + 1 }, () =>
    Array.from({ length: budgetUnits + 1 }, () => [] as GolfOptimizerPlayer[])
  );
  dp[0].fill(0);

  for (const item of items) {
    const priceUnits = toUnits(item.price);
    if (priceUnits > budgetUnits) continue; // can never afford this one at all
    const value = metric(item);
    for (let c = slots; c >= 1; c--) {
      for (let b = budgetUnits; b >= priceUnits; b--) {
        const prev = dp[c - 1][b - priceUnits];
        if (prev === NEG) continue;
        const candidate = prev + value;
        if (candidate > dp[c][b]) {
          dp[c][b] = candidate;
          choice[c][b] = choice[c - 1][b - priceUnits].concat(item);
        }
      }
    }
  }

  // Best full-budget-or-under result at exactly `slots` items - dp is
  // non-decreasing in b for a fixed c (more budget can't make the best
  // achievable total worse), so the true max is at dp[slots][budgetUnits].
  if (dp[slots][budgetUnits] === NEG) return null;
  return choice[slots][budgetUnits];
}

/**
 * Given a selected team, repeatedly swap in any affordable pool golfer
 * who scores more raw expected points than someone currently in the
 * team, using whatever budget the initial selection left unspent.
 * FanTeam gives no reward for saving money, so leftover budget with a
 * genuine points upgrade still available on the table is never correct -
 * this matters most for best_value/differential, whose blended metric
 * intentionally trades some raw points for price efficiency and can
 * otherwise leave a meaningful amount unspent. Locked golfers are never
 * swapped out. Always compares on raw expectedPoints (not the variant's
 * own metric) - the point of this pass is specifically "don't leave cash
 * idle when it buys more points," not to re-run the variant's own logic.
 */
function spendRemainingBudget(
  team: GolfOptimizerPlayer[],
  pool: GolfOptimizerPlayer[],
  budget: number,
  lockedIds: number[]
): GolfOptimizerPlayer[] {
  let current = team.slice();
  let guard = 0;
  while (guard++ < 50) {
    const totalPrice = current.reduce((s, p) => s + p.price, 0);
    const remaining = budget - totalPrice;
    const ids = new Set(current.map((p) => p.gamePlayerId));
    let best: { out: GolfOptimizerPlayer; in: GolfOptimizerPlayer; gain: number } | null = null;

    for (const out of current) {
      if (lockedIds.includes(out.gamePlayerId)) continue;
      const affordableUpTo = out.price + remaining;
      for (const cand of pool) {
        if (ids.has(cand.gamePlayerId)) continue;
        if (cand.price > affordableUpTo) continue;
        const gain = cand.expectedPoints - out.expectedPoints;
        if (gain > 0 && (!best || gain > best.gain)) best = { out, in: cand, gain };
      }
    }

    if (!best) break;
    current = current.filter((p) => p.gamePlayerId !== best!.out.gamePlayerId).concat(best.in);
  }
  return current;
}

/**
 * Best SQUAD_SIZE-golfer team under budget for one ranking perspective.
 * lockedIds are always included (must still fit budget together);
 * excludedIds are never considered. Returns null only if locking more
 * golfers than fit the squad size, or no legal combination exists at all
 * (e.g. locks alone bust the budget, or too few golfers in the pool).
 */
export function buildGolfTeam(
  pool: GolfOptimizerPlayer[],
  variant: GolfTeamVariant,
  budget: number,
  lockedIds: number[] = [],
  excludedIds: number[] = []
): number[] | null {
  const excluded = new Set(excludedIds);
  const candidates = pool.filter((p) => !excluded.has(p.gamePlayerId));
  const locked = candidates.filter((p) => lockedIds.includes(p.gamePlayerId));
  if (locked.length > GOLF_SQUAD_SIZE) return null;
  const lockedPrice = locked.reduce((s, p) => s + p.price, 0);
  if (lockedPrice > budget) return null;

  const unlocked = candidates.filter((p) => !lockedIds.includes(p.gamePlayerId));

  // Computed once from the real candidate pool (not a fixed constant) so
  // "average points-per-£" tracks whatever this tournament's actual
  // pricing looks like.
  const meanRatio = meanRatioFor(variant, unlocked);

  const remainingSlots = GOLF_SQUAD_SIZE - locked.length;
  const remainingBudgetUnits = toUnits(budget) - toUnits(lockedPrice);
  if (remainingBudgetUnits < 0) return null;

  const picked = knapsack(unlocked, remainingSlots, remainingBudgetUnits, (p) => baseMetric(variant, p, meanRatio));
  if (!picked) return null;

  const final = spendRemainingBudget(locked.concat(picked), candidates, budget, lockedIds);
  return final.map((p) => p.gamePlayerId);
}

/**
 * Honest team total including FanTeam's real mechanics: captain (your
 * highest scorer, x1.25) and underdog (your cheapest pick, x1.25,
 * automatic - no action needed, see module docstring). If the same
 * golfer is both (a cheap captain pick), FanTeam's own rules don't say
 * the multipliers stack multiplicatively vs additively - conservatively
 * NOT stacked here (whichever bonus is larger wins) rather than guessing
 * a compounding rule with no confirmation either way.
 */
export function computeTeamTotal(
  team: GolfOptimizerPlayer[],
  captainOverrideId?: number | null
): { total: number; captainId: number | null; underdogId: number | null } {
  if (team.length === 0) return { total: 0, captainId: null, underdogId: null };
  // Captain is a real pre-tournament choice in FanTeam, not an automatic
  // mechanic like underdog (always the cheapest pick) - default to the
  // highest scorer only when the user hasn't picked one themselves, and
  // only honor the override if that golfer is actually still on the team
  // (a swap can knock the previously-picked captain out).
  const overridden = captainOverrideId != null ? team.find((p) => p.gamePlayerId === captainOverrideId) : undefined;
  const captain = overridden ?? team.reduce((best, p) => (p.expectedPoints > best.expectedPoints ? p : best), team[0]);
  const underdog = team.reduce((cheapest, p) => (p.price < cheapest.price ? p : cheapest), team[0]);

  let total = 0;
  for (const p of team) {
    const isCaptain = p.gamePlayerId === captain.gamePlayerId;
    const isUnderdog = p.gamePlayerId === underdog.gamePlayerId;
    const multiplier = isCaptain || isUnderdog ? 1.25 : 1.0;
    total += p.expectedPoints * multiplier;
  }
  return { total: Math.round(total * 100) / 100, captainId: captain.gamePlayerId, underdogId: underdog.gamePlayerId };
}
