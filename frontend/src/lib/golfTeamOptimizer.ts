/**
 * FanTeam Golf's team-builder shape is genuinely simpler than football's
 * (see squadOptimizer.ts): no positions, no formations, no per-club
 * limit - just "pick SQUAD_SIZE golfers under BUDGET that maximise
 * <perspective>." No quota-bucketing needed, so this is closer to a plain
 * knapsack than football's multi-dimensional problem - same greedy
 * "start from the best-by-objective ignoring cost, then repeatedly
 * downgrade whichever single swap loses the least objective per pound
 * freed" technique as autoFillBestSquad, just without the position
 * buckets or club-limit pass.
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
};

export const GOLF_SQUAD_SIZE = 6;

export type GolfTeamVariant = "highest_projected" | "safest" | "highest_ceiling" | "best_value" | "balanced" | "differential";

export const GOLF_TEAM_VARIANTS: { key: GolfTeamVariant; label: string; description: string }[] = [
  { key: "highest_projected", label: "Highest Projected", description: "Maximises total expected FanTeam points" },
  { key: "safest", label: "Safest", description: "Maximises floor - the safe, made-the-cut-at-worst outcome" },
  { key: "highest_ceiling", label: "Highest Ceiling", description: "Maximises ceiling - built to win, not just cash" },
  { key: "best_value", label: "Best Value", description: "Maximises expected points per £ spent" },
  { key: "balanced", label: "Balanced", description: "Blends projection, floor and ceiling evenly" },
  { key: "differential", label: "Differential", description: "Cheap, high-ceiling picks - upside per £, not the obvious favourites" },
];

function objective(variant: GolfTeamVariant, p: GolfOptimizerPlayer): number {
  switch (variant) {
    case "highest_projected":
      return p.expectedPoints;
    case "safest":
      return p.floor;
    case "highest_ceiling":
      return p.ceiling;
    case "best_value":
      return p.price > 0 ? p.expectedPoints / p.price : 0;
    case "balanced":
      return 0.5 * p.expectedPoints + 0.25 * p.floor + 0.25 * p.ceiling;
    case "differential":
      // Ceiling per pound, not raw ceiling - a cheap golfer with a big
      // ceiling ranks above an expensive one with the same ceiling,
      // since the expensive one is the "obvious" pick most opponents
      // will already own; no ownership% data exists to do this more
      // directly (see the plan's data-availability notes).
      return p.price > 0 ? p.ceiling / p.price : 0;
  }
}

/**
 * Best SQUAD_SIZE-golfer team under budget for one ranking perspective.
 * lockedIds are always included (must still fit budget together);
 * excludedIds are never considered. Returns null only if locking more
 * golfers than fit the squad size, or the locked golfers alone already
 * bust the budget.
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

  const unlocked = candidates.filter((p) => !lockedIds.includes(p.gamePlayerId)).sort((a, b) => objective(variant, b) - objective(variant, a));

  let selected = locked.concat(unlocked.slice(0, GOLF_SQUAD_SIZE - locked.length));
  if (selected.length < GOLF_SQUAD_SIZE) return null; // not enough golfers in the pool at all

  const totalPrice = (list: GolfOptimizerPlayer[]) => list.reduce((s, p) => s + p.price, 0);

  let guard = 0;
  while (totalPrice(selected) > budget && guard++ < 400) {
    const ids = new Set(selected.map((p) => p.gamePlayerId));
    const swappable = selected.filter((p) => !lockedIds.includes(p.gamePlayerId));
    let bestSwap: { out: GolfOptimizerPlayer; in: GolfOptimizerPlayer; ratio: number } | null = null;

    for (const out of swappable) {
      for (const cand of unlocked) {
        if (ids.has(cand.gamePlayerId)) continue;
        if (cand.price >= out.price) continue;
        const priceSaved = out.price - cand.price;
        const objectiveLost = objective(variant, out) - objective(variant, cand);
        const ratio = objectiveLost / priceSaved; // lower is better - least value lost per pound freed
        if (!bestSwap || ratio < bestSwap.ratio) bestSwap = { out, in: cand, ratio };
      }
    }

    if (!bestSwap) return null; // budget infeasible with this pool/locks - no legal team exists
    selected = selected.filter((p) => p.gamePlayerId !== bestSwap!.out.gamePlayerId).concat(bestSwap.in);
  }

  return selected.map((p) => p.gamePlayerId);
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
