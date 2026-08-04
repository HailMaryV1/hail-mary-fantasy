import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import DreamTeamBoard, { type BoardPlayer, type PoolPlayer, type FixtureTile } from "./DreamTeamBoard";

export const dynamic = "force-dynamic";

type SquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
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

export default async function SquadPage({ params }: { params: Promise<{ id: string }> }) {
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
      "id, name, user_id, game_id, free_transfers, active_booster, active_booster_gameweek, goal_bonus_used_gameweek, twelfth_man_used_gameweek, max_captain_used_gameweek, captain_game_player_id, vice_captain_game_player_id, fantasy_games(id, slug, display_name)"
    )
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user.id) notFound();

  const game = Array.isArray(squad.fantasy_games) ? squad.fantasy_games[0] : squad.fantasy_games;
  if (!game || game.slug !== "dreamteam") notFound();

  const [{ data: rulesRow }, { data: squadPlayersRaw }, { data: poolRaw }, seasonTiming, { count: substitutesUsed }] = await Promise.all([
    supabase.from("game_squad_rules").select("budget").eq("game_id", game.id).single(),
    supabase
      .from("squad_players")
      .select("game_player_id, is_starting, game_players(price, players(full_name, position, team_id, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squadId)
      .returns<SquadPlayerRow[]>(),
    supabase.from("game_player_pool").select("*").eq("game_slug", "dreamteam").returns<PoolRow[]>(),
    getSeasonTiming(supabase, game.id),
    supabase.from("squad_substitutions").select("id", { count: "exact", head: true }).eq("squad_id", squadId),
  ]);

  const rules = rulesRow ?? { budget: 50 };
  const planningGameweek = seasonTiming.planningGameweek ?? 1;

  const squadPlayers = (squadPlayersRaw ?? []).map((sp) => ({
    game_player_id: sp.game_player_id,
    is_starting: sp.is_starting,
    price: sp.game_players.price,
    full_name: sp.game_players.players.full_name,
    position: sp.game_players.players.position,
    team_id: sp.game_players.players.team_id,
    team_name: sp.game_players.players.teams.name,
  }));
  const squadIds = new Set(squadPlayers.map((p) => p.game_player_id));
  const teamValue = squadPlayers.reduce((sum, p) => sum + Number(p.price), 0);
  const bank = Number(rules.budget) - teamValue;

  // Real per-gameweek projected scores for this specific planning
  // gameweek - player_projection_summary always exposes exactly the
  // gameweek closest to "now" per player (see its view definition), which
  // is guaranteed to line up with planningGameweek since both resolve
  // "next actionable gameweek" the same way.
  const { data: scoreRows } = await supabase
    .from("player_projection_summary")
    .select("game_player_id, hail_mary_score")
    .eq("game_slug", "dreamteam");
  const scoreByGamePlayerId = new Map<number, number>((scoreRows ?? []).map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));

  // Real fixture-difficulty tiles for GW(planning) through GW(planning+5),
  // per team - reuses the existing team_fixture_difficulty table (already
  // built for the Fixtures page) rather than inventing a new source.
  const { data: gwFixtureRows } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures(id, home_team_id, away_team_id, teams_home:teams!fixtures_home_team_id_fkey(name), teams_away:teams!fixtures_away_team_id_fkey(name))")
    .eq("game_id", game.id)
    .gte("gameweek", planningGameweek)
    .lte("gameweek", planningGameweek + 5);
  const { data: difficultyRows } = await supabase
    .from("team_fixture_difficulty")
    .select("fixture_id, team_id, attack_score")
    .eq("game_id", game.id);
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

  const boardSquad: BoardPlayer[] = squadPlayers.map((p) => ({
    game_player_id: p.game_player_id,
    full_name: p.full_name,
    position: p.position,
    team_name: p.team_name,
    price: Number(p.price),
    score: scoreByGamePlayerId.get(p.game_player_id) ?? null,
    isCaptain: p.game_player_id === squad.captain_game_player_id,
    isViceCaptain: p.game_player_id === squad.vice_captain_game_player_id,
    fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${p.team_id}:${planningGameweek + i}`) ?? null),
  }));

  const boardPool: PoolPlayer[] = (poolRaw ?? [])
    .filter((p) => !squadIds.has(p.game_player_id))
    .map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      position: p.position,
      team_name: p.team_name,
      price: Number(p.price),
      score: scoreByGamePlayerId.get(p.game_player_id) ?? Number(p.hail_mary_score ?? 0),
      fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${p.team_id}:${planningGameweek + i}`) ?? null),
    }))
    .sort((a, b) => b.score - a.score);

  return (
    <DreamTeamBoard
      squadId={squadId}
      squadName={squad.name}
      transfers={squad.free_transfers}
      bank={bank}
      teamValue={teamValue}
      planningGameweek={planningGameweek}
      boosters={{
        active: squad.active_booster as "goal_bonus" | "twelfth_man" | "max_captain" | null,
        activeGameweek: squad.active_booster_gameweek,
        goalBonusUsed: squad.goal_bonus_used_gameweek != null,
        twelfthManUsed: squad.twelfth_man_used_gameweek != null,
        maxCaptainUsed: squad.max_captain_used_gameweek != null,
      }}
      substitutesUsed={substitutesUsed ?? 0}
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
