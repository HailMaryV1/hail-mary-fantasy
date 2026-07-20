import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { suggestBestXI } from "@/lib/squadOptimizer";
import LineupBuilder from "./LineupBuilder";

// See rankings/page.tsx for why this is needed - Supabase's .rpc() POSTs
// to a fixed URL regardless of parameters, so Next's fetch Data Cache can
// serve a stale response for this squad's best-XI suggestion.
export const dynamic = "force-dynamic";

type SquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  game_players: {
    price: number;
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD"; teams: { name: string } };
  };
};

export default async function LineupPage({ params }: { params: Promise<{ id: string }> }) {
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

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("*")
    .eq("game_id", squad.game_id)
    .single();
  if (!rules) notFound();

  if (rules.squad_size === rules.starting_size) {
    // No bench in this game - the squad already IS the starting XI.
    redirect("/squads");
  }

  const { data: formations } = await supabase
    .from("game_formations")
    .select("code, gk_count, def_count, mid_count, fwd_count")
    .eq("game_id", squad.game_id)
    .order("code");

  const { data: squadPlayers } = await supabase
    .from("squad_players")
    .select("game_player_id, is_starting, game_players(price, players(full_name, position, teams(name)))")
    .eq("squad_id", squadId)
    .returns<SquadPlayerRow[]>();

  const game = squad.fantasy_games as unknown as { slug: string; display_name: string };

  // Next-gameweek score per squad player, for the "Auto-fill optimal XI"
  // suggestion - same player_score_by_horizon RPC the rankings page uses,
  // just called with a 1-gameweek horizon and filtered to this squad.
  const { data: horizonData } = await supabase.rpc("player_score_by_horizon", {
    p_game_slug: game.slug,
    p_num_gameweeks: 1,
  });
  const scoreByGamePlayerId = new Map(
    ((horizonData ?? []) as { game_player_id: number; avg_score: number }[]).map((r) => [r.game_player_id, Number(r.avg_score)])
  );

  // squadPlayers comes from squad_players/game_players (not
  // game_player_pool), so it needs its own status merge - query the same
  // view by id instead of duplicating the "latest captured status" lookup.
  const { data: statusRows } = await supabase
    .from("game_player_pool")
    .select("game_player_id, lineup, status")
    .eq("game_slug", game.slug)
    .in("game_player_id", (squadPlayers ?? []).map((sp) => sp.game_player_id));
  const statusById = new Map((statusRows ?? []).map((r) => [r.game_player_id, r]));

  const players = (squadPlayers ?? []).map((sp) => ({
    game_player_id: sp.game_player_id,
    full_name: sp.game_players.players.full_name,
    position: sp.game_players.players.position,
    team_name: sp.game_players.players.teams.name,
    price: sp.game_players.price,
    is_starting: sp.is_starting,
    score: scoreByGamePlayerId.get(sp.game_player_id) ?? null,
    lineup: statusById.get(sp.game_player_id)?.lineup ?? null,
    status: statusById.get(sp.game_player_id)?.status ?? null,
  }));

  const suggestion =
    horizonData && horizonData.length > 0
      ? suggestBestXI(
          players.map((p) => ({ game_player_id: p.game_player_id, position: p.position, score: p.score ?? 0 })),
          formations ?? []
        )
      : null;

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold text-white">
          {squad.name}: starting XI
        </h1>
        <p className="mt-1 text-sm text-navy-300">
          {game.display_name} · pick {rules.starting_size} of your {rules.squad_size}
        </p>

        <div className="mt-6">
          <LineupBuilder
            squadId={squad.id}
            startingSize={rules.starting_size}
            formations={formations ?? []}
            players={players}
            suggestion={suggestion}
          />
        </div>
      </main>
    </div>
  );
}
