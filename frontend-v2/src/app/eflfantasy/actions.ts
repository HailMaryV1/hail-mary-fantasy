"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { getClubPickCounts, CLUB_CAP } from "@/lib/eflClubCapCheck";
import { isLegalPositionSwap, type OutfieldPosition, type SquadPosition } from "@/lib/eflFormation";

/**
 * EFL Fantasy's real transfer rules aren't published anywhere in the
 * public API (unlike its scoring/squad shape, which are - see migration
 * 0089's docstring) - deliberately not guessed. This mirrors Cloud FF's
 * own honest scope cut (see cloudff/actions.ts's docstring): always
 * free, no cap, no budget check at all (this game has none - see
 * migration 0089), no club-limit check for PLAYER transfers (only the
 * CLUB picks themselves have a cap, handled separately below).
 *
 * A replacement no longer has to be the same position (2026-08-10 fix) -
 * fantasy.efl.com's own team-builder actually offers 3 real formations
 * (2-2-2/2-3-1/3-2-1, see eflFormation.ts's docstring), so a DEF-for-FWD
 * (etc) swap is legal as long as the resulting squad still matches one
 * of those 3 shapes. GK is never part of formation and can only swap for GK.
 */
export async function makeTransfer({
  squadId,
  outGamePlayerId,
  inGamePlayerId,
}: {
  squadId: number;
  outGamePlayerId: number;
  inGamePlayerId: number;
}) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: squadPlayerRows } = await supabase
    .from("squad_players")
    .select("id, game_player_id, game_players(position_code)")
    .eq("squad_id", squadId)
    .returns<{ id: number; game_player_id: number; game_players: { position_code: string } }[]>();
  const squadPlayerRow = squadPlayerRows?.find((r) => r.game_player_id === outGamePlayerId);
  if (!squadPlayerRow) return { error: "That player isn't in your squad." };

  const { data: incoming } = await supabase
    .from("game_players")
    .select("id, is_active, position_code")
    .eq("id", inGamePlayerId)
    .single<{ id: number; is_active: boolean; position_code: string }>();
  if (!incoming || !incoming.is_active) return { error: "That player isn't available." };
  if (incoming.position_code === "CLUB") return { error: "Use the club transfer flow for CLUB picks." };

  // EFL Fantasy's OWN classification (position_code), not the shared
  // players.position which can genuinely disagree between games (2026-08-08 fix).
  const outfieldCounts: Partial<Record<OutfieldPosition, number>> = {};
  for (const row of squadPlayerRows ?? []) {
    const pos = row.game_players.position_code;
    if (pos === "DEF" || pos === "MID" || pos === "FWD") outfieldCounts[pos] = (outfieldCounts[pos] ?? 0) + 1;
  }
  const outPos = squadPlayerRow.game_players.position_code as SquadPosition;
  const inPos = incoming.position_code as SquadPosition;
  if (!isLegalPositionSwap(outPos, inPos, outfieldCounts)) {
    return { error: "That swap would leave an invalid formation - must stay 2-2-2, 2-3-1, or 3-2-1." };
  }

  const { error: updateError } = await supabase.from("squad_players").update({ game_player_id: inGamePlayerId }).eq("id", squadPlayerRow.id);
  if (updateError) return { error: updateError.message };

  const { planningGameweek } = await getSeasonTiming(supabase, squad.game_id);
  await supabase.from("squad_transfers").insert({
    squad_id: squadId,
    gameweek: planningGameweek ?? 1,
    out_game_player_id: outGamePlayerId,
    in_game_player_id: inGamePlayerId,
    cost_points: 0,
    used_wildcard: false,
  });

  revalidatePath("/eflfantasy");
  return { success: true };
}

/**
 * Same shape as makeTransfer above, but for the 2 CLUB picks (see
 * migration 0087's docstring) - both sides must be position='CLUB', and
 * the incoming club is checked against the real season-long cap-of-5
 * (see eflClubCapCheck.ts's docstring for why this is advisory only,
 * derived from squad_gameweek_locks, not a live server-side enforcement
 * the way the real site's own auto-swap is).
 */
export async function makeClubTransfer({
  squadId,
  outGamePlayerId,
  inGamePlayerId,
}: {
  squadId: number;
  outGamePlayerId: number;
  inGamePlayerId: number;
}) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: squadPlayerRow } = await supabase
    .from("squad_players")
    .select("id, game_players(position_code)")
    .eq("squad_id", squadId)
    .eq("game_player_id", outGamePlayerId)
    .single<{ id: number; game_players: { position_code: string } }>();
  if (!squadPlayerRow || squadPlayerRow.game_players.position_code !== "CLUB") {
    return { error: "That club isn't in your squad." };
  }

  const { data: incoming } = await supabase
    .from("game_players")
    .select("id, is_active, position_code")
    .eq("id", inGamePlayerId)
    .single<{ id: number; is_active: boolean; position_code: string }>();
  if (!incoming || !incoming.is_active || incoming.position_code !== "CLUB") {
    return { error: "That club isn't available." };
  }

  const pickCounts = await getClubPickCounts(supabase, squadId);
  if ((pickCounts.get(inGamePlayerId) ?? 0) >= CLUB_CAP) {
    return { error: `That club has already been picked ${CLUB_CAP} times this season - the real site would auto-swap it out.` };
  }

  const { error: updateError } = await supabase.from("squad_players").update({ game_player_id: inGamePlayerId }).eq("id", squadPlayerRow.id);
  if (updateError) return { error: updateError.message };

  const { planningGameweek } = await getSeasonTiming(supabase, squad.game_id);
  await supabase.from("squad_transfers").insert({
    squad_id: squadId,
    gameweek: planningGameweek ?? 1,
    out_game_player_id: outGamePlayerId,
    in_game_player_id: inGamePlayerId,
    cost_points: 0,
    used_wildcard: false,
  });

  revalidatePath("/eflfantasy");
  return { success: true };
}
