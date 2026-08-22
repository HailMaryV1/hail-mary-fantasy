import type { createAuthServerClient } from "./supabaseServerClient";
import type { GameweekInfo } from "./gameweek";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

/**
 * EFL Fantasy-only stand-in for gameweek.ts's getGameweekInfo/getSeasonTiming -
 * deliberately a separate file, never edited into gameweek.ts, so FanTeam/
 * Dream Team/Cloud FF's existing whole-gameweek-locks-at-first-kickoff
 * behaviour is untouched (real user instruction 2026-08-20: "ITS ONLY EFL -
 * do not touch the other games logics").
 *
 * Real EFL Fantasy rule (user-confirmed, not guessed): "a player is locked
 * once they kick off ... it locks game by game" - unlike FPL-style games
 * where the whole gameweek's deadline is its first kickoff. Concretely this
 * means a gameweek is only "over" once its LAST fixture has kicked off, not
 * its first - real bug this fixes: a single rearranged Thursday-night
 * fixture inside an otherwise Saturday-heavy gameweek used to flip the
 * whole board read-only the moment it kicked off, even though the other 35
 * fixtures (and every player in them) hadn't played yet.
 *
 * planningGameweek here means "the earliest gameweek that still has at
 * least one fixture left to kick off" - individual players within it are
 * locked/unlocked separately via getTeamKickoffMap/isTeamLocked below.
 */
export async function getEflGameweekInfo(supabase: Supabase, gameId: number): Promise<GameweekInfo> {
  const { data } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures(kickoff_at)")
    .eq("game_id", gameId)
    .returns<{ gameweek: number; fixtures: { kickoff_at: string } }[]>();

  const earliestByGw = new Map<number, number>();
  const latestByGw = new Map<number, number>();
  for (const row of data ?? []) {
    const t = new Date(row.fixtures.kickoff_at).getTime();
    const e = earliestByGw.get(row.gameweek);
    if (e === undefined || t < e) earliestByGw.set(row.gameweek, t);
    const l = latestByGw.get(row.gameweek);
    if (l === undefined || t > l) latestByGw.set(row.gameweek, t);
  }
  if (earliestByGw.size === 0) {
    return { seasonStarted: false, planningGameweek: null, displayGameweek: 1, minGameweek: 1, maxGameweek: 1, gameweeks: [] };
  }

  const now = Date.now();
  const gameweek1Kickoff = earliestByGw.get(1);
  const seasonStarted = gameweek1Kickoff !== undefined && now >= gameweek1Kickoff;

  const sorted = Array.from(earliestByGw.entries())
    .map(([gameweek, kickoff]) => ({ gameweek, kickoff }))
    .sort((a, b) => a.gameweek - b.gameweek);
  // "Still has a fixture to come" keys off the LAST kickoff in that
  // gameweek, not the first - the one real difference from gameweek.ts's
  // shared planningGameweek logic.
  const stillOpen = sorted.filter((g) => (latestByGw.get(g.gameweek) ?? g.kickoff) >= now);
  const planningGameweek = stillOpen.length > 0 ? stillOpen[0].gameweek : null;

  return {
    seasonStarted,
    planningGameweek,
    // EFL Fantasy's own planningGameweek already means "still has at
    // least one fixture left to kick off" (last-kickoff based, per this
    // file's own docstring) - unlike gameweek.ts's shared logic, that's
    // already the right "not yet over" signal for the board's default
    // view, so no separate displayGameweek computation is needed here.
    displayGameweek: planningGameweek ?? sorted[sorted.length - 1].gameweek,
    minGameweek: sorted[0].gameweek,
    maxGameweek: sorted[sorted.length - 1].gameweek,
    gameweeks: sorted.map(({ gameweek, kickoff }) => ({ gameweek, deadline: new Date(kickoff).toISOString() })),
  };
}

/**
 * Every team's own kickoff time within one gameweek - the basis for
 * per-player locking. Keyed by team_id (not fixture_id) since both
 * squad/pool rows and game_players only ever carry team_id.
 */
export async function getTeamKickoffMap(supabase: Supabase, gameId: number, gameweek: number): Promise<Map<number, number>> {
  const { data } = await supabase
    .from("game_fixture_gameweeks")
    .select("fixtures(home_team_id, away_team_id, kickoff_at)")
    .eq("game_id", gameId)
    .eq("gameweek", gameweek)
    .returns<{ fixtures: { home_team_id: number; away_team_id: number; kickoff_at: string } | null }[]>();

  const map = new Map<number, number>();
  for (const row of data ?? []) {
    const f = row.fixtures;
    if (!f) continue;
    const t = new Date(f.kickoff_at).getTime();
    map.set(f.home_team_id, t);
    map.set(f.away_team_id, t);
  }
  return map;
}

/** A team with no fixture in this gameweek (bye/postponed) is never
 * locked - there's nothing to have kicked off. */
export function isTeamLocked(kickoffMap: Map<number, number>, teamId: number, now = Date.now()): boolean {
  const kickoff = kickoffMap.get(teamId);
  return kickoff !== undefined && kickoff <= now;
}
