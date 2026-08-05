import {
  computeTeamGameweekRatios,
  detectFixtureRuns,
  type FixtureDifficultyRow,
  type FixtureRun,
  type TeamGameweekRatio,
} from "./fixtureRuns";

// How many of a team's soonest upcoming gameweeks count as "right now" for
// the panel's "current rating" - short enough to mean "this week or next,"
// long enough to smooth over a single missing-odds gameweek.
const CURRENT_WINDOW = 2;

export type TeamFixtureRating = {
  teamName: string;
  swingDirection: "improving" | "declining" | "stable";
  startsInGameweek: number | null;
  currentRating: number;
  upcomingRating: number;
  swingValue: number;
  nearestRun: FixtureRun | null;
};

/**
 * Thin derived view over detectFixtureRuns()'s existing output - not a
 * parallel fixture classifier. "Current" = this team's own per-gameweek
 * ratio (computeTeamGameweekRatios) averaged over its next CURRENT_WINDOW
 * gameweeks. "Upcoming" = whichever good/bad run starts soonest, reusing
 * that run's avgScore exactly as fixtureRuns.ts already computes it.
 * swingValue is just their difference. A team with no detected run
 * (nothing crosses the >=1.15/<=0.85 thresholds for 3+ gameweeks) is
 * "stable", not an error.
 */
export function deriveTeamFixtureRatings(rows: FixtureDifficultyRow[]): TeamFixtureRating[] {
  const ratios = computeTeamGameweekRatios(rows);
  const runs = detectFixtureRuns(rows);

  const ratiosByTeam = new Map<string, TeamGameweekRatio[]>();
  for (const r of ratios) {
    const list = ratiosByTeam.get(r.teamName) ?? [];
    list.push(r);
    ratiosByTeam.set(r.teamName, list);
  }

  const runsByTeam = new Map<string, FixtureRun[]>();
  for (const run of runs) {
    const list = runsByTeam.get(run.teamName) ?? [];
    list.push(run);
    runsByTeam.set(run.teamName, list);
  }

  const results: TeamFixtureRating[] = [];
  for (const [teamName, teamRatios] of ratiosByTeam) {
    const sorted = teamRatios.slice().sort((a, b) => a.gameweek - b.gameweek);
    const currentWindow = sorted
      .slice(0, CURRENT_WINDOW)
      .map((r) => r.ratio)
      .filter((r): r is number => r != null);
    // 1.0 = exactly this team's own baseline (the ratio scale's neutral
    // point) - the sensible "we don't know yet" default when odds for the
    // next couple of gameweeks simply haven't been posted.
    const currentRating = currentWindow.length > 0 ? currentWindow.reduce((a, b) => a + b, 0) / currentWindow.length : 1;

    const teamRuns = (runsByTeam.get(teamName) ?? []).slice().sort((a, b) => a.startGameweek - b.startGameweek);
    const nearestRun = teamRuns[0] ?? null;

    const upcomingRating = nearestRun ? nearestRun.avgScore : currentRating;
    const swingDirection: TeamFixtureRating["swingDirection"] = nearestRun
      ? nearestRun.kind === "good"
        ? "improving"
        : "declining"
      : "stable";

    results.push({
      teamName,
      swingDirection,
      startsInGameweek: nearestRun?.startGameweek ?? null,
      currentRating,
      upcomingRating,
      swingValue: upcomingRating - currentRating,
      nearestRun,
    });
  }

  return results;
}

export type FixtureStripEntry = {
  gameweek: number;
  opponent: string;
  isHome: boolean;
  ratio: number | null;
};

/**
 * The next `limit` fixtures for one team, each tagged with its own
 * per-gameweek ratio (reused from computeTeamGameweekRatios). Opponent/
 * home-away isn't part of FixtureDifficultyRow (fixtureRuns.ts doesn't
 * need it), so the caller supplies a small lookup built from the same
 * fixtures/game_fixture_gameweeks join used elsewhere.
 */
export function buildFixtureStrip(
  teamName: string,
  ratios: TeamGameweekRatio[],
  meta: Map<string, { opponent: string; isHome: boolean }>,
  limit = 5
): FixtureStripEntry[] {
  return ratios
    .filter((r) => r.teamName === teamName)
    .sort((a, b) => a.gameweek - b.gameweek)
    .slice(0, limit)
    .map((r) => {
      const m = meta.get(`${teamName}:${r.gameweek}`);
      return {
        gameweek: r.gameweek,
        opponent: m?.opponent ?? "?",
        isHome: m?.isHome ?? true,
        ratio: r.ratio,
      };
    });
}
