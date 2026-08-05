import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import FanTeamBoard, { type BoardPlayer, type PoolPlayer, type FixtureTile } from "./FanTeamBoard";

export const dynamic = "force-dynamic";

type SquadRow = {
  id: number;
  name: string;
  user_id: string;
  game_id: number;
  free_transfers: number;
  wildcard_1_used_gameweek: number | null;
  wildcard_2_used_gameweek: number | null;
  captain_game_player_id: number | null;
  vice_captain_game_player_id: number | null;
  fantasy_games: { slug: string } | { slug: string }[];
};

type FanteamSquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  bench_order: number | null;
  game_players: {
    price: number;
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD"; team_id: number; teams: { name: string } };
  };
};

type PoolRow = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  price: number;
  hail_mary_score: number | null;
  lineup: string | null;
  status: string | null;
};

// Shape of compute_projections.py's decomposed-scoring `inputs` blob -
// only the fields the "Sort by" dropdown needs, not the full structure.
type ProjectionInputs = {
  fixtures?: { stats?: { goal?: { projected?: number }; assist?: { projected?: number } } }[];
  reconciliation?: { bonus?: number };
};

export default async function FanTeamSquadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const squadId = Number(id);

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: squad } = await supabase
    .from("squads")
    .select(
      "id, name, user_id, game_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek, captain_game_player_id, vice_captain_game_player_id, fantasy_games(slug)"
    )
    .eq("id", squadId)
    .single<SquadRow>();
  if (!squad || squad.user_id !== user.id) notFound();

  const game = Array.isArray(squad.fantasy_games) ? squad.fantasy_games[0] : squad.fantasy_games;
  if (!game || game.slug !== "fanteam") notFound();

  const [{ data: rulesRow }, { data: squadPlayersRaw }, { data: poolRaw }, seasonTiming, { data: formationsRaw }, { data: linkRow }] =
    await Promise.all([
      supabase.from("game_squad_rules").select("budget, max_per_club").eq("game_id", squad.game_id).single(),
      supabase
        .from("squad_players")
        .select(
          "game_player_id, is_starting, bench_order, game_players(price, players(full_name, position, team_id, teams!players_team_id_fkey(name)))"
        )
        .eq("squad_id", squadId)
        .returns<FanteamSquadPlayerRow[]>(),
      supabase.from("game_player_pool").select("*").eq("game_slug", "fanteam").returns<PoolRow[]>(),
      getSeasonTiming(supabase, squad.game_id),
      supabase
        .from("game_formations")
        .select("code, gk_count, def_count, mid_count, fwd_count")
        .eq("game_id", squad.game_id)
        .returns<{ code: string; gk_count: number; def_count: number; mid_count: number; fwd_count: number }[]>(),
      supabase.from("provider_squad_links").select("sync_enabled").eq("squad_id", squadId).maybeSingle(),
    ]);

  const rules = rulesRow ?? { budget: 100, max_per_club: 3 };
  const planningGameweek = seasonTiming.planningGameweek ?? 1;
  const formations = formationsRaw ?? [];

  const squadPlayers = (squadPlayersRaw ?? []).map((sp) => ({
    game_player_id: sp.game_player_id,
    is_starting: sp.is_starting,
    bench_order: sp.bench_order,
    price: sp.game_players.price,
    full_name: sp.game_players.players.full_name,
    position: sp.game_players.players.position,
    team_id: sp.game_players.players.team_id,
    team_name: sp.game_players.players.teams.name,
  }));
  const squadIds = new Set(squadPlayers.map((p) => p.game_player_id));
  const teamValue = squadPlayers.reduce((sum, p) => sum + Number(p.price), 0);
  const bank = Number(rules.budget) - teamValue;

  // These three reads (scores, fixture-gameweeks, fixture-difficulty) are
  // independent of each other's results - only combined afterward in JS -
  // so they run as one Promise.all instead of three back-to-back network
  // round trips (see dreamteam/page.tsx's identical fix).
  const [{ data: scoreRows }, { data: gwFixtureRows }, { data: difficultyRows }] = await Promise.all([
    supabase
      .from("player_projection_summary")
      .select("game_player_id, hail_mary_score, inputs")
      .eq("game_slug", "fanteam")
      .returns<{ game_player_id: number; hail_mary_score: number | null; inputs: ProjectionInputs | null }[]>(),
    supabase
      .from("game_fixture_gameweeks")
      .select("gameweek, fixtures(id, home_team_id, away_team_id, teams_home:teams!fixtures_home_team_id_fkey(name), teams_away:teams!fixtures_away_team_id_fkey(name))")
      .eq("game_id", squad.game_id)
      .gte("gameweek", planningGameweek)
      .lte("gameweek", planningGameweek + 5),
    supabase.from("team_fixture_difficulty").select("fixture_id, team_id, attack_score").eq("game_id", squad.game_id),
  ]);
  const scoreByGamePlayerId = new Map<number, number>((scoreRows ?? []).map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));
  const statsByGamePlayerId = new Map<number, { goalProjected: number; assistProjected: number; bonusProjected: number }>(
    (scoreRows ?? []).map((r) => {
      const primaryStats = r.inputs?.fixtures?.[0]?.stats;
      return [
        r.game_player_id,
        {
          goalProjected: Number(primaryStats?.goal?.projected ?? 0),
          assistProjected: Number(primaryStats?.assist?.projected ?? 0),
          bonusProjected: Number(r.inputs?.reconciliation?.bonus ?? 0),
        },
      ];
    })
  );
  const difficultyByFixtureTeam = new Map((difficultyRows ?? []).map((d) => [`${d.fixture_id}:${d.team_id}`, Number(d.attack_score)]));

  type GwFixtureRow = {
    gameweek: number;
    fixtures: { id: number; home_team_id: number; away_team_id: number; teams_home: { name: string }; teams_away: { name: string } };
  };
  const tilesByTeamGw = new Map<string, FixtureTile>();
  for (const row of (gwFixtureRows ?? []) as unknown as GwFixtureRow[]) {
    const f = row.fixtures;
    for (const [teamId, oppName, isHome] of [
      [f.home_team_id, f.teams_away.name, true],
      [f.away_team_id, f.teams_home.name, false],
    ] as [number, string, boolean][]) {
      const key = `${teamId}:${row.gameweek}`;
      const difficulty = difficultyByFixtureTeam.get(`${f.id}:${teamId}`) ?? 0.5;
      tilesByTeamGw.set(key, { opponentAbbr: abbreviate(oppName), isHome, difficulty });
    }
  }

  const emptyStats = { goalProjected: 0, assistProjected: 0, bonusProjected: 0 };

  const boardSquad: BoardPlayer[] = squadPlayers.map((p) => ({
    game_player_id: p.game_player_id,
    full_name: p.full_name,
    position: p.position,
    team_name: p.team_name,
    team_id: p.team_id,
    price: Number(p.price),
    score: scoreByGamePlayerId.get(p.game_player_id) ?? null,
    isCaptain: p.game_player_id === squad.captain_game_player_id,
    isViceCaptain: p.game_player_id === squad.vice_captain_game_player_id,
    isStarting: p.is_starting,
    benchOrder: p.bench_order,
    fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${p.team_id}:${planningGameweek + i}`) ?? null),
    ...(statsByGamePlayerId.get(p.game_player_id) ?? emptyStats),
  }));

  const boardPool: PoolPlayer[] = (poolRaw ?? [])
    .filter((p) => !squadIds.has(p.game_player_id))
    .map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      position: p.position,
      team_name: p.team_name,
      team_id: p.team_id,
      price: Number(p.price),
      score: scoreByGamePlayerId.get(p.game_player_id) ?? Number(p.hail_mary_score ?? 0),
      fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${p.team_id}:${planningGameweek + i}`) ?? null),
      ...(statsByGamePlayerId.get(p.game_player_id) ?? emptyStats),
    }))
    .sort((a, b) => b.score - a.score);

  const startingCounts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of squadPlayers) if (p.is_starting) startingCounts[p.position] += 1;
  const currentFormationCode =
    formations.find(
      (f) => f.gk_count === startingCounts.GK && f.def_count === startingCounts.DEF && f.mid_count === startingCounts.MID && f.fwd_count === startingCounts.FWD
    )?.code ?? null;

  return (
    <FanTeamBoard
      squadId={squadId}
      squadName={squad.name}
      transfers={squad.free_transfers}
      bank={bank}
      teamValue={teamValue}
      planningGameweek={planningGameweek}
      wildcard1UsedGameweek={squad.wildcard_1_used_gameweek}
      wildcard2UsedGameweek={squad.wildcard_2_used_gameweek}
      maxPerClub={Number(rules.max_per_club ?? 3)}
      seasonStarted={seasonTiming.seasonStarted}
      formations={formations}
      currentFormationCode={currentFormationCode}
      isProviderSynced={linkRow?.sync_enabled ?? false}
      rawCaptainId={squad.captain_game_player_id}
      rawViceCaptainId={squad.vice_captain_game_player_id}
      squad={boardSquad}
      pool={boardPool}
    />
  );
}

function abbreviate(teamName: string): string {
  return teamName
    .replace(/^(AFC|FC)\s+/, "")
    .replace(/\s+(FC|United|Town|City|Hotspur|Wanderers|Albion)$/, "")
    .slice(0, 3)
    .toUpperCase();
}
