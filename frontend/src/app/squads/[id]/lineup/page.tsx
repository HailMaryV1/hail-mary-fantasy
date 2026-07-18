import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import LineupBuilder from "./LineupBuilder";

type SquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  game_players: {
    price: number;
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD"; teams: { name: string } };
  };
};

type Formation = { code: string; gk_count: number; def_count: number; mid_count: number; fwd_count: number };

/**
 * Best XI for one gameweek's scores: since every slot within a position is
 * interchangeable, taking the top `quota[pos]` scorers per position is
 * provably optimal for a fixed formation - no search needed. Comparing the
 * summed total across every formation (there are only 7) then finds the
 * best formation too.
 */
function suggestBestXI(
  players: { game_player_id: number; position: "GK" | "DEF" | "MID" | "FWD"; score: number }[],
  formations: Formation[]
) {
  const byPosition: Record<string, typeof players> = { GK: [], DEF: [], MID: [], FWD: [] };
  players.forEach((p) => byPosition[p.position].push(p));
  Object.values(byPosition).forEach((list) => list.sort((a, b) => b.score - a.score));

  let best: { formationCode: string; startingGamePlayerIds: number[]; total: number } | null = null;
  for (const f of formations) {
    const quota = { GK: f.gk_count, DEF: f.def_count, MID: f.mid_count, FWD: f.fwd_count };
    const picks: number[] = [];
    let total = 0;
    let feasible = true;
    for (const pos of ["GK", "DEF", "MID", "FWD"] as const) {
      const need = quota[pos];
      const available = byPosition[pos];
      if (available.length < need) {
        feasible = false;
        break;
      }
      for (let i = 0; i < need; i++) {
        picks.push(available[i].game_player_id);
        total += available[i].score;
      }
    }
    if (feasible && (best === null || total > best.total)) {
      best = { formationCode: f.code, startingGamePlayerIds: picks, total };
    }
  }
  return best;
}

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

  const players = (squadPlayers ?? []).map((sp) => ({
    game_player_id: sp.game_player_id,
    full_name: sp.game_players.players.full_name,
    position: sp.game_players.players.position,
    team_name: sp.game_players.players.teams.name,
    price: sp.game_players.price,
    is_starting: sp.is_starting,
    score: scoreByGamePlayerId.get(sp.game_player_id) ?? null,
  }));

  const suggestion =
    horizonData && horizonData.length > 0
      ? suggestBestXI(
          players.map((p) => ({ game_player_id: p.game_player_id, position: p.position, score: p.score ?? 0 })),
          formations ?? []
        )
      : null;

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black">
      <main className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          {squad.name}: starting XI
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
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
