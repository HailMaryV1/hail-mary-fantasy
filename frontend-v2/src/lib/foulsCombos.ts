/**
 * foulsCombos.ts
 * ---------------------------------------------------------------------------
 * Monte Carlo over the whole fouls board, so multi-leg bets can be priced with
 * the correlation they actually carry instead of by multiplying legs together.
 *
 * Why this matters more here than in most markets: fouls are driven by a shared
 * match state. A referee who blows for everything, a derby, a game that turns
 * scrappy after a red card - all of it lifts every foul leg on the board at
 * once. Legs are therefore POSITIVELY correlated, sometimes strongly, and a bet
 * builder that prices them as independent is quoting a price that is too short
 * relative to the true joint probability... except when it is too long, which
 * is the case worth finding.
 *
 * The correlation structure modelled:
 *
 *   match intensity   - one gamma factor scaling every player's expected fouls.
 *                       Captures referee, tempo, and how fractious the game is.
 *   team intensity    - a second, smaller factor per team. Captures a side
 *                       chasing the game and fouling more, or sitting deep.
 *   duel linkage      - a committer and the opponent they duel share fouls by
 *                       construction, since the same event lands on both boards.
 *
 * Nested legs on one player (1+ and 3+ together) are handled exactly: the
 * simulation draws one foul count per player per market, so P(1+ AND 3+)
 * comes out as P(3+) with no special-casing.
 */

import type { BoardFit, FoulsMarket } from "./foulsEdge";
import { nbPmf } from "./foulsEdge";
import type { BoardAnalysis, DuelReconciliation } from "./foulsMatchup";

/* ========================================================================== *
 * Seeded RNG and samplers
 * ========================================================================== */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia-Tsang gamma sampler, shape > 0, scale 1. */
function randGamma(rng: () => number, shape: number): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    return randGamma(rng, shape + 1) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = randn(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Knuth Poisson - fine for the small lambdas fouls produce. */
function randPoisson(rng: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 60) {
    // Normal approximation, only ever reached by a pathological board.
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * randn(rng)));
  }
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

/* ========================================================================== *
 * Legs
 * ========================================================================== */

export type Leg = {
  player: string;
  team: string;
  market: FoulsMarket;
  line: number;
  decimal: number;
  fractional?: string | null;
};

export function legKey(l: Leg): string {
  return `${l.market}|${l.player}|${l.line}+`;
}

export function legLabel(l: Leg): string {
  return `${l.player} ${l.line}+ ${l.market === "committed" ? "fouls committed" : "to be fouled"}`;
}

/* ========================================================================== *
 * Simulation
 * ========================================================================== */

export type SimOptions = {
  draws?: number;
  seed?: number;
  /**
   * Standard deviation of the match-wide intensity multiplier (mean 1). 0.22 is
   * the working default: it implies the roughest quartile of matches runs ~25%
   * more fouls than the calmest, which is the right order of magnitude for
   * referee-to-referee and fixture-to-fixture variation in a league season.
   * A stated assumption, not a fitted value - raise it for a derby, drop it for
   * a dead rubber with a lenient official.
   */
  matchIntensitySd?: number;
  /** Same idea, per team, layered on top of the match factor. */
  teamIntensitySd?: number;
  /** Share of fouls attributable to a specific fouled player; matches foulsMatchup. */
  attribution?: number;
};

export type SimResult = {
  draws: number;
  /** Marginal probability of each leg, straight from the simulation. */
  marginal: Map<string, number>;
  /** Per-draw hit vector per leg, kept so combos can be evaluated without re-simulating. */
  hits: Map<string, Uint8Array>;
  /** Simulated distribution of total match fouls across both priced XIs. */
  totalFouls: Float64Array;
  /**
   * Share of the fitted dispersion left over for shared intensity after each
   * player's idiosyncratic variance is accounted for. Near 0 means the ladder
   * implies players vary far more than matches do, and combo correlation will
   * be correspondingly weak.
   */
  sharedVarianceShare: number;
};

/**
 * Simulate the board at the level of individual fouls rather than per-player
 * counts.
 *
 * The first version of this simulated committed and to-be-fouled as two
 * separate counts that merely shared an intensity factor. That was wrong in a
 * way the numbers made obvious: a full-back committing a foul and the winger
 * he is marking being fouled are not two correlated events, they are ONE
 * event seen from both sides, and the separate-counts model priced that pair
 * at a correlation premium of 1.009 - effectively independent - when it should
 * be the strongest link on the board.
 *
 * So the unit of simulation is a duel cell from the IPF flow matrix: a draw of
 * how many fouls player i commits against player j. Player i's committed total
 * is the row sum, player j's suffered total is the column sum, and the two
 * boards balance by construction rather than by assumption.
 *
 * Variance is decomposed so the simulated marginals still match the ladder fit:
 *
 *   total dispersion (1/size, from the ladders)
 *     = match intensity + team intensity   <- shared, creates correlation
 *     + player idiosyncratic               <- whatever is left over
 *
 * If the shared components would exceed the total the ladders support, they are
 * scaled back rather than allowed to inflate the marginals past their prices.
 */
export function simulateBoard(
  analysis: BoardAnalysis,
  opts: SimOptions = {},
): SimResult {
  const draws = opts.draws ?? 40000;
  const rng = mulberry32(opts.seed ?? 20260824);
  const attribution = opts.attribution ?? 0.9;
  const fit = analysis.levelFit;

  // --- variance budget ---------------------------------------------------
  const totalVar = 1 / fit.size;
  let matchSd = opts.matchIntensitySd ?? 0.22;
  let teamSd = opts.teamIntensitySd ?? 0.12;
  let sharedVar = matchSd * matchSd + teamSd * teamSd;
  if (sharedVar > totalVar * 0.9) {
    // Shared intensity cannot exceed what the ladders' own dispersion allows,
    // or the simulated marginals drift off their posted prices.
    const scale = Math.sqrt((totalVar * 0.9) / sharedVar);
    matchSd *= scale;
    teamSd *= scale;
    sharedVar = matchSd * matchSd + teamSd * teamSd;
  }
  const idioVar = Math.max(0, totalVar - sharedVar);

  const matchShape = matchSd > 0 ? 1 / (matchSd * matchSd) : 0;
  const teamShape = teamSd > 0 ? 1 / (teamSd * teamSd) : 0;
  const idioShape = idioVar > 1e-9 ? 1 / idioVar : 0;

  // --- board layout ------------------------------------------------------
  const linesOf = new Map<string, number[]>();
  const teamOf = new Map<string, string>();
  const register = (market: FoulsMarket, fits: BoardFit["committed"]) => {
    for (const f of fits) {
      linesOf.set(`${market}|${f.name}`, f.rungs.map((r) => r.line));
      teamOf.set(`${market}|${f.name}`, f.team);
    }
  };
  register("committed", fit.committed);
  register("toBeFouled", fit.toBeFouled);

  const hits = new Map<string, Uint8Array>();
  for (const [key, lines] of linesOf) {
    for (const line of lines) hits.set(`${key}|${line}`, new Uint8Array(draws));
  }

  // Flow cells: every (committer, sufferer) pair the duel reconciliation found.
  type Cell = { committer: string; sufferer: string; team: string; mean: number };
  const cells: Cell[] = [];
  for (const d of analysis.duels) {
    for (const f of d.flows) {
      cells.push({
        committer: f.committer,
        sufferer: f.sufferer,
        team: d.committerTeam,
        mean: f.fouls,
      });
    }
  }

  // Fouls with no fouled player - handball, dissent, dangerous play. They land
  // on the committed board only, which is exactly why the two boards should not
  // sum to the same number.
  const unattributed = fit.committed.map((f) => ({
    player: f.name,
    team: f.team,
    mean: (analysis.consensusMu.get(`committed|${f.name}`) ?? f.mu) * (1 - attribution),
  }));

  const teams = Array.from(new Set(fit.committed.map((f) => f.team)));
  const totalFouls = new Float64Array(draws);

  const committedCount = new Map<string, number>();
  const sufferedCount = new Map<string, number>();

  for (let d = 0; d < draws; d++) {
    const matchFactor = matchShape > 0 ? randGamma(rng, matchShape) / matchShape : 1;
    const teamFactor = new Map<string, number>();
    for (const t of teams) {
      teamFactor.set(t, teamShape > 0 ? randGamma(rng, teamShape) / teamShape : 1);
    }
    // One idiosyncratic factor per committer, applied to every cell in their
    // row, so a player who is having a scrappy afternoon is scrappy against
    // everyone he faces rather than independently per opponent.
    const idio = new Map<string, number>();
    const idioOf = (p: string) => {
      let v = idio.get(p);
      if (v === undefined) {
        v = idioShape > 0 ? randGamma(rng, idioShape) / idioShape : 1;
        idio.set(p, v);
      }
      return v;
    };

    committedCount.clear();
    sufferedCount.clear();

    for (const c of cells) {
      const lambda = c.mean * matchFactor * (teamFactor.get(c.team) ?? 1) * idioOf(c.committer);
      const n = randPoisson(rng, lambda);
      if (n === 0) continue;
      committedCount.set(c.committer, (committedCount.get(c.committer) ?? 0) + n);
      sufferedCount.set(c.sufferer, (sufferedCount.get(c.sufferer) ?? 0) + n);
    }
    for (const u of unattributed) {
      const lambda = u.mean * matchFactor * (teamFactor.get(u.team) ?? 1) * idioOf(u.player);
      const n = randPoisson(rng, lambda);
      if (n > 0) committedCount.set(u.player, (committedCount.get(u.player) ?? 0) + n);
    }

    let total = 0;
    for (const [player, n] of committedCount) {
      total += n;
      const lines = linesOf.get(`committed|${player}`);
      if (!lines) continue;
      for (const line of lines) {
        if (n >= line) hits.get(`committed|${player}|${line}`)![d] = 1;
      }
    }
    for (const [player, n] of sufferedCount) {
      const lines = linesOf.get(`toBeFouled|${player}`);
      if (!lines) continue;
      for (const line of lines) {
        if (n >= line) hits.get(`toBeFouled|${player}|${line}`)![d] = 1;
      }
    }
    totalFouls[d] = total;
  }

  const marginal = new Map<string, number>();
  for (const [k, arr] of hits) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    marginal.set(k, s / arr.length);
  }

  return {
    draws,
    marginal,
    hits,
    totalFouls,
    sharedVarianceShare: totalVar > 0 ? sharedVar / totalVar : 0,
  };
}

/* ========================================================================== *
 * Combo evaluation
 * ========================================================================== */

export type ComboEvaluation = {
  legs: Leg[];
  /** True joint probability, correlation included. */
  jointProb: number;
  /** What you get by naively multiplying the legs' own probabilities. */
  independentProb: number;
  /**
   * jointProb / independentProb. Above 1 means the legs reinforce each other,
   * so a builder pricing them independently is offering a price LONGER than
   * fair - that is the value case. Below 1 means the opposite.
   */
  correlationPremium: number;
  /** Price you would get if the builder simply multiplied the posted legs. */
  naiveDecimal: number;
  /** What the combo is actually worth. */
  fairDecimal: number;
  /** Edge if the builder quotes the naive multiplied price. */
  edgeAtNaivePrice: number;
  /** True if two legs are the same player and market - one strictly implies the other. */
  hasNestedLegs: boolean;
};

export function evaluateCombo(sim: SimResult, legs: Leg[]): ComboEvaluation | null {
  const arrs: Uint8Array[] = [];
  for (const l of legs) {
    const a = sim.hits.get(`${l.market}|${l.player}|${l.line}`);
    if (!a) return null;
    arrs.push(a);
  }

  let joint = 0;
  for (let d = 0; d < sim.draws; d++) {
    let all = 1;
    for (const a of arrs) {
      if (!a[d]) {
        all = 0;
        break;
      }
    }
    joint += all;
  }
  const jointProb = joint / sim.draws;

  let independentProb = 1;
  for (const l of legs) {
    independentProb *= sim.marginal.get(`${l.market}|${l.player}|${l.line}`) ?? 0;
  }

  const naiveDecimal = legs.reduce((acc, l) => acc * l.decimal, 1);

  const seen = new Set<string>();
  let hasNestedLegs = false;
  for (const l of legs) {
    const k = `${l.market}|${l.player}`;
    if (seen.has(k)) hasNestedLegs = true;
    seen.add(k);
  }

  return {
    legs,
    jointProb,
    independentProb,
    correlationPremium: independentProb > 0 ? jointProb / independentProb : NaN,
    naiveDecimal,
    fairDecimal: jointProb > 0 ? 1 / jointProb : Infinity,
    edgeAtNaivePrice: jointProb * naiveDecimal - 1,
    hasNestedLegs,
  };
}

/**
 * Search combinations of the supplied candidate legs and return those with the
 * best edge assuming the builder multiplies the posted prices.
 *
 * Two legs on the same player and market are excluded: they are nested, so the
 * combination is just the longer leg with extra margin attached, and including
 * them would flood the results with fake "value" from the correlation premium
 * a nested pair mechanically produces.
 */
export function searchCombos(
  sim: SimResult,
  candidates: Leg[],
  opts: { maxLegs?: number; minLegs?: number; top?: number; minJointProb?: number } = {},
): ComboEvaluation[] {
  const maxLegs = Math.min(opts.maxLegs ?? 3, 4);
  const minLegs = opts.minLegs ?? 2;
  const top = opts.top ?? 20;
  const minJointProb = opts.minJointProb ?? 0.08;

  const results: ComboEvaluation[] = [];

  const recurse = (start: number, chosen: Leg[]) => {
    if (chosen.length >= minLegs) {
      // Copy: `chosen` is mutated by the push/pop below, so storing the live
      // reference would leave every returned combo holding the same (finally
      // empty) array.
      const ev = evaluateCombo(sim, chosen.slice());
      if (ev && !ev.hasNestedLegs && ev.jointProb >= minJointProb) results.push(ev);
    }
    if (chosen.length >= maxLegs) return;
    for (let i = start; i < candidates.length; i++) {
      const c = candidates[i];
      // Skip nesting at generation time rather than filtering after, so the
      // search does not waste its budget enumerating pairs it will discard.
      if (chosen.some((l) => l.player === c.player && l.market === c.market)) continue;
      chosen.push(c);
      recurse(i + 1, chosen);
      chosen.pop();
    }
  };
  recurse(0, []);

  results.sort((a, b) => b.edgeAtNaivePrice - a.edgeAtNaivePrice);
  return results.slice(0, top);
}

/* ========================================================================== *
 * Board-level diagnostics
 * ========================================================================== */

export type BoardTemperature = {
  /** Mean total fouls committed across both priced XIs, per the board. */
  impliedTotal: number;
  p10: number;
  p90: number;
  /**
   * Premier League matches average roughly 20-22 total fouls. The priced board
   * covers starting outfielders only, so it should land somewhat BELOW that -
   * keepers and substitutes are unpriced. A board summing above the league
   * average is running hot, which usually means the whole ladder is shaded and
   * the value is in laying rather than backing.
   */
  leagueReference: number;
  verdict: "hot" | "normal" | "cold";
};

export function boardTemperature(sim: SimResult, leagueReference = 21): BoardTemperature {
  const sorted = Array.from(sim.totalFouls).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  // Priced XIs exclude keepers and subs, so parity with the league average is
  // already hot; the bands below allow for that missing share.
  const expectedShare = 0.86;
  const ratio = mean / (leagueReference * expectedShare);
  return {
    impliedTotal: mean,
    p10: q(0.1),
    p90: q(0.9),
    leagueReference,
    verdict: ratio > 1.08 ? "hot" : ratio < 0.92 ? "cold" : "normal",
  };
}

export { nbPmf };
export type { DuelReconciliation };
