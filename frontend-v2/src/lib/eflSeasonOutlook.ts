import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

export type TeamOutlook = "promotion" | "relegation";

export type TeamOutlookInfo = {
  outlook: TeamOutlook;
  rank: number;
  impliedProbability: number;
};

/**
 * Batch fetch from team_season_outlook (migration 0113) - the bookmakers'
 * promotion/relegation favourite markets, EFL Fantasy's only real proxy
 * for club strength before a ball is kicked (see the migration's
 * docstring). Keyed by team_id, not game_player_id - this is a club-level
 * signal that applies equally to every player at that club AND to the
 * club itself as a CLUB pick.
 *
 * `seasonStarted` (same convention as rotationRisk.ts's
 * fetchRotationRiskByPlayerIds) short-circuits to an empty map once the
 * real season kicks off: this is a pre-season stand-in built from a
 * one-off bookmaker snapshot, not a live feed. Once real fixtures start,
 * actual results/form are the authoritative signal for club strength -
 * this one should get out of the way rather than go stale.
 */
export async function fetchTeamOutlookByTeamIds(supabase: Supabase, teamIds: number[], seasonStarted: boolean): Promise<Map<number, TeamOutlookInfo>> {
  const map = new Map<number, TeamOutlookInfo>();
  if (seasonStarted) return map;
  const ids = [...new Set(teamIds)];
  if (ids.length === 0) return map;
  const { data } = await supabase.from("team_season_outlook").select("team_id, outlook, rank, implied_probability").in("team_id", ids);
  for (const row of data ?? []) {
    // A team can only appear once per (competition, season) for a given
    // outlook by the table's own unique constraint, and a club can't
    // realistically be both a promotion AND relegation favourite in the
    // same market - first row wins is just a defensive fallback, not a
    // real ambiguity.
    if (!map.has(row.team_id as number)) {
      map.set(row.team_id as number, {
        outlook: row.outlook as TeamOutlook,
        rank: row.rank as number,
        impliedProbability: Number(row.implied_probability),
      });
    }
  }
  return map;
}

/**
 * team_ids Ask Mary should never buy INTO (players) or recommend AS a
 * CLUB pick - a club the bookmakers rate as a genuine relegation
 * favourite is exactly the club whose players are least likely to
 * deliver clean sheets/wins/minutes-in-a-winning-team, and whose CLUB
 * pick is a bad bet on the actual CLUB scoring rules (win/draw/away-win/
 * clean sheet/goals - see migration 0090's docstring). Promotion
 * favourites are deliberately NOT force-boosted here - same conservative,
 * exclusion-only discipline as rotationRisk.ts's buildHighRiskGamePlayerIds
 * (never fabricate a preference the real projection data doesn't back).
 */
export function buildRelegationRiskTeamIds(outlookByTeamId: Map<number, TeamOutlookInfo>): Set<number> {
  const ids = new Set<number>();
  for (const [teamId, info] of outlookByTeamId) {
    if (info.outlook === "relegation") ids.add(teamId);
  }
  return ids;
}
