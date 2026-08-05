"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { makeTransfer } from "../actions";

/**
 * Applies one gameweek step of Mary's plan by looping over the existing,
 * already-correct makeTransfer (Cloud FF's real economy: always free, no
 * club limit) - deliberately not re-deriving transfer execution here.
 *
 * If a later leg in a multi-transfer bundle fails, every leg already
 * applied is rolled back via revertTransfer below. Simpler than Dream
 * Team/FanTeam's equivalent: Cloud FF transfers never touch
 * free_transfers or a wildcard flag at all (see cloudff/actions.ts's
 * makeTransfer - only squad_players and a squad_transfers log row are
 * ever written), so reverting is just swapping the player back and
 * removing the log row - no state-restoration branch needed.
 */
export async function applyRecommendation({ squadId, legs }: { squadId: number; legs: { outGamePlayerId: number; inGamePlayerId: number }[] }) {
  const applied: { outGamePlayerId: number; inGamePlayerId: number }[] = [];

  for (const leg of legs) {
    const result = await makeTransfer({ squadId, outGamePlayerId: leg.outGamePlayerId, inGamePlayerId: leg.inGamePlayerId });
    if (result.error) {
      for (const done of applied.reverse()) {
        await revertTransfer(squadId, done.outGamePlayerId, done.inGamePlayerId);
      }
      return { error: `Only applied ${applied.length} of ${legs.length} transfers before hitting: ${result.error}. Rolled back.` };
    }
    applied.push(leg);
  }

  revalidatePath("/cloudff");
  revalidatePath("/cloudff/ask-mary");
  return { success: true };
}

/** Undoes one already-applied makeTransfer leg. */
async function revertTransfer(squadId: number, outGamePlayerId: number, inGamePlayerId: number) {
  const supabase = await createAuthServerClient();

  const { data: squadPlayerRow } = await supabase.from("squad_players").select("id").eq("squad_id", squadId).eq("game_player_id", inGamePlayerId).single();
  if (!squadPlayerRow) return;

  await supabase.from("squad_players").update({ game_player_id: outGamePlayerId }).eq("id", squadPlayerRow.id);

  // The rolled-back leg never really happened from the user's
  // perspective - remove the log entry so it doesn't survive as a real
  // squad_transfers row for Performance Lab to grade later. Looked up by
  // id (most recent match) rather than deleting directly off the filter,
  // since a real SQL DELETE has no ORDER BY/LIMIT of its own.
  const { data: transferRow } = await supabase
    .from("squad_transfers")
    .select("id")
    .eq("squad_id", squadId)
    .eq("out_game_player_id", outGamePlayerId)
    .eq("in_game_player_id", inGamePlayerId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (transferRow) {
    await supabase.from("squad_transfers").delete().eq("id", transferRow.id);
  }
}
