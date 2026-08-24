/**
 * foulModel.ts
 * ---------------------------------------------------------------------------
 * An opinion of our own about how many fouls a player commits and suffers,
 * built from their actual record rather than from the bookmaker's prices.
 *
 * Until this existed, /fouls could only audit the board against itself - find
 * rungs inconsistent with their own ladder, or one board inconsistent with the
 * other. Useful, but it could never say "the market is wrong about this
 * player", only "the market disagrees with itself". This closes that gap.
 *
 * WHY IT IS WORTH MODELLING AT ALL. Measured on 1,097 players with at least ten
 * full matches in each of the 2024/25 and 2025/26 seasons, a player's fouls per
 * 90 correlates 0.789 year over year, and fouls drawn per 90 the same. Using
 * last season's rate beats predicting the league mean by 56% of squared error.
 * Foul propensity is a real and persistent trait, not noise - which is exactly
 * what makes a per-player model worth having and is why every constant below
 * was measured rather than chosen.
 *
 * Every parameter here comes from 6,614 player-seasons across the Premier
 * League, Championship, League One and League Two (migration 0142,
 * scripts/import_foul_stats.py).
 */

/* ========================================================================== *
 * Measured constants
 * ========================================================================== */

/** SportMonks position type ids. */
export type PositionId = 24 | 25 | 26 | 27;

/**
 * Fouls committed and drawn per 90, by position, over 90,804 full-match
 * equivalents. The ordering is the football one: forwards commit the most
 * fouls per 90 (pressing and holding the ball up), keepers essentially none.
 */
export const POSITION_BASELINES: Record<number, { committed: number; drawn: number }> = {
  24: { committed: 0.02, drawn: 0.231 }, // GK
  25: { committed: 0.912, drawn: 0.855 }, // DEF
  26: { committed: 1.203, drawn: 1.191 }, // MID
  27: { committed: 1.443, drawn: 1.288 }, // FWD
};

/** Fallback when a squad row carried no position. */
const OVERALL_BASELINE = { committed: 1.046, drawn: 1.009 };

/**
 * Shrinkage strength, in full-match equivalents, estimated per position by
 * method of moments on players with at least eight 90s: the spread of observed
 * rates minus the part Poisson noise alone explains gives the true spread
 * between players, and k is the ratio of the mean to that spread.
 *
 * The result is itself informative. Defenders need the most shrinkage (k=10.7)
 * because they genuinely resemble each other; forwards the least (k=4.1)
 * because their foul rates really do differ a lot player to player. So a
 * striker's own record is trusted after four full matches, where a centre-back
 * needs closer to eleven.
 */
export const POSITION_SHRINKAGE: Record<number, number> = {
  24: 12, // GK - barely any signal to find, shrink hard
  25: 10.7,
  26: 7.5,
  27: 4.1,
};
const DEFAULT_SHRINKAGE = 8;

/**
 * Weight applied to a season's data per season of age. Foul rate correlates
 * 0.789 across consecutive seasons, so older evidence is still worth a lot -
 * this decay is deliberately gentle rather than the aggressive recency
 * weighting a more volatile stat would need.
 */
const SEASON_DECAY = 0.7;

/**
 * League-average per-player rates, used to normalise the opponent adjustment.
 * Divisions turned out remarkably alike (1.011 fouls/90 in the Premier League
 * against 1.073 in League Two), so no league correction is applied to the
 * player rate itself - the difference is smaller than the noise on any single
 * player's sample.
 */
const LEAGUE_MEAN_COMMITTED = 1.046;
const LEAGUE_MEAN_DRAWN = 1.009;

/**
 * Minutes a confirmed starter is assumed to play. Not 90: starters are
 * substituted, and the ladders price the whole match. Pulled toward a player's
 * own historical minutes-per-start where they have one.
 */
const DEFAULT_STARTER_MINUTES = 85;

/* ========================================================================== *
 * Inputs
 * ========================================================================== */

export type SeasonFoulRow = {
  seasonId: number;
  seasonName: string | null;
  leagueId: number;
  minutes: number;
  appearances: number;
  lineups: number;
  fouls: number;
  foulsDrawn: number;
};

export type PlayerFoulHistory = {
  playerId: number;
  playerName: string;
  positionId: number | null;
  seasons: SeasonFoulRow[];
};

/** Aggregate foul behaviour of a whole team, for the opponent adjustment. */
export type TeamFoulProfile = {
  teamId: number;
  /** Per-player fouls per 90 across the squad. */
  committedPer90: number;
  /** Per-player fouls drawn per 90 across the squad. */
  drawnPer90: number;
  ninetys: number;
};

export type PlayerFoulRate = {
  playerId: number;
  playerName: string;
  positionId: number | null;
  /** Shrunk fouls committed per 90. */
  committedPer90: number;
  /** Shrunk fouls drawn per 90. */
  drawnPer90: number;
  /** Recency-weighted full-match equivalents behind the estimate. */
  effectiveNinetys: number;
  /** Raw, unshrunk rate - shown so a big shrinkage correction is visible. */
  rawCommittedPer90: number | null;
  rawDrawnPer90: number | null;
  /** Minutes this player is expected to play, from their own start history. */
  expectedMinutes: number;
  /** How much of the estimate is the player's own record rather than the baseline, 0-1. */
  confidence: number;
};

/* ========================================================================== *
 * Rates
 * ========================================================================== */

function baselineFor(positionId: number | null) {
  return (positionId != null && POSITION_BASELINES[positionId]) || OVERALL_BASELINE;
}

function shrinkageFor(positionId: number | null) {
  return (positionId != null && POSITION_SHRINKAGE[positionId]) || DEFAULT_SHRINKAGE;
}

/**
 * Collapse a player's seasons into one shrunk rate.
 *
 * Standard empirical-Bayes: add the positional baseline as k pseudo-matches of
 * prior evidence, so a player with two appearances is quoted near their
 * position's average and one with three full seasons is quoted near their own
 * record, with everything in between weighted by how much they have actually
 * played.
 *
 * `seasonIndexFromNewest` is 0 for the current season, 1 for last, and so on.
 */
export function computePlayerRate(
  history: PlayerFoulHistory,
  currentSeasonIds: Set<number>,
): PlayerFoulRate {
  const baseline = baselineFor(history.positionId);
  const k = shrinkageFor(history.positionId);

  // Newest first, so decay can be applied by rank without needing real dates.
  const ordered = [...history.seasons].sort((a, b) => {
    const aCurrent = currentSeasonIds.has(a.seasonId) ? 1 : 0;
    const bCurrent = currentSeasonIds.has(b.seasonId) ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    return (b.seasonName ?? "").localeCompare(a.seasonName ?? "");
  });

  let wN90 = 0;
  let wFouls = 0;
  let wDrawn = 0;
  let rawN90 = 0;
  let rawFouls = 0;
  let rawDrawn = 0;
  let startWeightedMinutes = 0;
  let starts = 0;

  ordered.forEach((s, i) => {
    const w = Math.pow(SEASON_DECAY, i);
    const n90 = s.minutes / 90;
    wN90 += w * n90;
    wFouls += w * s.fouls;
    wDrawn += w * s.foulsDrawn;
    rawN90 += n90;
    rawFouls += s.fouls;
    rawDrawn += s.foulsDrawn;
    if (s.lineups > 0) {
      starts += s.lineups;
      startWeightedMinutes += s.minutes;
    }
  });

  const committedPer90 = (wFouls + k * baseline.committed) / (wN90 + k);
  const drawnPer90 = (wDrawn + k * baseline.drawn) / (wN90 + k);

  // Minutes per start, bounded: a player whose history is all substitute
  // cameos would otherwise be projected for twenty minutes in a match the
  // lineup says they are starting.
  let expectedMinutes = DEFAULT_STARTER_MINUTES;
  if (starts >= 3 && startWeightedMinutes > 0) {
    const perStart = startWeightedMinutes / starts;
    expectedMinutes = Math.max(60, Math.min(90, perStart));
  }

  return {
    playerId: history.playerId,
    playerName: history.playerName,
    positionId: history.positionId,
    committedPer90,
    drawnPer90,
    effectiveNinetys: wN90,
    rawCommittedPer90: rawN90 > 0 ? rawFouls / rawN90 : null,
    rawDrawnPer90: rawN90 > 0 ? rawDrawn / rawN90 : null,
    expectedMinutes,
    confidence: wN90 / (wN90 + k),
  };
}

/* ========================================================================== *
 * Fixture projection
 * ========================================================================== */

export type ModelledPlayer = {
  playerName: string;
  team: string;
  /** Expected fouls committed in this fixture. */
  committed: number;
  /** Expected fouls suffered in this fixture. */
  suffered: number;
  confidence: number;
  effectiveNinetys: number;
  expectedMinutes: number;
};

/**
 * Turn a rate into an expectation for one fixture: the player's own rate, over
 * the minutes they are expected to play, against this particular opponent.
 *
 * The opponent adjustment runs crosswise, which is the part worth stating.
 * How many fouls a player COMMITS depends on how many the opposition DRAWS -
 * a side full of dribblers who get kicked will lift the other team's foul
 * counts. Likewise fouls SUFFERED scale with how much the opposition fouls.
 * Getting these the same way round would apply the correction backwards.
 *
 * Team effects are modest and are damped accordingly: team-season rates have a
 * standard deviation of about 0.10 on a mean of 1.04, so a full-strength
 * adjustment would be roughly plus or minus 10% at one standard deviation.
 */
export function projectFixture(
  rate: PlayerFoulRate,
  team: string,
  opponent: TeamFoulProfile | null,
  opts: { minutesOverride?: number; opponentWeight?: number } = {},
): ModelledPlayer {
  const w = opts.opponentWeight ?? 1;
  const minutes = opts.minutesOverride ?? rate.expectedMinutes;
  const share = minutes / 90;

  let committedFactor = 1;
  let sufferedFactor = 1;
  if (opponent && opponent.ninetys > 20) {
    // Crosswise, deliberately - see the note above.
    committedFactor = 1 + w * (opponent.drawnPer90 / LEAGUE_MEAN_DRAWN - 1);
    sufferedFactor = 1 + w * (opponent.committedPer90 / LEAGUE_MEAN_COMMITTED - 1);
  }

  return {
    playerName: rate.playerName,
    team,
    committed: rate.committedPer90 * share * committedFactor,
    suffered: rate.drawnPer90 * share * sufferedFactor,
    confidence: rate.confidence,
    effectiveNinetys: rate.effectiveNinetys,
    expectedMinutes: minutes,
  };
}

/**
 * Share of fouls that have an identifiable victim, MEASURED rather than
 * assumed: 91,645 fouls drawn against 95,023 fouls committed across the whole
 * sample.
 *
 * This supersedes the 0.90 the tool previously assumed, and the correction
 * matters more than it looks. The conservation test compares one board's
 * committed total against the other's fouled total after scaling by this
 * number, so an attribution rate set 6 points too low inflated the apparent
 * gap between the two boards - part of the "cross-board edge" the tool was
 * reporting was this constant, not the bookmaker.
 */
export const MEASURED_ATTRIBUTION_RATE = 0.964;
