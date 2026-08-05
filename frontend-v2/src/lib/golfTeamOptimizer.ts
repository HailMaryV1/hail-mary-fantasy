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
 *
 * THE SIX VARIANTS BELOW ARE A PORTFOLIO, NOT SEVEN INTERCHANGEABLE
 * "PERSPECTIVES". With real money on 5-6 entries, the earlier
 * highest_projected/safest/highest_ceiling/best_value/balanced/
 * differential/fade_favourite set was really just several ways of
 * asking "what maximises the mean?" - and top-10 money in a real
 * tournament usually goes to 100+ point weeks, well above what any
 * mean-seeking projection alone predicts (confirmed via
 * /golf/algorithm-performance - see made_cut_branching_v1's own commit
 * history). So each variant here is deliberately built around a
 * DIFFERENT risk shape, using signals the algorithm already computes
 * (ceiling, floor, make-cut probability, bookmaker odds via
 * golfValuePicks.ts, course history) - not just relabelled means:
 *   - Ceiling Max: the outright-win bet, floor ignored entirely.
 *   - Bookies' Trust: leans hard on market odds over our own model -
 *     a hedge while the algorithm is still learning from few
 *     tournaments.
 *   - Cut-Secure Ceiling: upside gated by make-cut confidence - the
 *     longest runway to actually reach a big score.
 *   - Contrarian Value: cheap ceiling from golfers the market rates
 *     above their FanTeam price - genuine differentiation.
 *   - Floor Anchor: the insurance leg, still live if the others miss.
 *   - Course Specialists: heavy course-history + top20-odds weighting -
 *     proven form at this specific track.
 */

import { classifyMarketGap, type MarketGapInfo } from "./golfValuePicks";

export type GolfOptimizerPlayer = {
  gamePlayerId: number;
  fullName: string;
  price: number;
  expectedPoints: number;
  floor: number;
  ceiling: number;
  makeCutProbability: number | null;
  explanation?: string | null;
  // Bookies-vs-price-predicted info (see golfValuePicks.ts's
  // computeMarketGaps, fed whichever market pickBestMarket() picked) -
  // null/undefined when there's no odds for them. VALUE/DANGER
  // classification happens via classifyMarketGap(), not here.
  // marketGap.marketProbability (the raw bookmaker finish-position %,
  // independent of price) is what bookies_trust/course_specialists lean
  // on below.
  marketGap?: MarketGapInfo | null;
  // course_history_points_adjustment from compute_golf_projections.py's
  // inputs - a small, already-shrunk points delta (see that module's
  // docstring) already folded into expectedPoints. course_specialists
  // amplifies it for SELECTION purposes (see COURSE_HISTORY_AMPLIFY)
  // since its honest, conservative size wouldn't otherwise distinguish
  // this variant's picks. null when no course is linked or this golfer
  // has no history there.
  courseHistoryPoints?: number | null;
};

export const GOLF_SQUAD_SIZE = 6;

export type GolfTeamVariant =
  | "ceiling_max"
  | "bookies_trust"
  | "cut_secure_ceiling"
  | "contrarian_value"
  | "floor_anchor"
  | "course_specialists";

export const GOLF_TEAM_VARIANTS: { key: GolfTeamVariant; label: string; description: string }[] = [
  {
    key: "ceiling_max",
    label: "Ceiling Max",
    description: "Pure ceiling, floor ignored entirely - the outright-win bet, built for if everything breaks right",
  },
  {
    key: "bookies_trust",
    label: "Bookies' Trust",
    description: "Leans heavily on bookmaker finish-position odds over our own model - a hedge while the algorithm is still learning",
  },
  {
    key: "cut_secure_ceiling",
    label: "Cut-Secure Ceiling",
    description: "High upside gated by a high make-cut chance - the longest runway to reach a big score",
  },
  {
    key: "contrarian_value",
    label: "Contrarian Value",
    description: "Cheap ceiling from golfers the bookies rate above their FanTeam price - real differentiation, not just cheap",
  },
  {
    key: "floor_anchor",
    label: "Floor Anchor",
    description: "Maximises floor - the insurance leg that's still live if the other five miss",
  },
  {
    key: "course_specialists",
    label: "Course Specialists",
    description: "Weighs heavily on this course's history plus bookmaker odds - proven form at this specific track",
  },
];

// How strongly contrarian_value tilts toward ceiling-per-£ before
// spending pressure (see spendRemainingBudget) kicks in. A golfer priced
// at exactly the field's average ratio gets no adjustment; one at double
// the average ratio gets roughly a +VALUE_WEIGHT swing to their
// effective score, one at zero ratio gets roughly -VALUE_WEIGHT.
// Bounded and self-scaling (relative to the field, not an arbitrary
// point constant) rather than a magic number that'd need re-tuning if
// price/point scales ever shift.
const VALUE_WEIGHT = 0.3;

// Extra lean for contrarian_value specifically toward golfers already
// flagged VALUE (see golfValuePicks.ts) - stacks with VALUE_WEIGHT's
// price-efficiency lean above, since a value-flagged golfer being cheap
// AND market-endorsed is exactly this variant's whole point.
const CONTRARIAN_VALUE_FLAG_BONUS = 0.2;

// How heavily bookies_trust (and course_specialists, alongside its own
// course-history term) leans on a golfer's raw market top20 probability
// relative to the field average - deliberately stronger than
// VALUE_WEIGHT's 0.3, since "leans heavily on the bookies" is this
// variant's entire identity, not a minor nudge.
const BOOKIES_TRUST_WEIGHT = 0.6;

// course_specialists amplifies the (small, already-conservative)
// course_history_points_adjustment well beyond its honest size in
// expectedPoints - there's no principled "correct" amplification factor
// here (same spirit as MARKET_BLEND_WEIGHT in compute_golf_projections.py -
// an honest, documented assumption, not a fact), chosen so real course
// form actually moves this variant's picks rather than getting lost
// alongside everything else expectedPoints already accounts for.
const COURSE_HISTORY_AMPLIFY = 6;

// How hard the knapsack is nudged away from a DANGER-flagged golfer
// (>= DANGER_MIN_PRICE, market rates their top20 chance
// DANGER_GAP_THRESHOLD or more below what their price predicts) - a soft
// penalty on the SELECTION metric only, not the golfer's real
// expectedPoints/displayed score (that stays honest and untouched), and
// not a hard exclude either: the optimizer can still pick a danger-
// flagged golfer if they're genuinely the best of a bad set of options,
// same philosophy as VALUE_WEIGHT's soft nudge above rather than a
// price cutoff that could leave no legal team at all.
const DANGER_PENALTY = 0.15;

/** (marketProbability - field average) / field average - the relative signal bookies_trust/course_specialists lean on, 0 when this golfer has no odds pasted (silence isn't evidence, so no adjustment rather than a penalty). */
function relativeMarketBonus(p: GolfOptimizerPlayer, meanMarketProb: number): number {
  const prob = p.marketGap?.marketProbability;
  if (prob == null || meanMarketProb <= 0) return 0;
  return (prob - meanMarketProb) / meanMarketProb;
}

function rawMetric(variant: GolfTeamVariant, p: GolfOptimizerPlayer, meanRatio: number, meanMarketProb: number): number {
  switch (variant) {
    case "ceiling_max":
      return p.ceiling;
    case "floor_anchor":
      return p.floor;
    case "cut_secure_ceiling": {
      // A probability-weighted mix of the big upside (if the cut is
      // made) and the safe floor (if it isn't) - rewards genuinely high
      // floor+ceiling+cut-probability golfers, and naturally discounts
      // boom-or-bust picks with a big raw ceiling but a low chance of
      // ever reaching the weekend to use it.
      const cutProb = p.makeCutProbability ?? 0;
      return cutProb * p.ceiling + (1 - cutProb) * p.floor;
    }
    case "bookies_trust":
      return p.expectedPoints * (1 + BOOKIES_TRUST_WEIGHT * relativeMarketBonus(p, meanMarketProb));
    case "contrarian_value": {
      const ratio = p.price > 0 ? p.ceiling / p.price : 0;
      const relativeValue = meanRatio > 0 ? (ratio - meanRatio) / meanRatio : 0;
      const valueFlagBonus = classifyMarketGap(p.price, p.marketGap) === "value" ? CONTRARIAN_VALUE_FLAG_BONUS : 0;
      return p.ceiling * (1 + VALUE_WEIGHT * relativeValue + valueFlagBonus);
    }
    case "course_specialists":
      return (
        p.expectedPoints +
        COURSE_HISTORY_AMPLIFY * (p.courseHistoryPoints ?? 0) +
        p.expectedPoints * BOOKIES_TRUST_WEIGHT * relativeMarketBonus(p, meanMarketProb)
      );
  }
}

function baseMetric(variant: GolfTeamVariant, p: GolfOptimizerPlayer, meanRatio: number, meanMarketProb: number): number {
  const raw = rawMetric(variant, p, meanRatio, meanMarketProb);
  return classifyMarketGap(p.price, p.marketGap) === "danger" ? raw * (1 - DANGER_PENALTY) : raw;
}

function meanRatioFor(variant: GolfTeamVariant, pool: GolfOptimizerPlayer[]): number {
  if (variant !== "contrarian_value") return 0;
  const ratios = pool.filter((p) => p.price > 0).map((p) => p.ceiling / p.price);
  return ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
}

function meanMarketProbFor(variant: GolfTeamVariant, pool: GolfOptimizerPlayer[]): number {
  if (variant !== "bookies_trust" && variant !== "course_specialists") return 0;
  const probs = pool.map((p) => p.marketGap?.marketProbability).filter((x): x is number => x != null);
  return probs.length > 0 ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;
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
  // "average points-per-£"/"average market top20%" tracks whatever this
  // tournament's actual pricing/odds look like.
  const meanRatio = meanRatioFor(variant, unlocked);
  const meanMarketProb = meanMarketProbFor(variant, unlocked);

  const remainingSlots = GOLF_SQUAD_SIZE - locked.length;
  const remainingBudgetUnits = toUnits(budget) - toUnits(lockedPrice);
  if (remainingBudgetUnits < 0) return null;

  const picked = knapsack(unlocked, remainingSlots, remainingBudgetUnits, (p) => baseMetric(variant, p, meanRatio, meanMarketProb));
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
