"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { makeTransfer, makeClubTransfer } from "../actions";

/**
 * Applies one gameweek step of Mary's player plan by looping over the
 * existing, already-correct makeTransfer (EFL Fantasy's real economy:
 * always free, no budget, no club limit for players) - same pattern as
 * cloudff/ask-mary/actions.ts. If a later leg fails, every leg already
 * applied is rolled back via revertPlayerTransfer.
 */
export async function applyRecommendation({ squadId, legs }: { squadId: number; legs: { outGamePlayerId: number; inGamePlayerId: number }[] }) {
  const applied: { outGamePlayerId: number; inGamePlayerId: number }[] = [];

  for (const leg of legs) {
    const result = await makeTransfer({ squadId, outGamePlayerId: leg.outGamePlayerId, inGamePlayerId: leg.inGamePlayerId });
    if (result.error) {
      for (const done of applied.reverse()) {
        await revertPlayerTransfer(squadId, done.outGamePlayerId, done.inGamePlayerId);
      }
      return { error: `Only applied ${applied.length} of ${legs.length} transfers before hitting: ${result.error}. Rolled back.` };
    }
    applied.push(leg);
  }

  revalidatePath("/eflfantasy");
  revalidatePath("/eflfantasy/ask-mary");
  return { success: true };
}

/**
 * Applies Mary's club-pick recommendation the same way, via the existing
 * makeClubTransfer (which already re-checks the real season-long
 * cap-of-5 - see eflClubCapCheck.ts - so a club that got picked
 * elsewhere between analysis and apply is still safely rejected here).
 */
export async function applyClubRecommendation({ squadId, legs }: { squadId: number; legs: { outGamePlayerId: number; inGamePlayerId: number }[] }) {
  const applied: { outGamePlayerId: number; inGamePlayerId: number }[] = [];

  for (const leg of legs) {
    const result = await makeClubTransfer({ squadId, outGamePlayerId: leg.outGamePlayerId, inGamePlayerId: leg.inGamePlayerId });
    if (result.error) {
      for (const done of applied.reverse()) {
        await revertPlayerTransfer(squadId, done.outGamePlayerId, done.inGamePlayerId);
      }
      return { error: `Only applied ${applied.length} of ${legs.length} club transfers before hitting: ${result.error}. Rolled back.` };
    }
    applied.push(leg);
  }

  revalidatePath("/eflfantasy");
  revalidatePath("/eflfantasy/ask-mary");
  return { success: true };
}

/** Undoes one already-applied makeTransfer/makeClubTransfer leg - the underlying squad_players row swap is identical for both. */
async function revertPlayerTransfer(squadId: number, outGamePlayerId: number, inGamePlayerId: number) {
  const supabase = await createAuthServerClient();

  const { data: squadPlayerRow } = await supabase.from("squad_players").select("id").eq("squad_id", squadId).eq("game_player_id", inGamePlayerId).single();
  if (!squadPlayerRow) return;

  await supabase.from("squad_players").update({ game_player_id: outGamePlayerId }).eq("id", squadPlayerRow.id);

  // The rolled-back leg never really happened from the user's
  // perspective - remove the log entry so it doesn't survive as a real
  // squad_transfers row for Performance Lab to grade later.
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
