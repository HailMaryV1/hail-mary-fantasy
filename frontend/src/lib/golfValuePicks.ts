/**
 * Golf "value pick" detector - flags golfers whose pasted top20-finish
 * market odds imply a meaningfully higher chance than their FanTeam
 * price alone would predict. Confirmed against the real Rocket Classic
 * field (82 golfers with both a price and top20 odds): price and
 * market-implied top20 probability correlate at 0.94 - FanTeam clearly
 * prices around market perception, so a golfer sitting well ABOVE the
 * price->probability line the rest of the field draws is a real signal
 * worth surfacing, not noise.
 *
 * Recomputed fresh on every page load directly from golf_tournament_entries
 * (price) + golf_tournament_odds (market='top20', already pasted at
 * /golf/odds) - deliberately NOT baked into compute_golf_projections.py's
 * Python pipeline, so a value badge reflects odds the moment they're
 * pasted rather than waiting for the next projections recompute.
 *
 * Only the 'top20' market is used (not 'win'/'top5'/'top10') to match
 * what's actually been pasted so far - if that changes, this can take a
 * market parameter, but there's no need to over-generalize before a
 * second market is actually in use for this purpose.
 */

export type ValuePriceRow = { gamePlayerId: number; golferId: number; price: number };
export type ValueOddsRow = { golferId: number; impliedProbability: number | null };

// Matches the threshold the value hunt itself was framed around - a
// golfer needs to sit at least 3 percentage points above what their
// price alone predicts to get flagged, so a badge means something.
export const VALUE_GAP_THRESHOLD = 0.03;

// A regression over fewer than this many paired (price, odds) points is
// noise, not signal - most tournaments won't have odds pasted for every
// golfer in the field, and a handful of points can produce an
// arbitrarily steep/meaningless line.
const MIN_SAMPLE_SIZE = 8;

/** gamePlayerId -> how far above the price-predicted probability this golfer's market odds sit (e.g. 0.062 = +6.2pts). */
export function computeTop20ValueGaps(priceRows: ValuePriceRow[], oddsRows: ValueOddsRow[]): Map<number, number> {
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

  const gaps = new Map<number, number>();
  for (const p of paired) {
    const predicted = intercept + slope * p.price;
    const gap = p.prob - predicted;
    if (gap >= VALUE_GAP_THRESHOLD) gaps.set(p.gamePlayerId, gap);
  }
  return gaps;
}
