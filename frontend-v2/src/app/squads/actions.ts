"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

type Booster = "goal_bonus" | "twelfth_man" | "max_captain";

/**
 * Sets (or clears) this gameweek's active Booster. Deliberately does NOT
 * lock a used booster into *_used_gameweek yet - Dream Team's real rule
 * allows changing your pick up until the gameweek deadline, and locking
 * that in needs a real "a new gameweek has started" trigger that doesn't
 * exist yet (same known gap as the old frontend's free-transfer accrual,
 * see migration 0022's docstring) - not invented here.
 */
export async function setBooster({ squadId, booster, gameweek }: { squadId: number; booster: Booster | null; gameweek: number }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: squad } = await supabase
    .from("squads")
    .select("id, user_id, goal_bonus_used_gameweek, twelfth_man_used_gameweek, max_captain_used_gameweek")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  if (booster) {
    const usedGameweekByBooster: Record<Booster, number | null> = {
      goal_bonus: squad.goal_bonus_used_gameweek,
      twelfth_man: squad.twelfth_man_used_gameweek,
      max_captain: squad.max_captain_used_gameweek,
    };
    if (usedGameweekByBooster[booster] != null) {
      return { error: "That Booster has already been used this season." };
    }
  }

  const { error } = await supabase
    .from("squads")
    .update({ active_booster: booster, active_booster_gameweek: booster ? gameweek : null })
    .eq("id", squadId);
  if (error) return { error: error.message };

  revalidatePath(`/squads/${squadId}`);
  return { success: true };
}

/**
 * Records a real Substitute use (1.2.5.9) - up to 10 per season, one per
 * gameweek, and never in a gameweek where a Booster is active. The
 * append-only squad_substitutions log IS the season-to-date counter
 * (count of rows), same pattern as squad_transfers.
 */
export async function recordSubstitute({
  squadId,
  gameweek,
  outGamePlayerId,
  inGamePlayerId,
}: {
  squadId: number;
  gameweek: number;
  outGamePlayerId: number;
  inGamePlayerId: number;
}) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: squad } = await supabase
    .from("squads")
    .select("id, user_id, active_booster, active_booster_gameweek")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  if (squad.active_booster && squad.active_booster_gameweek === gameweek) {
    return { error: "You can't use a Substitute in a gameweek where you've activated a Booster." };
  }

  const { count: usedThisGameweek } = await supabase
    .from("squad_substitutions")
    .select("id", { count: "exact", head: true })
    .eq("squad_id", squadId)
    .eq("gameweek", gameweek);
  if ((usedThisGameweek ?? 0) > 0) return { error: "You've already used your Substitute for this gameweek." };

  const { count: usedThisSeason } = await supabase
    .from("squad_substitutions")
    .select("id", { count: "exact", head: true })
    .eq("squad_id", squadId);
  if ((usedThisSeason ?? 0) >= 10) return { error: "You've used all 10 Substitutes for this season." };

  const { error } = await supabase
    .from("squad_substitutions")
    .insert({ squad_id: squadId, gameweek, out_game_player_id: outGamePlayerId, in_game_player_id: inGamePlayerId });
  if (error) return { error: error.message };

  revalidatePath(`/squads/${squadId}`);
  return { success: true };
}
