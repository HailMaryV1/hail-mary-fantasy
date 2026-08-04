// Real, stable per-game rule (confirmed by the user, not derived from
// current squad counts): Dream Team and Cloud FF are apps tied to one
// personal squad each - no selector needed, go straight to it. FanTeam,
// NFL FanTeam, and FanTeam Golf are entry-based competitions where a
// user can hold many squads at once, so they need a team-selector step.
const SINGLE_TEAM_GAMES = new Set(["dreamteam", "cloudff"]);

export function isSingleTeamGame(slug: string): boolean {
  return SINGLE_TEAM_GAMES.has(slug);
}
