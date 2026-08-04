import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

type FixtureGameweekRow = { gameweek: number; fixtures: { kickoff_at: string } };

/**
 * "Which gameweek can transfers/recommendations still actually affect" -
 * the instant a gameweek's first ball is kicked, planning shifts to the
 * next one, even if that gameweek still has fixtures left to play.
 */
export async function getSeasonTiming(
  supabase: Supabase,
  gameId: number
): Promise<{ seasonStarted: boolean; planningGameweek: number | null }> {
  const { data } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures(kickoff_at)")
    .eq("game_id", gameId)
    .returns<FixtureGameweekRow[]>();

  if (!data || data.length === 0) {
    return { seasonStarted: false, planningGameweek: null };
  }

  const earliestKickoffByGameweek = new Map<number, number>();
  for (const row of data) {
    const t = new Date(row.fixtures.kickoff_at).getTime();
    const current = earliestKickoffByGameweek.get(row.gameweek);
    if (current === undefined || t < current) earliestKickoffByGameweek.set(row.gameweek, t);
  }

  const now = Date.now();
  const gameweek1Kickoff = earliestKickoffByGameweek.get(1);
  const seasonStarted = gameweek1Kickoff !== undefined && now >= gameweek1Kickoff;

  const upcoming = Array.from(earliestKickoffByGameweek.entries())
    .filter(([, kickoff]) => kickoff >= now)
    .sort((a, b) => a[0] - b[0]);
  const planningGameweek = upcoming.length > 0 ? upcoming[0][0] : null;

  return { seasonStarted, planningGameweek };
}
