"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { makeFanteamTransfer } from "../../actions";

/**
 * Applies one gameweek step of Mary's plan by looping over the existing,
 * already-correct makeFanteamTransfer (real FanTeam economy: budget/
 * club-limit/position validation, free-transfer/-4pt hit/wildcard cost) -
 * deliberately not re-deriving transfer execution here. Always passes
 * useWildcard: false - traced through makeFanteamTransfer's own logic:
 * it self-detects an already-active wildcard from real
 * squad.wildcard_1/2_used_gameweek state regardless of the caller's
 * flag, and Ask Mary's own search only ever accounts for a wildcard
 * that's ALREADY active, it never recommends turning one on.
 *
 * If a later leg in a multi-transfer bundle fails, every leg already
 * applied is rolled back via revertFanteamTransfer below rather than a
 * second makeFanteamTransfer call in reverse - reversing through
 * makeFanteamTransfer would itself consume another free transfer or -4pt
 * hit per leg (and could hit the very budget/club-limit constraint the
 * rollback exists to recover from). A revert isn't a new transfer the
 * user is spending, it's undoing one that shouldn't have gone through.
 */
export async function applyRecommendation({ squadId, legs }: { squadId: number; legs: { outGamePlayerId: number; inGamePlayerId: number }[] }) {
  const applied: { outGamePlayerId: number; inGamePlayerId: number }[] = [];

  for (const leg of legs) {
    const result = await makeFanteamTransfer({ squadId, outGamePlayerId: leg.outGamePlayerId, inGamePlayerId: leg.inGamePlayerId, useWildcard: false });
    if (result.error) {
      for (const done of applied.reverse()) {
        await revertFanteamTransfer(squadId, done.outGamePlayerId, done.inGamePlayerId);
      }
      return { error: `Only applied ${applied.length} of ${legs.length} transfers before hitting: ${result.error}. Rolled back.` };
    }
    applied.push(leg);
  }

  revalidatePath(`/fanteam/${squadId}`);
  revalidatePath(`/fanteam/${squadId}/ask-mary`);
  return { success: true };
}

/**
 * Undoes one already-applied makeFanteamTransfer leg - see
 * applyRecommendation above for why this isn't just makeFanteamTransfer
 * called in reverse. Looks up the real squad_transfers row the forward
 * call wrote (for its actual cost_points/used_wildcard - a real hit or a
 * wildcard-covered leg touches free_transfers differently than an
 * ordinary free-transfer spend), swaps the squad_players row back, and
 * restores free_transfers by 1 ONLY if that leg genuinely consumed one
 * (cost_points = 0 and used_wildcard = false - a -4pt hit or a
 * wildcard-covered leg never touched free_transfers in the first place).
 */
async function revertFanteamTransfer(squadId: number, outGamePlayerId: number, inGamePlayerId: number) {
  const supabase = await createAuthServerClient();

  const { data: transferRow } = await supabase
    .from("squad_transfers")
    .select("id, cost_points, used_wildcard")
    .eq("squad_id", squadId)
    .eq("out_game_player_id", outGamePlayerId)
    .eq("in_game_player_id", inGamePlayerId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!transferRow) return;

  const { data: squadPlayerRow } = await supabase.from("squad_players").select("id").eq("squad_id", squadId).eq("game_player_id", inGamePlayerId).single();
  if (!squadPlayerRow) return;

  await supabase.from("squad_players").update({ game_player_id: outGamePlayerId }).eq("id", squadPlayerRow.id);

  const consumedFreeTransfer = Number(transferRow.cost_points) === 0 && !transferRow.used_wildcard;
  if (consumedFreeTransfer) {
    const { data: squad } = await supabase.from("squads").select("free_transfers").eq("id", squadId).single();
    if (squad) {
      await supabase
        .from("squads")
        .update({ free_transfers: squad.free_transfers + 1 })
        .eq("id", squadId);
    }
  }

  // The rolled-back leg never really happened from the user's
  // perspective - remove the log entry so it doesn't survive as a real
  // squad_transfers row for Performance Lab to grade later.
  await supabase.from("squad_transfers").delete().eq("id", transferRow.id);
}
