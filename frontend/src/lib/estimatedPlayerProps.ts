// Resolves a player-level bookmaker prop (e.g. anytime goalscorer) to
// either a REAL observed probability (fixture_player_props, once
// SportMonks has actually posted odds for this exact fixture - see
// scripts/import_sportmonks_player_props.py) or, until that happens, an
// ESTIMATE derived from the player's own most recent real observation
// (player_prop_baselines) scaled by how this fixture's team strength
// compares to the fixture that baseline was observed under.
//
// Confirmed empirically (2026-07-29): bookmaker odds - even basic
// match-winner odds, let alone player props - simply don't exist for a
// Premier League fixture more than ~1-2 weeks out. That ruled out the
// original idea of scaling against a FUTURE fixture's own real match
// odds (they won't exist either) - so this scales against
// team_fixture_difficulty.attack_score instead, which is ALREADY
// populated for every fixture on the calendar regardless of real-odds
// availability (real market odds when they exist, a season-strength
// model fallback otherwise - see migration 0017). That view is exactly
// the "Hail Mary projected team strength" the fallback needs, so no new
// team-strength modelling was required here at all.
//
// Bounded rather than left as a raw linear scale - a small sample size
// and simple ratio could otherwise imply near-certainty or near-zero
// from a single data point, which would read as false confidence.
const MIN_PROBABILITY = 0.01;
const MAX_PROBABILITY = 0.9;

export type RealPropObservation = {
  probability: number;
  fixtureId: number;
  observedAt: string;
};

export type PropBaseline = {
  observedProbability: number;
  teamAttackScore: number;
  fixtureId: number;
  observedAt: string;
};

export type PlayerPropEstimate = {
  probability: number;
  isEstimated: boolean; // false only when this came straight from a real observation for this exact fixture
  sourceFixtureId: number; // the fixture the number actually came from (this one if real, the baseline's if estimated)
  observedAt: string;
};

/**
 * Real data wins outright. Otherwise scales the baseline's real
 * probability by (this fixture's attack_score / the baseline fixture's
 * attack_score) - "Arsenal were 2/5 to beat Coventry when we saw Saka's
 * real anytime-scorer price; they're priced differently against Aston
 * Villa, so scale Saka's number by that same ratio" - using our own
 * always-available attack rating in place of a future match's own odds,
 * which won't exist yet either. Returns null when there's no real
 * anchor for this player at all yet - never invents a first number from
 * nothing.
 */
export function resolvePlayerPropProbability(
  real: RealPropObservation | undefined,
  baseline: PropBaseline | undefined,
  targetAttackScore: number | null
): PlayerPropEstimate | null {
  if (real) {
    return { probability: real.probability, isEstimated: false, sourceFixtureId: real.fixtureId, observedAt: real.observedAt };
  }
  if (!baseline || targetAttackScore == null || baseline.teamAttackScore <= 0) return null;

  const scaled = baseline.observedProbability * (targetAttackScore / baseline.teamAttackScore);
  const bounded = Math.max(MIN_PROBABILITY, Math.min(MAX_PROBABILITY, scaled));
  return { probability: bounded, isEstimated: true, sourceFixtureId: baseline.fixtureId, observedAt: baseline.observedAt };
}
