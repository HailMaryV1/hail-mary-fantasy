import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { buildSquadSummary } from "@/lib/squadSummary";
import EFLFantasyBoard, { type BoardPlayer, type PoolPlayer, type BoardClub, type PoolClub } from "./EFLFantasyBoard";

export const dynamic = "force-dynamic";

type SquadRow = { id: number; name: string };

type SquadPlayerRow = {
  game_player_id: number;
  game_players: {
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD" | "CLUB"; teams: { name: string } };
  };
};

type PoolRow = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD" | "CLUB";
  team_name: string;
  hail_mary_score: number | null;
};

export default async function EFLFantasyPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", "eflfantasy").maybeSingle();

  const { data: squad } = game
    ? await supabase
        .from("squads")
        .select("id, name")
        .eq("game_id", game.id)
        .eq("user_id", user.id)
        .eq("is_archived", false)
        .order("created_at")
        .limit(1)
        .maybeSingle<SquadRow>()
    : { data: null };

  if (!game || !squad) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-lg">
          <Link href="/" className="text-sm font-medium text-navy-400 hover:text-sky-400">
            ← Back to main menu
          </Link>
          <h1 className="mt-6 text-xl font-semibold text-white">EFL Fantasy</h1>
          <p className="mt-2 text-sm text-navy-300">No squad yet.</p>
        </main>
      </div>
    );
  }

  const squadId = squad.id;

  const [{ data: squadPlayersRaw }, { data: poolRaw }, seasonTiming] = await Promise.all([
    supabase
      .from("squad_players")
      .select("game_player_id, game_players(players(full_name, position, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squadId)
      .returns<SquadPlayerRow[]>(),
    supabase.from("game_player_pool").select("game_player_id, full_name, position, team_name, hail_mary_score").eq("game_slug", "eflfantasy").returns<PoolRow[]>(),
    getSeasonTiming(supabase, game.id),
  ]);

  const planningGameweek = seasonTiming.planningGameweek ?? 1;

  const squadPlayers = (squadPlayersRaw ?? []).map((sp) => ({
    game_player_id: sp.game_player_id,
    full_name: sp.game_players.players.full_name,
    position: sp.game_players.players.position,
    team_name: sp.game_players.players.teams.name,
  }));
  const squadIds = new Set(squadPlayers.map((p) => p.game_player_id));

  const boardSquad: BoardPlayer[] = squadPlayers
    .filter((p) => p.position !== "CLUB")
    .map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      position: p.position as "GK" | "DEF" | "MID" | "FWD",
      team_name: p.team_name,
      score: (poolRaw ?? []).find((r) => r.game_player_id === p.game_player_id)?.hail_mary_score ?? null,
    }));
  const boardClubs: BoardClub[] = squadPlayers
    .filter((p) => p.position === "CLUB")
    .map((p) => ({
      game_player_id: p.game_player_id,
      club_name: p.full_name,
      score: (poolRaw ?? []).find((r) => r.game_player_id === p.game_player_id)?.hail_mary_score ?? null,
    }));

  // player scores already come straight off the score-computed
  // game_player_pool view above - override each squad member's null
  // fallback with its real score from that same view (squad_players
  // itself doesn't carry a score column).
  const scoreByGamePlayerId = new Map<number, number>((poolRaw ?? []).map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));
  boardSquad.forEach((p) => {
    p.score = scoreByGamePlayerId.get(p.game_player_id) ?? p.score;
  });
  boardClubs.forEach((c) => {
    c.score = scoreByGamePlayerId.get(c.game_player_id) ?? c.score;
  });

  const boardPool: PoolPlayer[] = (poolRaw ?? [])
    .filter((p) => p.position !== "CLUB" && !squadIds.has(p.game_player_id))
    .map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      position: p.position as "GK" | "DEF" | "MID" | "FWD",
      team_name: p.team_name,
      score: p.hail_mary_score,
    }))
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

  const boardClubPool: PoolClub[] = (poolRaw ?? [])
    .filter((p) => p.position === "CLUB" && !squadIds.has(p.game_player_id))
    .map((p) => ({ game_player_id: p.game_player_id, club_name: p.full_name, score: p.hail_mary_score }))
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

  const totalProjectedPoints =
    boardSquad.reduce((sum, p) => sum + (p.score ?? 0), 0) + boardClubs.reduce((sum, c) => sum + (c.score ?? 0), 0);
  const squadSummary = buildSquadSummary({
    players: boardSquad.map((p) => ({ fullName: p.full_name, position: p.position, price: 0, score: p.score })),
    totalProjectedPoints,
    teamValue: 0,
    budgetRemaining: 0,
    hasBudget: false,
    captain: null,
    // Fixture/health-derived reasoning lives only in the full Ask Mary
    // analysis - deliberately not run on every squad-board page load,
    // same reasoning as dreamteam/page.tsx.
    topStrength: null,
    topWeakness: null,
    nextStepTransferCount: null,
    nextStepGameweek: null,
  });

  return (
    <EFLFantasyBoard
      squadId={squadId}
      squadName={squad.name}
      planningGameweek={planningGameweek}
      squad={boardSquad}
      pool={boardPool}
      clubs={boardClubs}
      clubPool={boardClubPool}
      squadSummary={squadSummary}
    />
  );
}
