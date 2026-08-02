// Which of the app's game-scoped tools actually work for each game today -
// deliberately explicit rather than assuming every game has every
// feature. Dream Team has no live scrape source (a longstanding,
// documented gap elsewhere in this app) so Ask Mary/Performance Lab/
// Watchlist/Activity would just be empty or misleading there. NFL FanTeam
// has real 2025 historical stats and squad-building now (Stage 1-3), but
// no live tournament/fixture schedule yet (the next one opens close to
// the 2026-27 season, ~Sept 2026) - so fixtures/watchlist/activity/Ask
// Mary/Performance Lab, which all assume an in-season data source, stay
// off until that exists.
export type GameFeatureSet = {
  rankings: boolean;
  fixtures: boolean;
  watchlist: boolean;
  activity: boolean;
  askMary: boolean;
  performanceLab: boolean;
  // Hail Mary Form (migration 0044) needs a captured, deadline-locked
  // prediction history to mean anything - only FanTeam has that pipeline
  // wired up (scripts/capture_gameweek_predictions.py only scans games
  // with a published gameweek calendar it's actually being run against).
  hailMaryForm: boolean;
  // Engine Validation (/algorithm-explain) reads the modular projection
  // breakdown compute_projections.py now writes into projections.inputs
  // for every game with a real game_scoring_rules matrix (v2-decomposed) -
  // both FanTeam and Dream Team, unlike every other feature above which
  // needs a live in-season data source Dream Team doesn't have yet.
  engineExplain: boolean;
};

export const GAME_FEATURES: Record<string, GameFeatureSet> = {
  fanteam: { rankings: true, fixtures: true, watchlist: true, activity: true, askMary: true, performanceLab: true, hailMaryForm: true, engineExplain: true },
  dreamteam: { rankings: true, fixtures: true, watchlist: false, activity: false, askMary: false, performanceLab: false, hailMaryForm: false, engineExplain: true },
  "nfl-fanteam": { rankings: true, fixtures: false, watchlist: false, activity: false, askMary: false, performanceLab: false, hailMaryForm: false, engineExplain: false },
  // Cloud FF frontend wiring is intentionally minimal for now (see
  // supabase/migrations/0079_cloudff_squad_rules.sql commit) - only
  // Player Rankings is being turned on. Fixtures/Watchlist/Activity/Ask
  // Mary/Performance Lab/Engine Validation are all real, working features
  // elsewhere, but none have been built or verified against Cloud FF's
  // real rules yet, so they stay off rather than show something untested.
  cloudff: { rankings: true, fixtures: false, watchlist: false, activity: false, askMary: false, performanceLab: false, hailMaryForm: false, engineExplain: false },
};

export const NO_FEATURES: GameFeatureSet = {
  rankings: false,
  fixtures: false,
  watchlist: false,
  activity: false,
  askMary: false,
  performanceLab: false,
  hailMaryForm: false,
  engineExplain: false,
};

export function featuresForGame(slug: string): GameFeatureSet {
  return GAME_FEATURES[slug] ?? NO_FEATURES;
}
