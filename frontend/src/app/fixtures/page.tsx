import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";
import { detectFixtureRuns, type FixtureDifficultyRow, type FixtureRun } from "@/lib/fixtureRuns";
import Badge from "../squads/Badge";
import GameSecondaryNav from "../GameSecondaryNav";

const GAMES = [
  { slug: "dreamteam", label: "Dream Team" },
  { slug: "fanteam", label: "FanTeam" },
] as const;

type RawFixtureJoin = {
  gameweek: number;
  fixtures: {
    id: number;
    home_team_id: number;
    away_team_id: number;
    home: { name: string };
    away: { name: string };
  } | null;
};

export default async function FixturesPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string }>;
}) {
  const { game: gameParam } = await searchParams;
  const activeGame = GAMES.find((g) => g.slug === gameParam) ?? GAMES[0];

  const supabase = createServerSupabaseClient();

  const { data: game } = await supabase
    .from("fantasy_games")
    .select("id, slug")
    .eq("slug", activeGame.slug)
    .single();

  let runs: FixtureRun[] = [];
  let calendarAvailable = false;

  if (game) {
    const { data: fixturesRaw } = await supabase
      .from("game_fixture_gameweeks")
      .select(
        "gameweek, fixtures(id, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))"
      )
      .eq("game_id", game.id)
      .gte("fixtures.kickoff_at", new Date().toISOString())
      .order("gameweek");

    calendarAvailable = (fixturesRaw ?? []).some((r) => (r as unknown as RawFixtureJoin).fixtures != null);

    if (calendarAvailable) {
      const { data: difficultyRaw } = await supabase
        .from("team_fixture_difficulty")
        .select("fixture_id, team_id, attack_score, clean_sheet_score")
        .eq("game_id", game.id);
      const difficultyByFixtureTeam = new Map(
        (difficultyRaw ?? []).map((d) => [`${d.fixture_id}:${d.team_id}`, d])
      );

      const rows: FixtureDifficultyRow[] = [];
      for (const row of (fixturesRaw ?? []) as unknown as RawFixtureJoin[]) {
        const f = row.fixtures;
        if (!f) continue;
        for (const [teamId, teamName] of [
          [f.home_team_id, f.home.name],
          [f.away_team_id, f.away.name],
        ] as const) {
          const diff = difficultyByFixtureTeam.get(`${f.id}:${teamId}`);
          rows.push({
            teamName,
            gameweek: row.gameweek,
            attackScore: diff ? Number(diff.attack_score) : null,
            cleanSheetScore: diff ? Number(diff.clean_sheet_score) : null,
          });
        }
      }

      runs = detectFixtureRuns(rows);
    }
  }

  const goodRuns = runs.filter((r) => r.kind === "good").sort((a, b) => a.startGameweek - b.startGameweek);
  const badRuns = runs.filter((r) => r.kind === "bad").sort((a, b) => a.startGameweek - b.startGameweek);

  function RunCard({ run }: { run: FixtureRun }) {
    const good = run.kind === "good";
    return (
      <div
        className={`rounded-xl border p-4 ${
          good ? "border-emerald-900 bg-navy-900" : "border-red-900 bg-navy-900"
        }`}
      >
        <div className="flex items-center gap-2">
          <Badge teamName={run.teamName} size="sm" />
          <p className="font-medium text-white">{run.teamName}</p>
        </div>
        <p className="mt-2 text-sm text-navy-300">
          GW{run.startGameweek} – GW{run.endGameweek}
        </p>
        <span
          className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            good ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
          }`}
        >
          {run.length} gameweeks
        </span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <div className="mb-4">
          <GameSecondaryNav gameSlug={activeGame.slug} gameDisplayName={activeGame.label} />
        </div>

        <h1 className="text-2xl font-semibold text-white">Fixture ticker</h1>
        <p className="mt-1 text-sm text-navy-300">
          Runs of 3+ consecutive gameweeks that look favourable or tough for a club - use it to plan transfers ahead of the run, not just react to your own squad&apos;s next fixture.
        </p>

        <nav className="mt-6 flex gap-2">
          {GAMES.map((g) => (
            <Link
              key={g.slug}
              href={`/fixtures?game=${g.slug}`}
              prefetch={false}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                g.slug === activeGame.slug
                  ? "bg-sky-500 text-navy-950"
                  : "bg-navy-900 text-navy-300 hover:bg-navy-800 hover:text-white"
              }`}
            >
              {g.label}
            </Link>
          ))}
        </nav>

        {!calendarAvailable && (
          <p className="mt-8 text-sm text-amber-400">
            Gameweek calendar not published for {activeGame.label} yet - the fixture ticker needs a real gameweek schedule to detect runs.
          </p>
        )}

        {calendarAvailable && (
          <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <h2 className="text-sm font-medium uppercase tracking-wide text-emerald-400">Good runs</h2>
              <div className="mt-3 flex flex-col gap-3">
                {goodRuns.map((r) => (
                  <RunCard key={`${r.teamName}-${r.startGameweek}`} run={r} />
                ))}
                {goodRuns.length === 0 && (
                  <p className="text-sm text-navy-400">No favourable runs of 3+ gameweeks found right now.</p>
                )}
              </div>
            </div>
            <div>
              <h2 className="text-sm font-medium uppercase tracking-wide text-red-400">Tough runs</h2>
              <div className="mt-3 flex flex-col gap-3">
                {badRuns.map((r) => (
                  <RunCard key={`${r.teamName}-${r.startGameweek}`} run={r} />
                ))}
                {badRuns.length === 0 && (
                  <p className="text-sm text-navy-400">No tough runs of 3+ gameweeks found right now.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
