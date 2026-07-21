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
};

export const GAME_FEATURES: Record<string, GameFeatureSet> = {
  fanteam: { rankings: true, fixtures: true, watchlist: true, activity: true, askMary: true, performanceLab: true, hailMaryForm: true },
  dreamteam: { rankings: true, fixtures: true, watchlist: false, activity: false, askMary: false, performanceLab: false, hailMaryForm: false },
  "nfl-fanteam": { rankings: true, fixtures: false, watchlist: false, activity: false, askMary: false, performanceLab: false, hailMaryForm: false },
};

export const NO_FEATURES: GameFeatureSet = {
  rankings: false,
  fixtures: false,
  watchlist: false,
  activity: false,
  askMary: false,
  performanceLab: false,
  hailMaryForm: false,
};

export function featuresForGame(slug: string): GameFeatureSet {
  return GAME_FEATURES[slug] ?? NO_FEATURES;
}
