/**
 * Golf "market gap" detector - flags golfers whose pasted finish-position
 * market odds (whichever one you actually pasted - win/top5/top10/top20)
 * disagree meaningfully with what their FanTeam price alone would
 * predict. Confirmed against the real Rocket Classic field (82 golfers
 * with both a price and top20 odds): price and market-implied
 * probability correlate at 0.94 - FanTeam clearly prices around market
 * perception, so a golfer sitting well off the price->probability line
 * the rest of the field draws is a real signal worth surfacing, in
 * EITHER direction:
 *
 *   - VALUE: market fancies them well above what their price predicts -
 *     a live badge (see classifyMarketGap()).
 *   - DANGER: an expensive golfer (>= DANGER_MIN_PRICE) the market rates
 *     well BELOW what their price predicts - a warning the price hasn't
 *     caught up with the market's real opinion. Price-gated because a
 *     cheap long-shot the market also dislikes isn't a mistake to avoid,
 *     it's just correctly priced as a long-shot - this only matters once
 *     real budget is on the line for a golfer FanTeam is charging a
 *     premium for.
 *
 * Recomputed fresh on every page load directly from golf_tournament_entries
 * (price) + golf_tournament_odds (whichever market pickBestMarket() picks -
 * see below) - deliberately NOT baked into compute_golf_projections.py's
 * Python pipeline, so a badge reflects odds the moment they're pasted
 * rather than waiting for the next projections recompute. The same gap
 * number also feeds golfTeamOptimizer.ts's DANGER_PENALTY, so a
 * price-gap-flagged golfer isn't just shown a warning - the team-builder
 * itself is nudged away from picking them (see baseMetric() there).
 *
 * Originally hardcoded to 'top20' only, on the assumption that would be
 * the one market actually pasted - wrong in practice (the Tournament
 * Builder wizard's odds step defaults to 'top10', and that's what got
 * pasted for the Wyndham Championship), so every VALUE/DANGER badge
 * silently found zero data. pickBestMarket() below picks whichever
 * market actually has odds for this tournament instead of assuming one.
 */

export type ValuePriceRow = { gamePlayerId: number; golferId: number; price: number };
export type ValueOddsRow = { golferId: number; impliedProbability: number | null };

// A golfer needs to sit at least 3 percentage points above what their
// price alone predicts to get flagged VALUE, so a badge means something.
export const VALUE_GAP_THRESHOLD = 0.03;

// DANGER needs the market at least 7.5 points below the price-predicted
// probability AND a price of at least £15m - both thresholds as
// specified, not independently tuned.
export const DANGER_GAP_THRESHOLD = -0.075;
export const DANGER_MIN_PRICE = 15.0;

// A regression over fewer than this many paired (price, odds) points is
// noise, not signal - most tournaments won't have odds pasted for every
// golfer in the field, and a handful of points can produce an
// arbitrarily steep/meaningless line.
const MIN_SAMPLE_SIZE = 8;

// The bookies' actual probability (whichever finish-position market got
// used), what this golfer's PRICE ALONE would predict for that
// probability (from the field's own price->odds line), and the
// difference between them - kept as three separate numbers (not just
// the gap) so the UI can say something concrete ("bookies say 23%,
// FanTeam's price says 9%") instead of just "+14pts".
export type MarketGapInfo = { gap: number; marketProbability: number; predictedProbability: number };

export type OddsRowWithMarket = { golferId: number; market: string; impliedProbability: number | null };

// Preference order for tie-breaking when two markets happen to have the
// same number of pasted rows for a tournament - a finish-position market
// (top10/top20) is the more directly comparable signal, 'win' is the
// least (far fewer golfers have a meaningful win probability at all).
const MARKET_PREFERENCE = ["top10", "top20", "top5", "win"];

/**
 * Picks whichever market actually has odds pasted for this tournament,
 * rather than assuming one. A real user pastes exactly one market most
 * weeks - whichever's easiest to find on a bookmaker's page that week -
 * so there's no fixed market to hardcode. Returns null when nothing's
 * been pasted at all yet.
 */
export function pickBestMarket(oddsRows: OddsRowWithMarket[]): string | null {
  const counts = new Map<string, number>();
  for (const o of oddsRows) {
    if (o.impliedProbability == null) continue;
    counts.set(o.market, (counts.get(o.market) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return MARKET_PREFERENCE.indexOf(a[0]) - MARKET_PREFERENCE.indexOf(b[0]);
  });
  return ranked[0][0];
}

/** gamePlayerId -> bookies-vs-price-predicted info, for every golfer with both a price and pasted odds in the chosen market - unfiltered/unthresholded, callers classify via classifyMarketGap(). */
export function computeMarketGaps(priceRows: ValuePriceRow[], oddsRows: ValueOddsRow[]): Map<number, MarketGapInfo> {
  const probByGolfer = new Map(oddsRows.filter((o) => o.impliedProbability != null).map((o) => [o.golferId, o.impliedProbability as number]));

  const paired = priceRows
    .map((p) => ({ ...p, prob: probByGolfer.get(p.golferId) }))
    .filter((p): p is ValuePriceRow & { prob: number } => p.prob != null);

  if (paired.length < MIN_SAMPLE_SIZE) return new Map();

  const n = paired.length;
  const meanPrice = paired.reduce((sum, p) => sum + p.price, 0) / n;
  const meanProb = paired.reduce((sum, p) => sum + p.prob, 0) / n;
  const covariance = paired.reduce((sum, p) => sum + (p.price - meanPrice) * (p.prob - meanProb), 0) / n;
  const priceVariance = paired.reduce((sum, p) => sum + (p.price - meanPrice) ** 2, 0) / n;
  if (priceVariance === 0) return new Map();

  const slope = covariance / priceVariance;
  const intercept = meanProb - slope * meanPrice;

  const gaps = new Map<number, MarketGapInfo>();
  for (const p of paired) {
    const predicted = intercept + slope * p.price;
    gaps.set(p.gamePlayerId, { gap: p.prob - predicted, marketProbability: p.prob, predictedProbability: predicted });
  }
  return gaps;
}

export type MarketGapFlag = "value" | "danger" | null;

/** Turns a golfer's market-gap info (from computeMarketGaps) + their price into the badge/penalty classification - the single source of truth both the UI badges and the team-builder's DANGER_PENALTY read from, so they can never disagree. */
export function classifyMarketGap(price: number, info: MarketGapInfo | null | undefined): MarketGapFlag {
  if (info == null) return null;
  if (info.gap >= VALUE_GAP_THRESHOLD) return "value";
  if (price >= DANGER_MIN_PRICE && info.gap <= DANGER_GAP_THRESHOLD) return "danger";
  return null;
}
