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
 * the shared query both setMatchDayCaptain (squads/actions.ts, validating
 * a single day+player choice) and the Captains page
 * (squads/[id]/captains/page.tsx, rendering every day in the window) read
 * from, so they can never disagree about which players are legally
 * eligible on which day.
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
  const { data: rows } = await supabase
    .from("squad_players")
    .select(
      "game_player_id, game_players(players(full_name, position, team_id, teams!players_team_id_fkey(name)))"
    )
    .eq("squad_id", squadId)
    .returns<
      { game_player_id: number; game_players: { players: { full_name: string; position: string; team_id: number; teams: { name: string } } } }[]
    >();
  const squadPlayers = (rows ?? []).map((r) => ({
    gamePlayerId: r.game_player_id,
    fullName: r.game_players.players.full_name,
    teamId: r.game_players.players.team_id,
    teamName: r.game_players.players.teams.name,
    position: r.game_players.players.position,
  }));
  if (squadPlayers.length === 0) return [];

  const teamIds = Array.from(new Set(squadPlayers.map((p) => p.teamId)));

  const { data: fixtureRows } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures(kickoff_at, home_team_id, away_team_id)")
    .eq("game_id", gameId)
    .gte("gameweek", gameweekFrom)
    .lte("gameweek", gameweekTo)
    .returns<{ gameweek: number; fixtures: { kickoff_at: string; home_team_id: number; away_team_id: number } }[]>();

  // team_id -> Set of real match-dates (YYYY-MM-DD, UTC) that team plays,
  // plus which gameweek each date belongs to - a team could in principle
  // have two fixtures in the same gameweek (a real double-gameweek), each
  // its own distinct match-day, which this naturally keeps separate since
  // it's keyed by date, not gameweek.
  const datesByTeamId = new Map<number, Map<string, number>>();
  for (const row of fixtureRows ?? []) {
    if (!teamIds.includes(row.fixtures.home_team_id) && !teamIds.includes(row.fixtures.away_team_id)) continue;
    const matchDate = row.fixtures.kickoff_at.slice(0, 10);
    for (const teamId of [row.fixtures.home_team_id, row.fixtures.away_team_id]) {
      if (!teamIds.includes(teamId)) continue;
      const dates = datesByTeamId.get(teamId) ?? new Map<string, number>();
      dates.set(matchDate, row.gameweek);
      datesByTeamId.set(teamId, dates);
    }
  }

  const playersByMatchDate = new Map<string, { gameweek: number; players: MatchDayPlayer[] }>();
  for (const p of squadPlayers) {
    const dates = datesByTeamId.get(p.teamId);
    if (!dates) continue;
    for (const [matchDate, gameweek] of dates) {
      const entry = playersByMatchDate.get(matchDate) ?? { gameweek, players: [] };
      entry.players.push({ gamePlayerId: p.gamePlayerId, fullName: p.fullName, teamName: p.teamName, position: p.position });
      playersByMatchDate.set(matchDate, entry);
    }
  }

  return Array.from(playersByMatchDate.entries())
    .map(([matchDate, { gameweek, players }]) => ({ matchDate, gameweek, eligiblePlayers: players }))
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
  const { data: existingRows } = await supabase
    .from("squad_match_day_captains")
    .select("match_date")
    .eq("squad_id", squadId);
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
