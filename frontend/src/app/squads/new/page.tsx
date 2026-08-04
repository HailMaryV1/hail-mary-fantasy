import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import SquadBuilder from "./SquadBuilder";
import NflSquadBuilder from "./NflSquadBuilder";

export default async function NewSquadPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string; squad?: string }>;
}) {
  const { game: gameSlug, squad: squadParam } = await searchParams;
  // Cloud FF is deliberately NOT offered as a creation option anywhere in
  // the UI (real rule: "You can create one team only," and the real team
  // already exists via provider sync - a create button here would risk a
  // second, confusing, non-synced squad). It's allowed through this gate
  // only so the "Edit squad" link on the synced squad's own card
  // (/squads/new?game=cloudff&squad=23) works instead of dead-ending.
  if (gameSlug !== "dreamteam" && gameSlug !== "fanteam" && gameSlug !== "nfl-fanteam" && gameSlug !== "cloudff") redirect("/squads");

  const supabase = await createAuthServerClient();

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", gameSlug).single();
  if (!game) redirect("/squads");

  // Editing an existing squad reuses this same builder rather than a
  // separate page - "auto-fill best XI" / "clear squad" are exactly as
  // useful for reworking a saved squad as for building a new one.
  let editingSquadId: number | undefined;
  let initialName: string | undefined;
  let initialSelected: number[] | undefined;
  if (squadParam) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: existingSquad } = await supabase
      .from("squads")
      .select("id, name, user_id")
      .eq("id", Number(squadParam))
      .single();
    if (existingSquad && user && existingSquad.user_id === user.id) {
      editingSquadId = existingSquad.id;
      initialName = existingSquad.name;
      const { data: squadPlayers } = await supabase
        .from("squad_players")
        .select("game_player_id")
        .eq("squad_id", existingSquad.id);
      initialSelected = (squadPlayers ?? []).map((p) => p.game_player_id);
    }
  }

  const { data: rules } = await supabase.from("game_squad_rules").select("*").eq("game_id", game.id).single();
  if (!rules) {
    return (
      <div className="min-h-screen bg-navy-950 p-10 text-sm text-red-400">
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
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold text-white">
          {editingSquadId ? `Edit ${initialName}` : `Build your ${game.display_name} squad`}
        </h1>
        <p className="mt-1 text-sm text-navy-300">
          £{Number(rules.budget).toFixed(0)}m budget · {rules.squad_size} players
          {rules.max_per_club ? ` · max ${rules.max_per_club} per club` : ""}
        </p>

        <div className="mt-6">
          {gameSlug === "nfl-fanteam" ? (
            <NflSquadBuilder
              rules={rules}
              players={players ?? []}
              editingSquadId={editingSquadId}
              initialName={initialName}
              initialSelected={initialSelected}
            />
          ) : (
            <SquadBuilder
              gameSlug={gameSlug}
              rules={rules}
              formations={formations ?? []}
              players={players ?? []}
              editingSquadId={editingSquadId}
              initialName={initialName}
              initialSelected={initialSelected}
            />
          )}
        </div>
      </main>
    </div>
  );
}
