// Real, stable per-game rule (confirmed by the user, not derived from
// current squad counts): Dream Team and Cloud FF are apps tied to one
// personal squad each - no selector needed, go straight to it. FanTeam
// and NFL FanTeam are entry-based competitions where a user can hold
// many squads at once, so they need a team-selector step. EFL Fantasy is
// the same self-contained single-squad pattern as Dream Team/Cloud FF -
// Hail Mary is the planning tool, the user replicates picks on the real
// site themselves (no external account/auth, unlike FanTeam).
const SINGLE_TEAM_GAMES = new Set(["dreamteam", "cloudff", "eflfantasy"]);

export function isSingleTeamGame(slug: string): boolean {
  return SINGLE_TEAM_GAMES.has(slug);
}

// EFL Fantasy has no price/budget system at all - confirmed live via its
// own public players.json (no price/value field on any of its 3,386 real
// players) and the real site never shows a budget figure (see migration
// 0089's docstring). Every other game DOES have a real budget - gates the
// Bank/Value stat tiles and Value Bands filters, which would otherwise
// show a meaningless £0.00 for this game.
const NO_BUDGET_GAMES = new Set(["eflfantasy"]);

export function hasBudget(slug: string): boolean {
  return !NO_BUDGET_GAMES.has(slug);
}

// FanTeam Golf doesn't fit the squad-selector model at all - it's
// tournament-scoped (a fresh player pool/price sheet every week, see
// migration 0045's docstring), not a persistent squad you pick from a
// list. It has its own dedicated /golf/* route tree, same principle as
// /fanteam and /dreamteam each having their own tree instead of a
// shared squad-selector - every game keeps its own identity.
const TOURNAMENT_GAMES = new Set(["fanteam-golf"]);

export function isTournamentGame(slug: string): boolean {
  return TOURNAMENT_GAMES.has(slug);
}
