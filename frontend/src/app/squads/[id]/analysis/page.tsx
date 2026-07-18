import { notFound } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

type SquadPlayerRow = {
  game_players: {
    players: { full_name: string; position: string; team_id: number; teams: { name: string } };
  };
};

type FixtureRow = {
  fixture_id: number;
  team_id: number;
  kickoff_at: string;
  opponent: string;
  is_home: boolean;
  gameweek: number;
  attack_score: number | null;
  clean_sheet_score: number | null;
};

function classify(scores: number[], neutral: number) {
  if (scores.length === 0) return null;
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const ratio = avg / neutral;
  if (ratio >= 1.15) return { label: "Favourable run", color: "green" as const };
  if (ratio <= 0.85) return { label: "Tough fixtures ahead", color: "red" as const };
  return { label: "Mixed", color: "zinc" as const };
}

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const squadId = Number(id);
  if (!Number.isInteger(squadId)) notFound();

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: squad } = await supabase
    .from("squads")
    .select("id, name, user_id, game_id, fantasy_games(slug, display_name)")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user?.id) notFound();

  const game = squad.fantasy_games as unknown as { slug: string; display_name: string };

  const { data: squadPlayersRaw } = await supabase
    .from("squad_players")
    .select("game_players(players(full_name, position, team_id, teams(name)))")
    .eq("squad_id", squadId)
    .returns<SquadPlayerRow[]>();

  const players = (squadPlayersRaw ?? []).map((sp) => sp.game_players.players);
  const teamIds = Array.from(new Set(players.map((p) => p.team_id)));

  // Every scheduled fixture from now on for these teams (quantity is
  // always knowable - it's the real season calendar). attack_score /
  // clean_sheet_score come back null for fixtures with no odds yet.
  const { data: fixturesRaw } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures(id, kickoff_at, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))")
    .eq("game_id", squad.game_id)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek");

  const { data: difficultyRaw } = await supabase
    .from("team_fixture_difficulty")
    .select("fixture_id, team_id, attack_score, clean_sheet_score")
    .eq("game_id", squad.game_id)
    .in("team_id", teamIds);
  const difficultyByFixtureTeam = new Map(
    (difficultyRaw ?? []).map((d) => [`${d.fixture_id}:${d.team_id}`, d])
  );

  type RawFixtureJoin = {
    gameweek: number;
    fixtures: {
      id: number;
      kickoff_at: string;
      home_team_id: number;
      away_team_id: number;
      home: { name: string };
      away: { name: string };
    } | null;
  };

  const fixturesByTeam = new Map<number, FixtureRow[]>();
  for (const row of (fixturesRaw ?? []) as unknown as RawFixtureJoin[]) {
    const f = row.fixtures;
    if (!f) continue;
    for (const teamId of [f.home_team_id, f.away_team_id]) {
      if (!teamIds.includes(teamId)) continue;
      const isHome = teamId === f.home_team_id;
      const diff = difficultyByFixtureTeam.get(`${f.id}:${teamId}`);
      const list = fixturesByTeam.get(teamId) ?? [];
      list.push({
        fixture_id: f.id,
        team_id: teamId,
        kickoff_at: f.kickoff_at,
        opponent: isHome ? f.away.name : f.home.name,
        is_home: isHome,
        gameweek: row.gameweek,
        attack_score: diff ? Number(diff.attack_score) : null,
        clean_sheet_score: diff ? Number(diff.clean_sheet_score) : null,
      });
      fixturesByTeam.set(teamId, list);
    }
  }
  fixturesByTeam.forEach((list) => list.sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at)));

  const NEUTRAL_ATTACK = 1 / 3;
  const NEUTRAL_CLEAN_SHEET = 0.5;

  const teamSummaries = teamIds
    .map((teamId) => {
      const teamName = players.find((p) => p.team_id === teamId)?.teams.name ?? "?";
      const next3 = (fixturesByTeam.get(teamId) ?? []).slice(0, 3);
      const attackScores = next3.map((f) => f.attack_score).filter((s): s is number => s != null);
      const cleanSheetScores = next3.map((f) => f.clean_sheet_score).filter((s): s is number => s != null);
      const attackClass = classify(attackScores, NEUTRAL_ATTACK);
      const csClass = classify(cleanSheetScores, NEUTRAL_CLEAN_SHEET);
      return { teamId, teamName, next3, attackClass, csClass };
    })
    .sort((a, b) => a.teamName.localeCompare(b.teamName));

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold text-white">{squad.name}: look ahead</h1>
        <p className="mt-1 text-sm text-navy-300">
          {game.display_name} · next 3 fixtures per team in your squad
        </p>
        <p className="mt-1 text-xs text-amber-400">
          Fixture dates are the real season calendar, always shown. Difficulty (attack/clean-sheet)
          only shows once bookmaker odds exist for that match - typically not posted until close to
          matchday, so far-future fixtures may show as &quot;odds not posted yet&quot;.
        </p>

        <div className="mt-6 flex flex-col gap-3">
          {teamSummaries.map(({ teamId, teamName, next3, attackClass, csClass }) => (
            <div key={teamId} className="rounded-xl border border-navy-700 bg-navy-900 p-4">
              <div className="flex items-center justify-between">
                <p className="font-medium text-white">{teamName}</p>
                <div className="flex gap-1">
                  {attackClass && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        attackClass.color === "green"
                          ? "bg-emerald-950 text-emerald-400"
                          : attackClass.color === "red"
                            ? "bg-red-950 text-red-400"
                            : "bg-navy-800 text-navy-300"
                      }`}
                    >
                      Attack: {attackClass.label}
                    </span>
                  )}
                  {csClass && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        csClass.color === "green"
                          ? "bg-emerald-950 text-emerald-400"
                          : csClass.color === "red"
                            ? "bg-red-950 text-red-400"
                            : "bg-navy-800 text-navy-300"
                      }`}
                    >
                      Defence: {csClass.label}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-2 flex flex-col gap-1 text-sm text-navy-300">
                {next3.map((fx) => (
                  <div key={fx.fixture_id} className="flex items-center justify-between">
                    <span>
                      GW{fx.gameweek} · {fx.is_home ? "vs" : "@"} {fx.opponent}
                    </span>
                    <span className="text-xs">
                      {fx.attack_score != null
                        ? `${(fx.attack_score * 100).toFixed(0)}% / ${(fx.clean_sheet_score! * 100).toFixed(0)}%`
                        : "odds not posted yet"}
                    </span>
                  </div>
                ))}
                {next3.length === 0 && <span className="text-xs">No upcoming fixtures found.</span>}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
