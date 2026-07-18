import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import SquadBuilder from "./SquadBuilder";

export default async function NewSquadPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string }>;
}) {
  const { game: gameSlug } = await searchParams;
  if (gameSlug !== "dreamteam" && gameSlug !== "fanteam") redirect("/squads");

  const supabase = await createAuthServerClient();

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", gameSlug).single();
  if (!game) redirect("/squads");

  const { data: rules } = await supabase.from("game_squad_rules").select("*").eq("game_id", game.id).single();
  if (!rules) {
    return (
      <div className="p-10 text-sm text-red-600">
        No squad rules configured for {game.display_name} yet.
      </div>
    );
  }

  const { data: formations } = await supabase
    .from("game_formations")
    .select("code, gk_count, def_count, mid_count, fwd_count")
    .eq("game_id", game.id)
    .order("code");

  const { data: players } = await supabase
    .from("game_player_pool")
    .select("*")
    .eq("game_slug", gameSlug)
    .limit(1000);

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black">
      <main className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Build your {game.display_name} squad
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          £{Number(rules.budget).toFixed(0)}m budget · {rules.squad_size} players
          {rules.max_per_club ? ` · max ${rules.max_per_club} per club` : ""}
        </p>

        <div className="mt-6">
          <SquadBuilder
            gameSlug={gameSlug}
            rules={rules}
            formations={formations ?? []}
            players={players ?? []}
          />
        </div>
      </main>
    </div>
  );
}
