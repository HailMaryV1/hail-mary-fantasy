"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { GOLF_SQUAD_SIZE } from "@/lib/golfTeamOptimizer";

/**
 * Golf squads need no starting/bench split (squad_size === starting_size,
 * every pick counts - see migration 0045's game_squad_rules row) so this
 * is simpler than football's saveSquad (squads/actions.ts) - no formation,
 * no computeStartingSplit, just re-validate budget/size server-side (the
 * client-side optimiser already enforces both live, but a server action
 * is a trust boundary, same principle saveSquad already follows) and
 * insert.
 */
export async function saveGolfTeam({
  golfTournamentId,
  name,
  gamePlayerIds,
  captainGamePlayerId,
}: {
  golfTournamentId: number;
  name: string;
  gamePlayerIds: number[];
  captainGamePlayerId: number;
}) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (gamePlayerIds.length !== GOLF_SQUAD_SIZE) {
    return { error: `A team needs exactly ${GOLF_SQUAD_SIZE} golfers.` };
  }
  if (!gamePlayerIds.includes(captainGamePlayerId)) {
    return { error: "Captain must be one of the selected golfers." };
  }

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam-golf").single();
  if (!game) return { error: "FanTeam Golf game not found." };

  const { data: rules } = await supabase.from("game_squad_rules").select("budget").eq("game_id", game.id).single();
  if (!rules) return { error: "Golf squad rules not found - run migration 0045." };

  const { data: entries } = await supabase
    .from("golf_tournament_entries")
    .select("game_player_id, price")
    .eq("tournament_id", golfTournamentId)
    .in("game_player_id", gamePlayerIds);
  if (!entries || entries.length !== gamePlayerIds.length) {
    return { error: "One or more selected golfers aren't in this tournament's pool." };
  }
  // Rounded to the real £0.1m price granularity before comparing - plain
  // floating-point summation of decimals like 14.6 + 15.8 + ... can land
  // on 100.00000000000001 instead of exactly 100 (IEEE 754 can't represent
  // most decimal fractions exactly), which made a team costing precisely
  // the full budget get rejected as "over budget" by a fraction of a penny.
  const totalPrice = Math.round(entries.reduce((sum, e) => sum + Number(e.price), 0) * 100) / 100;
  if (totalPrice > Number(rules.budget)) {
    return { error: `Team costs £${totalPrice.toFixed(1)}m, over the £${Number(rules.budget).toFixed(1)}m budget.` };
  }

  const { data: squad, error: squadError } = await supabase
    .from("squads")
    .insert({
      user_id: user.id,
      game_id: game.id,
      golf_tournament_id: golfTournamentId,
      golf_captain_game_player_id: captainGamePlayerId,
      name: name.trim() || "My Team",
    })
    .select("id")
    .single();
  if (squadError || !squad) return { error: squadError?.message ?? "Failed to create team." };

  const { error: playersError } = await supabase
    .from("squad_players")
    .insert(gamePlayerIds.map((id) => ({ squad_id: squad.id, game_player_id: id })));
  if (playersError) return { error: playersError.message };

  revalidatePath("/golf/team");
  return { squadId: squad.id as number };
}

export async function deleteGolfTeam(squadId: number) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("squads").delete().eq("id", squadId).eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/golf/team");
  return { ok: true };
}
