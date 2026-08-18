import type { createAuthServerClient } from "./supabaseServerClient";
import { getProjectionsForPlayerIds } from "./gameweek";

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
      .select("game_player_id, game_players(position_code, players(full_name, team_id, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squadId)
      .returns<
        {
          game_player_id: number;
          game_players: { position_code: string; players: { full_name: string; team_id: number; teams: { name: string } } };
        }[]
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
    position: r.game_players.position_code,
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
 *
 * Real user request 2026-08-18: "I would want Mary to ensure i have a
 * captain for every single gameday." A single-option day was always
 * covered, but a multi-option day previously stayed genuinely empty
 * until the user opened the Captains page and picked one by hand -
 * exactly the gap the user is describing. When scoresByGamePlayerId is
 * supplied (see fetchScoresForMatchDays below) this now also resolves
 * multi-option days, picking the highest-projected eligible player as
 * captain and the next-highest as vice - the same "top scorer" logic
 * cloudffAskMaryEngine.ts's own captain recommendation already used for
 * display, now actually persisted so there's a real pick on record
 * rather than just a suggestion. The user can always override it - see
 * MatchDayCaptainPicker.tsx, which never disables its buttons for a
 * multi-option day even when auto_picked is true.
 */
export function resolveAutoPick(
  day: MatchDay,
  scoresByGamePlayerId?: Map<number, number>
): { captain: MatchDayPlayer; vice: MatchDayPlayer | null } | null {
  if (day.eligiblePlayers.length === 0) return null;
  if (day.eligiblePlayers.length === 1) return { captain: day.eligiblePlayers[0], vice: null };
  if (!scoresByGamePlayerId) return null;
  const ranked = [...day.eligiblePlayers].sort(
    (a, b) => (scoresByGamePlayerId.get(b.gamePlayerId) ?? -Infinity) - (scoresByGamePlayerId.get(a.gamePlayerId) ?? -Infinity)
  );
  return { captain: ranked[0], vice: ranked[1] ?? null };
}

/**
 * Builds the score lookup resolveAutoPick's multi-option branch needs,
 * one Map per real gameweek in the window (a player's own projected
 * score can differ gameweek to gameweek, so a double-gameweek's two
 * match-days are scored independently rather than sharing one number).
 * Reads the same `projections` table every board page already reads via
 * getProjectionsForPlayerIds - no new data source.
 */
export async function fetchScoresForMatchDays(supabase: Supabase, matchDays: MatchDay[]): Promise<Map<number, Map<number, number>>> {
  const gameweeks = Array.from(new Set(matchDays.map((d) => d.gameweek)));
  const allPlayerIds = Array.from(new Set(matchDays.flatMap((d) => d.eligiblePlayers.map((p) => p.gamePlayerId))));
  const byGameweek = new Map<number, Map<number, number>>();
  if (allPlayerIds.length === 0) return byGameweek;

  await Promise.all(
    gameweeks.map(async (gw) => {
      const rows = await getProjectionsForPlayerIds(supabase, gw, allPlayerIds);
      const scoreMap = new Map<number, number>();
      for (const r of rows) {
        if (r.hail_mary_score != null) scoreMap.set(r.game_player_id, Number(r.hail_mary_score));
      }
      byGameweek.set(gw, scoreMap);
    })
  );
  return byGameweek;
}

/**
 * Writes the real auto-pick (see resolveAutoPick) for any match-day that
 * doesn't already have a real pick saved - called from every page that
 * touches a Cloud FF squad's captains (the Captains page itself, the
 * main squad page on every load, and makeTransfer right after a
 * transfer) so a day never sits genuinely uncaptained just because the
 * user hasn't visited the Captains page. Never overwrites an existing
 * row (manual or a prior auto-pick) - only fills genuinely empty days. A
 * day with zero eligible players still resolves to null (nothing to
 * pick) - that's a real squad-coverage gap surfaced elsewhere (see
 * countUncoveredMatchDays), not something this can paper over.
 */
export async function ensureAutoPicks(
  supabase: Supabase,
  squadId: number,
  matchDays: MatchDay[],
  scoresByGameweek?: Map<number, Map<number, number>>
): Promise<void> {
  const { data: existingRows } = await supabase.from("squad_match_day_captains").select("match_date").eq("squad_id", squadId);
  const existingDates = new Set((existingRows ?? []).map((r) => r.match_date as string));

  const toInsert = matchDays
    .filter((day) => !existingDates.has(day.matchDate))
    .map((day) => ({ day, pick: resolveAutoPick(day, scoresByGameweek?.get(day.gameweek)) }))
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

/**
 * The one gap Mary genuinely can't auto-pick her way out of: a match-day
 * where none of the squad's players have a fixture at all. Surfaced on
 * the squad page banner and in Squad Health as a real weakness pointing
 * at a transfer, not silently absorbed into "coverage is fine now that
 * auto-pick exists."
 */
export function countUncoveredMatchDays(matchDays: MatchDay[]): number {
  return matchDays.filter((day) => day.eligiblePlayers.length === 0).length;
}
