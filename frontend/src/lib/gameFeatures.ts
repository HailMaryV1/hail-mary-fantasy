// Which of the app's game-scoped tools actually work for each game today -
// deliberately explicit rather than assuming every game has every
// feature. Dream Team has no live scrape source (a longstanding,
// documented gap elsewhere in this app) so Ask Mary/Performance Lab/
// Activity would just be empty or misleading there. NFL FanTeam
// has real 2025 historical stats and squad-building now (Stage 1-3), but
// no live tournament/fixture schedule yet (the next one opens close to
// the 2026-27 season, ~Sept 2026) - so fixtures/activity/Ask
// Mary/Performance Lab, which all assume an in-season data source, stay
// off until that exists.
export type GameFeatureSet = {
  rankings: boolean;
  fixtures: boolean;
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
  fanteam: { rankings: true, fixtures: true, activity: true, askMary: true, performanceLab: true, hailMaryForm: true, engineExplain: true },
  dreamteam: { rankings: true, fixtures: true, activity: false, askMary: false, performanceLab: false, hailMaryForm: false, engineExplain: true },
  "nfl-fanteam": { rankings: true, fixtures: false, activity: false, askMary: false, performanceLab: false, hailMaryForm: false, engineExplain: false },
  // Ask Mary + Performance Lab verified against Cloud FF's real rules
  // (11-player squad no bench, £100m budget, always-free transfer
  // search - see askMaryEngine.ts's isCloudFF bypass). Fixtures/
  // Activity/Hail Mary Form/Engine Validation stay off - none were
  // built or verified against Cloud FF yet (Hail Mary Form specifically
  // has no capture pipeline running against its calendar).
  cloudff: { rankings: true, fixtures: false, activity: false, askMary: true, performanceLab: true, hailMaryForm: false, engineExplain: false },
};

export const NO_FEATURES: GameFeatureSet = {
  rankings: false,
  fixtures: false,
  activity: false,
  askMary: false,
  performanceLab: false,
  hailMaryForm: false,
  engineExplain: false,
};

export function featuresForGame(slug: string): GameFeatureSet {
  return GAME_FEATURES[slug] ?? NO_FEATURES;
}
