// Hail Mary Form System - ranks players by how much they beat or miss
// THIS APP'S OWN MODEL (player_gameweek_predictions.points_difference,
// migration 0044), not generic fantasy form. A player can be "hot" here
// while their raw points are unremarkable, if Mary keeps underestimating
// them - and "cold" while still scoring plenty, if Mary keeps
// overestimating them by even more. Pure functions only, no Supabase
// calls. Every page that needs a badge calls buildFormByGamePlayerId()
// once over its own fetched rows.

export type FormStatus = "very_hot" | "hot" | "neutral" | "cold" | "very_cold";

export type FormDiffRow = {
  game_player_id: number;
  gameweek: number;
  points_difference: number | null; // null = actuals not attached yet (gameweek incomplete)
};

export type FormResult = {
  status: FormStatus | null; // null = fewer than MIN_GAMES_FOR_BADGE completed gameweeks
  recentScore: number | null; // weighted score over the last up-to-4 completed GWs - drives status/badge everywhere
  seasonScore: number | null; // plain average over every completed GW this season
  gamesUsed: number; // total completed (non-null points_difference) gameweeks this player has
};

// Exactly the 5 tiers and thresholds from the spec.
const VERY_HOT_THRESHOLD = 4.0;
const HOT_THRESHOLD = 1.5;
const COLD_THRESHOLD = -1.5;
const VERY_COLD_THRESHOLD = -4.0;

// No badge at all below 2 completed gameweeks - one good/bad game is
// noise, not form. Very Hot/Very Cold additionally require 3 - a stronger
// claim needs a bigger sample even if the 2-game weighted average already
// crosses +-4.0 (capped down to Hot/Cold instead).
const MIN_GAMES_FOR_BADGE = 2;
const MIN_GAMES_FOR_EXTREME = 3;

// Most-recent-first: this GW 40%, previous 30%, two back 20%, three back
// 10%. Renormalized (not zero-padded) when fewer than 4 are available, so
// a player with only 2 completed gameweeks still gets a real weighted
// score from exactly those 2 - not diluted by phantom zero-weeks.
const RECENCY_WEIGHTS = [0.4, 0.3, 0.2, 0.1];

function statusFromScore(score: number, gamesUsed: number): FormStatus {
  if (score >= VERY_HOT_THRESHOLD) return gamesUsed >= MIN_GAMES_FOR_EXTREME ? "very_hot" : "hot";
  if (score >= HOT_THRESHOLD) return "hot";
  if (score <= VERY_COLD_THRESHOLD) return gamesUsed >= MIN_GAMES_FOR_EXTREME ? "very_cold" : "cold";
  if (score <= COLD_THRESHOLD) return "cold";
  return "neutral";
}

// diffsMostRecentFirst: completed points_difference values, most recent
// gameweek first, already capped to at most 4 by the caller (only the
// last 4 ever factor into recency form, by design).
export function computeRecentForm(diffsMostRecentFirst: number[]): { status: FormStatus | null; score: number | null } {
  const n = diffsMostRecentFirst.length;
  if (n < MIN_GAMES_FOR_BADGE) return { status: null, score: null };

  const weights = RECENCY_WEIGHTS.slice(0, n);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const score = diffsMostRecentFirst.reduce((sum, diff, i) => sum + diff * weights[i], 0) / weightSum;

  return { status: statusFromScore(score, n), score: round2(score) };
}

// diffsAnyOrder: every completed points_difference this season, order
// doesn't matter - plain unweighted average, same gating as recent form.
export function computeSeasonForm(diffsAnyOrder: number[]): { status: FormStatus | null; score: number | null } {
  const n = diffsAnyOrder.length;
  if (n < MIN_GAMES_FOR_BADGE) return { status: null, score: null };

  const score = diffsAnyOrder.reduce((a, b) => a + b, 0) / n;
  return { status: statusFromScore(score, n), score: round2(score) };
}

// The Form table's own filter (Latest GW / L3 / L5 / Season) - a separate,
// simpler plain average over whichever window is selected, purely for the
// displayed/sortable number in that view. Does NOT drive the badge - the
// icon shown next to it always comes from computeRecentForm's fixed 4-GW
// recency window, so the icon means the same thing everywhere in the app
// regardless of which window a table happens to be filtered to.
export function computeWindowedAverage(diffsMostRecentFirst: number[], window: number | "season"): { average: number | null; gamesUsed: number } {
  const slice = window === "season" ? diffsMostRecentFirst : diffsMostRecentFirst.slice(0, window);
  if (slice.length === 0) return { average: null, gamesUsed: 0 };
  return { average: round2(slice.reduce((a, b) => a + b, 0) / slice.length), gamesUsed: slice.length };
}

// Groups raw per-GW diff rows fetched for a page's player set into one
// FormResult per player - shared by every integration surface instead of
// N copies of the same groupBy.
export function buildFormByGamePlayerId(rows: FormDiffRow[]): Map<number, FormResult> {
  const byPlayer = new Map<number, FormDiffRow[]>();
  for (const row of rows) {
    if (row.points_difference === null) continue; // incomplete gameweek - not form data yet
    const list = byPlayer.get(row.game_player_id);
    if (list) list.push(row);
    else byPlayer.set(row.game_player_id, [row]);
  }

  const result = new Map<number, FormResult>();
  for (const [gamePlayerId, completedRows] of byPlayer) {
    completedRows.sort((a, b) => b.gameweek - a.gameweek); // most recent first
    const diffs = completedRows.map((r) => r.points_difference as number);

    const recent = computeRecentForm(diffs.slice(0, 4));
    const season = computeSeasonForm(diffs);

    result.set(gamePlayerId, {
      status: recent.status,
      recentScore: recent.score,
      seasonScore: season.score,
      gamesUsed: diffs.length,
    });
  }
  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
