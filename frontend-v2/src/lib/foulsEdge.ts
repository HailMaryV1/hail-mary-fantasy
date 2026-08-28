/**
 * foulsEdge.ts
 * ---------------------------------------------------------------------------
 * Edge finder for bookmaker FOULS ladders - "Fouls Committed" and "To Be
 * Fouled", both offered as a 1+/2+/3+/4+/5+ price ladder per player.
 *
 * Deliberately standalone: no Supabase, no React, no network. Boards reach it
 * either from SportMonks' bet365 feed (see sportmonksFouls.ts) or pasted by
 * hand, and every number below is derived from that board plus the lineups.
 * Nothing here consults a foul model of our own; that is the point - the edge
 * is the bookmaker's own internal inconsistency, not a claim to know fouls
 * better than they do.
 *
 * THREE INDEPENDENT EDGE SOURCES, in increasing order of strength:
 *
 * 1. LADDER SHAPE. A ladder is a survival function: P(X>=1) >= P(X>=2) >= ...
 *    A single count distribution generates all five rungs, so five prices carry
 *    one real free parameter (the player's expected fouls). Fit that parameter
 *    and any rung sitting off the fitted curve is mispriced against the
 *    bookmaker's own other four prices.
 *
 * 2. CONSERVATION. Every foul has exactly one committer and (mostly) one
 *    recipient, so sum(E[committed] over team A's XI) must equal
 *    sum(E[to be fouled] over team B's XI), up to the share of fouls with no
 *    fouled player (handball, dissent, dangerous play - see ATTRIBUTION_RATE).
 *    The book prices those two sides as ~200 independent rungs and cannot hold
 *    them consistent. Reconciling them anchors every player's expected count to
 *    two separately-priced sources instead of one.
 *
 * 3. DUELS. Conservation again, but localised: the fouls a full-back commits
 *    are overwhelmingly suffered by the winger they are matched against. The
 *    formation turns one match-level constraint into a dozen zone-level ones,
 *    which bite harder than the aggregate because a board can satisfy the
 *    match total while being badly wrong flank by flank.
 *
 * Correlation is handled by a shared match-intensity factor (see
 * simulateBoard) rather than by multiplying independent legs - a scrappy
 * referee lifts every leg on the board at once, and a bet builder priced as if
 * legs were independent is the most common way value is given away here.
 */

/* ========================================================================== *
 * Odds primitives
 * ========================================================================== */

export type OddsQuote = {
  /** The "N+" line this quote is for. */
  line: number;
  /** Exactly as posted, e.g. "8/15". Null when the rung is suspended. */
  fractional: string | null;
  /** Fractional converted to decimal (stake returned included). */
  decimal: number | null;
  /** Bookmaker has locked/suspended this rung - no price available. */
  suspended: boolean;
};

export type PlayerLadder = {
  name: string;
  shirt?: number | null;
  /** Team key; must match the formation's team key. */
  team: string;
  quotes: OddsQuote[];
};

export type FoulsMarket = "committed" | "toBeFouled";

export type Board = {
  home: string;
  away: string;
  kickoff?: string | null;
  committed: PlayerLadder[];
  toBeFouled: PlayerLadder[];
};

/**
 * Fractional -> decimal. Accepts "5/2", "evens"/"evs", and a bare decimal so a
 * board pasted from a decimal-odds account still works.
 */
export function toDecimal(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === "evens" || s === "evs" || s === "even") return 2;
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*[/-]\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const num = parseFloat(frac[1]);
    const den = parseFloat(frac[2]);
    if (!isFinite(num) || !isFinite(den) || den <= 0) return null;
    return num / den + 1;
  }
  const dec = parseFloat(s);
  // A bare number below 1.01 cannot be a real decimal price; reject rather
  // than silently treating a stray table number as odds.
  if (isFinite(dec) && dec >= 1.01) return dec;
  return null;
}

/**
 * The fractional prices British bookmakers actually print, smallest to
 * largest. Snapping to this list rather than approximating freely is what
 * stops the board showing something like 33/50, which is arithmetically a fine
 * rendering of 1.66 and a price no book has ever displayed - it should read
 * 2/3, and it has to match the bookmaker's screen to be checkable at a glance.
 */
const FRACTIONAL_LADDER: [number, number][] = [
  [1, 100], [1, 66], [1, 50], [1, 40], [1, 33], [1, 28], [1, 25], [1, 22], [1, 20],
  [1, 18], [1, 16], [1, 14], [1, 12], [1, 11], [1, 10], [1, 9], [1, 8], [1, 7],
  [2, 13], [1, 6], [2, 11], [1, 5], [2, 9], [1, 4], [2, 7], [3, 10], [1, 3],
  [4, 11], [2, 5], [4, 9], [1, 2], [8, 15], [4, 7], [8, 13], [2, 3], [8, 11],
  [4, 5], [5, 6], [10, 11], [1, 1], [21, 20], [11, 10], [6, 5], [5, 4], [11, 8],
  [7, 5], [3, 2], [8, 5], [13, 8], [7, 4], [9, 5], [15, 8], [2, 1], [21, 10],
  [11, 5], [9, 4], [12, 5], [5, 2], [11, 4], [3, 1], [10, 3], [7, 2], [4, 1],
  [9, 2], [5, 1], [11, 2], [6, 1], [13, 2], [7, 1], [15, 2], [8, 1], [17, 2],
  [9, 1], [10, 1], [11, 1], [12, 1], [14, 1], [16, 1], [18, 1], [20, 1], [22, 1],
  [25, 1], [28, 1], [33, 1], [40, 1], [50, 1], [66, 1], [80, 1], [100, 1],
  [150, 1], [200, 1],
];

/**
 * Decimal price -> the UK fractional a bookmaker would display.
 *
 * Needed because SportMonks' own `fractional` field is NOT UK fractional odds:
 * it renders the decimal as a fraction, so bet365's 1/2 arrives as "3/2" and
 * 9/4 as "13/4". Showing that straight through would make the board impossible
 * to check against the bookmaker's screen, which is the first thing anyone will
 * want to do.
 *
 * Snapping matters as much as converting, and decimals arrive rounded to two
 * places - 2/3 shows up as 1.66, not 1.6667 - so the nearest entry on the real
 * ladder is the right answer rather than the closest arithmetic approximation.
 */
export function decimalToFractional(decimal: number): string | null {
  if (!isFinite(decimal) || decimal <= 1) return null;
  const profit = decimal - 1;
  let best: [number, number] | null = null;
  let bestErr = Infinity;
  for (const [n, d] of FRACTIONAL_LADDER) {
    const err = Math.abs(n / d - profit);
    if (err < bestErr) {
      bestErr = err;
      best = [n, d];
    }
  }
  if (!best) return null;
  // Far outside the ladder (a price beyond 200/1) - render it plainly rather
  // than pinning it to the last rung and implying a precision we do not have.
  if (bestErr > Math.max(0.02, profit * 0.06)) {
    return profit >= 10 ? `${Math.round(profit)}/1` : null;
  }
  return `${best[0]}/${best[1]}`;
}

/** Decimal price -> implied probability, margin still included. */
export function impliedProb(decimal: number): number {
  return 1 / decimal;
}

/** Probability -> fair decimal price. */
export function fairPrice(p: number): number {
  return p > 0 ? 1 / p : Infinity;
}

/* ========================================================================== *
 * Negative binomial count model
 * ========================================================================== */

const LG_C = [
  76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
];

/** Lanczos log-gamma. */
function lgamma(x: number): number {
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += LG_C[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/**
 * Negative binomial (NB2) pmf, parameterised by mean `mu` and dispersion
 * `size` (variance = mu + mu^2/size). Fouls are overdispersed relative to
 * Poisson - a player either gets drawn into a running battle or does not - so
 * a pure Poisson systematically underprices the 3+/4+/5+ rungs. size -> inf
 * recovers Poisson.
 */
export function nbPmf(k: number, mu: number, size: number): number {
  if (k < 0) return 0;
  if (mu <= 0) return k === 0 ? 1 : 0;
  const lp =
    lgamma(k + size) -
    lgamma(size) -
    lgamma(k + 1) +
    size * Math.log(size / (size + mu)) +
    k * Math.log(mu / (size + mu));
  return Math.exp(lp);
}

/** P(X >= k) under NB2. */
export function nbSurvival(k: number, mu: number, size: number): number {
  if (k <= 0) return 1;
  let cdf = 0;
  for (let j = 0; j < k; j++) cdf += nbPmf(j, mu, size);
  return Math.max(0, Math.min(1, 1 - cdf));
}

/* ========================================================================== *
 * Margin model
 * ========================================================================== */

/**
 * Power ("Shin-style") margin. Each rung is a separate yes/no market and only
 * the yes side is ever shown, so a rung's margin cannot be stripped in
 * isolation the way a two-way market's can - there is no complementary price
 * to normalise against. What makes it recoverable is that all five rungs share
 * one underlying distribution: the margin is whatever constant exponent makes
 * the five posted prices consistent with a single count distribution.
 *
 *   posted = fair ^ kappa,  kappa in (0, 1]
 *
 * Chosen over a flat multiplicative loading for two reasons: it can never push
 * a probability above 1 (Joao Pedro at 1/16 is already 0.94 implied), and the
 * proportional overround it implies rises as the price lengthens, which is the
 * favourite-longshot bias books actually apply to these ladders.
 */
export function applyMargin(fair: number, kappa: number): number {
  return Math.pow(Math.max(1e-9, Math.min(1, fair)), kappa);
}

export function removeMargin(posted: number, kappa: number): number {
  return Math.pow(Math.max(1e-9, Math.min(1, posted)), 1 / kappa);
}

function logit(p: number): number {
  const q = Math.max(1e-6, Math.min(1 - 1e-6, p));
  return Math.log(q / (1 - q));
}

/* ========================================================================== *
 * Per-player ladder fit
 * ========================================================================== */

export type RungFit = {
  line: number;
  decimal: number;
  fractional: string | null;
  /** Implied probability straight off the posted price, margin included. */
  postedProb: number;
  /** Probability the fitted distribution says this rung deserves, margin re-applied. */
  modelPostedProb: number;
  /** Margin-free fair probability from the fitted distribution. */
  fairProb: number;
  /**
   * Positive => the book's price implies MORE probability than its own other
   * rungs support (price too short). Negative => too long, the side worth
   * backing.
   */
  residual: number;
};

export type LadderFit = {
  name: string;
  team: string;
  market: FoulsMarket;
  /** Expected fouls implied by the ladder as a whole, margin removed. */
  mu: number;
  /** Number of priced (non-suspended) rungs the fit had to work with. */
  observations: number;
  /** Root mean squared logit residual - how well one distribution explains the ladder. */
  rmse: number;
  rungs: RungFit[];
};

/**
 * Fit one player's expected fouls to their ladder, holding dispersion and
 * margin fixed at board-level values (see fitBoard). One free parameter across
 * up to five prices is what leaves residuals meaningful - fitting shape and
 * margin per player too would nail every ladder exactly and surface nothing.
 */
export function fitLadder(
  ladder: PlayerLadder,
  market: FoulsMarket,
  size: number,
  kappa: number,
): LadderFit | null {
  const priced = ladder.quotes.filter(
    (q): q is OddsQuote & { decimal: number } => !q.suspended && q.decimal != null,
  );
  if (priced.length === 0) return null;

  const targets = priced.map((q) => ({ line: q.line, p: impliedProb(q.decimal) }));

  const loss = (mu: number) =>
    targets.reduce((acc, t) => {
      const modelled = applyMargin(nbSurvival(t.line, mu, size), kappa);
      const d = logit(t.p) - logit(modelled);
      return acc + d * d;
    }, 0);

  // Golden-section on log(mu): the loss is smooth and unimodal in mu, and
  // searching in log space keeps resolution even for the 0.2-foul defenders.
  let lo = Math.log(0.02);
  let hi = Math.log(12);
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = hi - phi * (hi - lo);
  let b = lo + phi * (hi - lo);
  let fa = loss(Math.exp(a));
  let fb = loss(Math.exp(b));
  for (let i = 0; i < 90; i++) {
    if (fa < fb) {
      hi = b;
      b = a;
      fb = fa;
      a = hi - phi * (hi - lo);
      fa = loss(Math.exp(a));
    } else {
      lo = a;
      a = b;
      fa = fb;
      b = lo + phi * (hi - lo);
      fb = loss(Math.exp(b));
    }
  }
  const mu = Math.exp((lo + hi) / 2);

  const rungs: RungFit[] = priced.map((q) => {
    const fair = nbSurvival(q.line, mu, size);
    const modelPosted = applyMargin(fair, kappa);
    const posted = impliedProb(q.decimal);
    return {
      line: q.line,
      decimal: q.decimal,
      fractional: q.fractional,
      postedProb: posted,
      modelPostedProb: modelPosted,
      fairProb: fair,
      residual: logit(posted) - logit(modelPosted),
    };
  });

  const rmse = Math.sqrt(
    rungs.reduce((acc, r) => acc + r.residual * r.residual, 0) / rungs.length,
  );

  return {
    name: ladder.name,
    team: ladder.team,
    market,
    mu,
    observations: priced.length,
    rmse,
    rungs,
  };
}

/* ========================================================================== *
 * Board-level fit: recover shared dispersion and margin
 * ========================================================================== */

export type BoardFit = {
  /** Shared NB dispersion across every player on the board. */
  size: number;
  /** Margin exponent, solved per market to hit the assumed overround. */
  kappaCommitted: number;
  kappaToBeFouled: number;
  /** Realised overround per market, as a percentage. Should land on the assumption. */
  overroundCommitted: number;
  overroundToBeFouled: number;
  /** The overround that was assumed rather than fitted - see fitBoard. */
  assumedOverround: number;
  committed: LadderFit[];
  toBeFouled: LadderFit[];
};

function totalLoss(
  ladders: PlayerLadder[],
  market: FoulsMarket,
  size: number,
  kappa: number,
): number {
  let sum = 0;
  let n = 0;
  for (const l of ladders) {
    const fit = fitLadder(l, market, size, kappa);
    if (!fit) continue;
    sum += fit.rmse * fit.rmse * fit.rungs.length;
    n += fit.rungs.length;
  }
  return n > 0 ? sum / n : Infinity;
}

/**
 * Average proportional overround the fitted margin implies across a market's
 * priced rungs - a human-readable read on how hard the book is taxing this
 * board, and a sanity check that kappa landed somewhere believable.
 */
function overroundOf(fits: LadderFit[]): number {
  let acc = 0;
  let n = 0;
  for (const f of fits) {
    for (const r of f.rungs) {
      if (r.fairProb <= 0) continue;
      acc += r.postedProb / r.fairProb - 1;
      n++;
    }
  }
  return n > 0 ? (acc / n) * 100 : 0;
}

/**
 * Default assumed overround per rung, as a percentage. See fitBoard for why
 * this is assumed rather than fitted. Player-prop ladders are taxed harder
 * than a match-result market; high single digits to low teens is the normal
 * range, and 9% is a reasonable middle.
 */
export const DEFAULT_ASSUMED_OVERROUND = 9;

/**
 * Solve the margin exponent that makes a market's average overround land on
 * the target. Overround falls monotonically as kappa rises toward 1 (no
 * margin), so a plain bisection is enough.
 */
function solveKappa(
  ladders: PlayerLadder[],
  market: FoulsMarket,
  size: number,
  targetPct: number,
): number {
  const overroundAt = (kappa: number) => {
    const fits = ladders
      .map((l) => fitLadder(l, market, size, kappa))
      .filter((f): f is LadderFit => f !== null);
    return overroundOf(fits);
  };

  let lo = 0.5; // heavy margin
  let hi = 1.0; // no margin
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (overroundAt(mid) > targetPct) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Fit the board: ASSUME the margin, FIT the shape.
 *
 * This split is the important design decision in the whole file. Each rung is
 * a one-sided price, so margin and dispersion are not separately identifiable
 * from the ladder alone - the same five prices are equally well explained by
 * "fat tails, thin margin" or "thin tails, fat margin". Left free, the fit
 * takes the second reading and reports a 60%+ overround, which no bookmaker
 * charges, and every rung on the board then looks like a losing bet.
 *
 * The asymmetry that resolves it: getting the margin wrong shifts every edge
 * on the board by roughly the same amount, which leaves the RANKING intact.
 * Getting the dispersion wrong distorts the deep rungs relative to the shallow
 * ones, which corrupts exactly the comparison this tool exists to make. So
 * margin is pinned to a stated assumption and dispersion carries the fit.
 *
 * A consequence worth being explicit about: absolute edge percentages are only
 * as good as `assumedOverround`, and should be read as "relative to this
 * board" rather than as a claim about true expected value. The ordering of
 * edges is far more trustworthy than their level.
 */
export function fitBoard(
  board: Board,
  assumedOverround: number = DEFAULT_ASSUMED_OVERROUND,
): BoardFit {
  const sizes = [
    0.8, 1.0, 1.3, 1.6, 2.0, 2.5, 3.0, 4.0, 5.0, 6.5, 8.0, 10.0, 14.0, 20.0, 35.0, 60.0,
  ];

  let best = { size: 4, kC: 0.95, kF: 0.95, loss: Infinity };
  for (const size of sizes) {
    const kC = solveKappa(board.committed, "committed", size, assumedOverround);
    const kF = solveKappa(board.toBeFouled, "toBeFouled", size, assumedOverround);
    const loss =
      totalLoss(board.committed, "committed", size, kC) +
      totalLoss(board.toBeFouled, "toBeFouled", size, kF);
    if (loss < best.loss) best = { size, kC, kF, loss };
  }

  const committed = board.committed
    .map((l) => fitLadder(l, "committed", best.size, best.kC))
    .filter((f): f is LadderFit => f !== null);
  const toBeFouled = board.toBeFouled
    .map((l) => fitLadder(l, "toBeFouled", best.size, best.kF))
    .filter((f): f is LadderFit => f !== null);

  return {
    size: best.size,
    kappaCommitted: best.kC,
    kappaToBeFouled: best.kF,
    overroundCommitted: overroundOf(committed),
    overroundToBeFouled: overroundOf(toBeFouled),
    assumedOverround,
    committed,
    toBeFouled,
  };
}

/**
 * Share of a team's fouls committed by the ten outfield starters a board
 * prices. Substitutes account for most of the remainder and the keeper for a
 * little; roughly 14% between them over a season.
 */
export const STARTERS_SHARE = 0.86;

/**
 * Alternative to fitBoard: instead of assuming the bookmaker's margin, anchor
 * on how many fouls the match is expected to contain and let the margin fall
 * out of that.
 *
 * This exists because of what the assumed-margin fit revealed on a real board.
 * At an assumed 9% overround the committed side summed to 27.5 fouls from the
 * twenty priced starters, against a Premier League norm nearer 21 for complete
 * teams - implying either a board shaded by about a third, or a margin far
 * above the assumption. Those two readings are not separable from the prices,
 * so one of them has to be supplied.
 *
 * Anchoring here is the better trade. A bookmaker's internal margin is
 * unobservable and varies by market and by fixture. Expected fouls in a match
 * is an ordinary, checkable football quantity, and one a reader who knows the
 * referee, the two sides, and what is at stake can sharpen far beyond a league
 * average. The margin implied by that anchor is reported back, so an
 * implausible one (say 45%) is a signal the anchor was wrong rather than a
 * number to be quietly believed.
 *
 * @param expectedMatchFouls total fouls expected in the match, both full teams.
 */
export function fitBoardToTotal(
  board: Board,
  expectedMatchFouls: number,
  attribution = 0.9,
): BoardFit {
  const sizes = [
    0.8, 1.0, 1.3, 1.6, 2.0, 2.5, 3.0, 4.0, 5.0, 6.5, 8.0, 10.0, 14.0, 20.0, 35.0, 60.0,
  ];

  const muSum = (ladders: PlayerLadder[], market: FoulsMarket, size: number, kappa: number) =>
    ladders
      .map((l) => fitLadder(l, market, size, kappa))
      .filter((f): f is LadderFit => f !== null)
      .reduce((acc, f) => acc + f.mu, 0);

  // Lower kappa strips more margin, which lowers every fitted mu, so the
  // total is monotone in kappa and bisects cleanly.
  const solveForTotal = (
    ladders: PlayerLadder[],
    market: FoulsMarket,
    size: number,
    target: number,
  ) => {
    let lo = 0.3;
    let hi = 1.0;
    for (let i = 0; i < 44; i++) {
      const mid = (lo + hi) / 2;
      if (muSum(ladders, market, size, mid) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const committedTarget = expectedMatchFouls * STARTERS_SHARE;
  const fouledTarget = expectedMatchFouls * STARTERS_SHARE * attribution;

  let best = { size: 4, kC: 0.9, kF: 0.9, loss: Infinity };
  for (const size of sizes) {
    const kC = solveForTotal(board.committed, "committed", size, committedTarget);
    const kF = solveForTotal(board.toBeFouled, "toBeFouled", size, fouledTarget);
    const loss =
      totalLoss(board.committed, "committed", size, kC) +
      totalLoss(board.toBeFouled, "toBeFouled", size, kF);
    if (loss < best.loss) best = { size, kC, kF, loss };
  }

  const committed = board.committed
    .map((l) => fitLadder(l, "committed", best.size, best.kC))
    .filter((f): f is LadderFit => f !== null);
  const toBeFouled = board.toBeFouled
    .map((l) => fitLadder(l, "toBeFouled", best.size, best.kF))
    .filter((f): f is LadderFit => f !== null);

  return {
    size: best.size,
    kappaCommitted: best.kC,
    kappaToBeFouled: best.kF,
    overroundCommitted: overroundOf(committed),
    overroundToBeFouled: overroundOf(toBeFouled),
    // Not assumed in this mode - reported back so the caller can judge whether
    // the anchor produced a believable margin.
    assumedOverround: NaN,
    committed,
    toBeFouled,
  };
}
