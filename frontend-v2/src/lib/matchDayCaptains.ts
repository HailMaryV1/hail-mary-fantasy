import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

export type MatchDayPlayer = {
  gamePlayerId: number;
  fullName: string;
  teamName: string;
  position: string;
};

export type MatchDay = {
  matchDate: string; // YYYY-MM-DD
  gameweek: number;
  eligiblePlayers: MatchDayPlayer[];
};

/**
 * Cloud FF's real captain rule, unlike every other game here: one captain
 * per calendar match-day, chosen only from squad players whose team has a
 * real fixture kicking off that day (confirmed live against the real
 * site's own "Captains" page - see migration 0083's docstring). This is
 * the shared query both setMatchDayCaptain (cloudff/actions.ts, validating
 * a single day+player choice) and the Captains page
 * (cloudff/captains/page.tsx, rendering every day in the window) read
 * from, so they can never disagree about which players are legally
 * eligible on which day.
 *
 * Returns EVERY real match-day in the window - not just the ones where
 * the squad happens to have a player - deliberately: a day with zero
 * eligible players is exactly the "you have no captain coverage today"
 * gap the user wants surfaced (Captains page renders those with a "no
 * players available" message instead of quietly omitting the day), not
 * something to hide by filtering it out here.
 *
 * fixtures.kickoff_at is a real per-fixture timestamptz - "which calendar
 * day" is derived from it directly (UTC date), not a separate stored
 * column.
 */
export async function getMatchDaysForSquad(
  supabase: Supabase,
  gameId: number,
  squadId: number,
  gameweekFrom: number,
  gameweekTo: number
): Promise<MatchDay[]> {
  // Squad roster and the leaguewide fixture list are independent reads -
  // neither depends on the other's result - so they run as one Promise.all
  // instead of two back-to-back round trips (same fix already applied to
  // the board pages' own data loading).
  const [{ data: rows }, { data: fixtureRows }] = await Promise.all([
    supabase
      .from("squad_players")
      .select("game_player_id, game_players(players(full_name, position, team_id, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squadId)
      .returns<
        { game_player_id: number; game_players: { players: { full_name: string; position: string; team_id: number; teams: { name: string } } } }[]
      >(),
    supabase
      .from("game_fixture_gameweeks")
      .select("gameweek, fixtures(kickoff_at, home_team_id, away_team_id)")
      .eq("game_id", gameId)
      .gte("gameweek", gameweekFrom)
      .lte("gameweek", gameweekTo)
      .returns<{ gameweek: number; fixtures: { kickoff_at: string; home_team_id: number; away_team_id: number } }[]>(),
  ]);
  const squadPlayers = (rows ?? []).map((r) => ({
    gamePlayerId: r.game_player_id,
    fullName: r.game_players.players.full_name,
    teamId: r.game_players.players.team_id,
    teamName: r.game_players.players.teams.name,
    position: r.game_players.players.position,
  }));

  // Every real match-date in the window (leaguewide, not squad-filtered),
  // plus which teams play that date - a team could in principle have two
  // fixtures in the same gameweek (a real double-gameweek), each its own
  // distinct match-day, which this naturally keeps separate since it's
  // keyed by date, not gameweek.
  const gameweekByDate = new Map<string, number>();
  const teamsByDate = new Map<string, Set<number>>();
  for (const row of fixtureRows ?? []) {
    const matchDate = row.fixtures.kickoff_at.slice(0, 10);
    gameweekByDate.set(matchDate, row.gameweek);
    const teams = teamsByDate.get(matchDate) ?? new Set<number>();
    teams.add(row.fixtures.home_team_id);
    teams.add(row.fixtures.away_team_id);
    teamsByDate.set(matchDate, teams);
  }

  const squadPlayersByTeamId = new Map<number, MatchDayPlayer[]>();
  for (const p of squadPlayers) {
    const list = squadPlayersByTeamId.get(p.teamId) ?? [];
    list.push({ gamePlayerId: p.gamePlayerId, fullName: p.fullName, teamName: p.teamName, position: p.position });
    squadPlayersByTeamId.set(p.teamId, list);
  }

  return Array.from(gameweekByDate.entries())
    .map(([matchDate, gameweek]) => {
      const eligiblePlayers: MatchDayPlayer[] = [];
      for (const teamId of teamsByDate.get(matchDate) ?? []) {
        eligiblePlayers.push(...(squadPlayersByTeamId.get(teamId) ?? []));
      }
      return { matchDate, gameweek, eligiblePlayers };
    })
    .sort((a, b) => a.matchDate.localeCompare(b.matchDate));
}

/**
 * Real site behavior, confirmed live: when only one squad player has a
 * fixture on a given match-day, that player is auto-picked as captain -
 * no vice is possible (there's no second option), and the pick needs no
 * user action at all.
 */
export function resolveAutoPick(day: MatchDay): { captain: MatchDayPlayer; vice: MatchDayPlayer | null } | null {
  if (day.eligiblePlayers.length !== 1) return null;
  return { captain: day.eligiblePlayers[0], vice: null };
}

/**
 * Writes the real auto-pick (see resolveAutoPick) for any single-option
 * match-day that doesn't already have a real pick saved - called from the
 * Captains page's data-loading step (not a click handler) so a single-
 * option day shows a real, persisted pick the moment it's viewed, exactly
 * matching the real site's own behavior, without the user having to do
 * anything. Never overwrites an existing row (manual or a prior
 * auto-pick) - only fills genuinely empty days.
 */
export async function ensureAutoPicks(supabase: Supabase, squadId: number, matchDays: MatchDay[]): Promise<void> {
  const { data: existingRows } = await supabase.from("squad_match_day_captains").select("match_date").eq("squad_id", squadId);
  const existingDates = new Set((existingRows ?? []).map((r) => r.match_date as string));

  const toInsert = matchDays
    .filter((day) => !existingDates.has(day.matchDate))
    .map((day) => ({ day, pick: resolveAutoPick(day) }))
    .filter((entry): entry is { day: MatchDay; pick: { captain: MatchDayPlayer; vice: MatchDayPlayer | null } } => entry.pick !== null)
    .map(({ day, pick }) => ({
      squad_id: squadId,
      match_date: day.matchDate,
      captain_game_player_id: pick.captain.gamePlayerId,
      vice_captain_game_player_id: pick.vice?.gamePlayerId ?? null,
      auto_picked: true,
    }));

  if (toInsert.length === 0) return;

  await supabase.from("squad_match_day_captains").insert(toInsert);
}
