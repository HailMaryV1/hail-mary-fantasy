"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { makeTransfer } from "../actions";

/**
 * Applies one gameweek step of Mary's plan by looping over the existing,
 * already-correct makeTransfer (real Dream Team economy: hard 2/gameweek
 * cap, no points-hit, no wildcard) - deliberately not re-deriving
 * transfer execution here.
 *
 * If a later leg in a multi-transfer bundle fails, every leg already
 * applied is rolled back via revertTransfer below rather than a second
 * makeTransfer call in reverse - reversing through makeTransfer would
 * itself consume another free transfer per leg (and could hit the very
 * cap the rollback exists to recover from, since a failed 3rd leg often
 * means free_transfers just hit 0). A revert isn't a new transfer the
 * user is spending, it's undoing one that shouldn't have gone through.
 */
export async function applyRecommendation({ squadId, legs }: { squadId: number; legs: { outGamePlayerId: number; inGamePlayerId: number }[] }) {
  const applied: { outGamePlayerId: number; inGamePlayerId: number }[] = [];

  for (const leg of legs) {
    const result = await makeTransfer({ squadId, outGamePlayerId: leg.outGamePlayerId, inGamePlayerId: leg.inGamePlayerId });
    if (result.error) {
      for (const done of applied.reverse()) {
        await revertTransfer({ squadId, outGamePlayerId: done.outGamePlayerId, inGamePlayerId: done.inGamePlayerId });
      }
      return { error: `Only applied ${applied.length} of ${legs.length} transfers before hitting: ${result.error}. Rolled back.` };
    }
    applied.push(leg);
  }

  revalidatePath("/dreamteam");
  revalidatePath("/dreamteam/ask-mary");
  return { success: true };
}

/** Undoes one already-applied makeTransfer leg - see applyRecommendation above for why this isn't just makeTransfer called in reverse. */
async function revertTransfer({ squadId, outGamePlayerId, inGamePlayerId }: { squadId: number; outGamePlayerId: number; inGamePlayerId: number }) {
  const supabase = await createAuthServerClient();

  const { data: squad } = await supabase.from("squads").select("id, game_id, free_transfers").eq("id", squadId).single();
  if (!squad) return;

  const { data: squadPlayerRow } = await supabase.from("squad_players").select("id").eq("squad_id", squadId).eq("game_player_id", inGamePlayerId).single();
  if (!squadPlayerRow) return;

  await supabase.from("squad_players").update({ game_player_id: outGamePlayerId }).eq("id", squadPlayerRow.id);

  const { seasonStarted, planningGameweek } = await getSeasonTiming(supabase, squad.game_id);
  if (seasonStarted) {
    await supabase
      .from("squads")
      .update({ free_transfers: squad.free_transfers + 1 })
      .eq("id", squadId);
  }

  // Removes the log entry the reverted makeTransfer call wrote - the
  // rolled-back leg never really happened from the user's perspective,
  // so it shouldn't survive as a real squad_transfers row for
  // Performance Lab to grade later.
  await supabase
    .from("squad_transfers")
    .delete()
    .eq("squad_id", squadId)
    .eq("gameweek", planningGameweek ?? 1)
    .eq("out_game_player_id", outGamePlayerId)
    .eq("in_game_player_id", inGamePlayerId);
}
