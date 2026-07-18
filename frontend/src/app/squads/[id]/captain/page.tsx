import { notFound } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import CaptainPicker from "./CaptainPicker";

type SquadPlayerRow = {
  game_player_id: number;
  game_players: {
    price: number;
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD"; teams: { name: string } };
  };
};

export default async function CaptainPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const squadId = Number(id);
  if (!Number.isInteger(squadId)) notFound();

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: squad } = await supabase
    .from("squads")
    .select("id, name, user_id, captain_game_player_id, vice_captain_game_player_id, fantasy_games(slug, display_name)")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user?.id) notFound();

  const game = squad.fantasy_games as unknown as { slug: string; display_name: string };

  const { data: startersRaw } = await supabase
    .from("squad_players")
    .select("game_player_id, game_players(price, players(full_name, position, teams(name)))")
    .eq("squad_id", squadId)
    .eq("is_starting", true)
    .returns<SquadPlayerRow[]>();

  const { data: pool } = await supabase
    .from("game_player_pool")
    .select("game_player_id, hail_mary_score")
    .eq("game_slug", game.slug);
  const scoreById = new Map((pool ?? []).map((p) => [p.game_player_id, p.hail_mary_score]));

  const starters = (startersRaw ?? [])
    .map((sp) => ({
      game_player_id: sp.game_player_id,
      full_name: sp.game_players.players.full_name,
      position: sp.game_players.players.position,
      team_name: sp.game_players.players.teams.name,
      hail_mary_score: scoreById.get(sp.game_player_id) ?? 0,
    }))
    .sort((a, b) => b.hail_mary_score - a.hail_mary_score);

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold text-white">{squad.name}: captain</h1>
        <p className="mt-1 text-sm text-navy-300">
          {game.display_name} · captain scores double, ranked by Hail Mary Score
        </p>

        <div className="mt-6">
          <CaptainPicker
            squadId={squadId}
            starters={starters}
            currentCaptainId={squad.captain_game_player_id}
            currentViceCaptainId={squad.vice_captain_game_player_id}
          />
        </div>
      </main>
    </div>
  );
}
