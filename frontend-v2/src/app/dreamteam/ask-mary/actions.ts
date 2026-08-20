"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import type { SquadPosition } from "@/lib/squadFormation";
import { makeTransfer } from "../actions";

/**
 * Applies one gameweek step of Mary's plan by looping over the existing,
 * already-correct makeTransfer (real Dream Team economy: hard 2/gameweek
 * cap, no points-hit, no wildcard) - deliberately not re-deriving
 * transfer execution here.
 *
 * A "paired" bundle (see dreamteamAskMaryEngine.ts's findBestPairBundle)
 * is validated as budget-POOLED - e.g. sell A + sell B jointly funds
 * buy A' + buy B', even if buy A' alone would overspend before B is
 * sold. makeTransfer only ever sees one leg at a time though, so legs
 * are executed cash-freeing-first (ascending net price delta) rather
 * than in the engine's display/pairing order - a classic bank-balance-
 * sequencing result: if any execution order keeps the running bank
 * non-negative throughout, sorting ascending by delta is guaranteed to
 * be one (it minimizes every prefix sum simultaneously). Previously
 * this looped in display order, so a bundle Mary had already confirmed
 * was affordable in aggregate could still fail on leg 1 and roll back
 * to 0 applied, purely because the funding sale hadn't landed yet.
 *
 * If a later leg in a multi-transfer bundle fails, every leg already
 * applied is rolled back via revertTransfer below rather than a second
 * makeTransfer call in reverse - reversing through makeTransfer would
 * itself consume another free transfer per leg (and could hit the very
 * cap the rollback exists to recover from, since a failed 3rd leg often
 * means free_transfers just hit 0). A revert isn't a new transfer the
 * user is spending, it's undoing one that shouldn't have gone through.
 *
 * Real user report 2026-08-21: selling a MID and a DEF, then buying a
 * FWD, silently rolled back the WHOLE bundle even though the client had
 * already validated that exact combination as a legal formation. Root
 * cause: makeTransfer's own formation check only ever saw ITS OWN leg,
 * against a squad that STILL had the other outgoing player in it (not
 * sold yet) - a real final formation could look temporarily illegal
 * purely from sequencing. Each call below now passes batchLegs (every
 * OTHER leg in this bundle) so makeTransfer validates against the SAME
 * full shared-pot picture the client already confirmed was legal,
 * instead of a misleading partial one.
 */
export async function applyRecommendation({
  squadId,
  legs,
}: {
  squadId: number;
  legs: { outGamePlayerId: number; inGamePlayerId: number; outPrice: number; inPrice: number; inPosition: SquadPosition }[];
}) {
  // Real user report 2026-08-21: a 2-leg bundle with only 1 free transfer
  // left partially applied (leg 1 spent the last transfer) then rolled
  // back entirely once leg 2 hit the cap - the user saw the failed
  // attempt on the pitch with no clear explanation of why it didn't
  // stick. Dream Team's real rule is a hard cap with no points-hit
  // option (see makeTransfer's own docstring) - a bundle that needs more
  // transfers than are currently available should never be allowed to
  // start, not fail partway through and unwind.
  const supabase = await createAuthServerClient();
  const { data: squad } = await supabase.from("squads").select("game_id, free_transfers").eq("id", squadId).single();
  if (squad) {
    const { seasonStarted } = await getSeasonTiming(supabase, squad.game_id);
    if (seasonStarted && legs.length > squad.free_transfers) {
      return {
        error: `Only ${squad.free_transfers} free transfer${squad.free_transfers === 1 ? "" : "s"} left this gameweek - can't apply a ${legs.length}-transfer bundle. Dream Team has a hard cap, no points-hit option.`,
      };
    }
  }

  const applied: { outGamePlayerId: number; inGamePlayerId: number }[] = [];
  const orderedLegs = legs.slice().sort((a, b) => a.inPrice - a.outPrice - (b.inPrice - b.outPrice));

  for (const leg of orderedLegs) {
    const batchLegs = legs.filter((l) => l.outGamePlayerId !== leg.outGamePlayerId).map((l) => ({ outGamePlayerId: l.outGamePlayerId, inPosition: l.inPosition }));
    const result = await makeTransfer({ squadId, outGamePlayerId: leg.outGamePlayerId, inGamePlayerId: leg.inGamePlayerId, batchLegs });
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
