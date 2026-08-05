// Real, stable per-game rule (confirmed by the user, not derived from
// current squad counts): Dream Team and Cloud FF are apps tied to one
// personal squad each - no selector needed, go straight to it. FanTeam
// and NFL FanTeam are entry-based competitions where a user can hold
// many squads at once, so they need a team-selector step.
const SINGLE_TEAM_GAMES = new Set(["dreamteam", "cloudff"]);

export function isSingleTeamGame(slug: string): boolean {
  return SINGLE_TEAM_GAMES.has(slug);
}

// FanTeam Golf doesn't fit the squad-selector model at all - it's
// tournament-scoped (a fresh player pool/price sheet every week, see
// migration 0045's docstring), not a persistent squad you pick from a
// list. It has its own dedicated /golf/* route tree instead of going
// through /squads/[id] (which only knows how to render fanteam/dreamteam
// squads).
const TOURNAMENT_GAMES = new Set(["fanteam-golf"]);

export function isTournamentGame(slug: string): boolean {
  return TOURNAMENT_GAMES.has(slug);
}
