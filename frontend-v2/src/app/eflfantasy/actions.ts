"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming, getGameweekInfo } from "@/lib/gameweek";
import { getClubPickCounts, CLUB_CAP } from "@/lib/eflClubCapCheck";
import { isLegalPositionSwap, type OutfieldPosition, type SquadPosition } from "@/lib/eflFormation";
import { saveSquadGameweekLock } from "@/lib/gameweekHistory";

type ReservePosition = OutfieldPosition;

async function getOwnedSquad(supabase: Awaited<ReturnType<typeof createAuthServerClient>>, squadId: number, userId: string) {
  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
  return squad && squad.user_id === userId ? squad : null;
}

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

/**
 * The user's own researched backup shortlist per position (2026-08-11
 * request, see migration 0116's docstring) - EFL Fantasy has no bench, so
 * this is the only fallback when a starter picks up last-minute bad news.
 * Reorders/adds/removes all funnel through this one function: the client
 * always sends the position's FULL desired order, and the whole list is
 * replaced (delete + reinsert with sequential ranks) rather than patching
 * individual rows - simplest way to keep ranks contiguous without a live
 * uniqueness constraint fighting a multi-row reorder.
 */
export async function setReservesForPosition({
  squadId,
  position,
  gamePlayerIds,
}: {
  squadId: number;
  position: ReservePosition;
  gamePlayerIds: number[];
}) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!(await getOwnedSquad(supabase, squadId, user.id))) return { error: "Squad not found." };

  const { error: deleteError } = await supabase.from("squad_reserve_picks").delete().eq("squad_id", squadId).eq("position", position);
  if (deleteError) return { error: deleteError.message };

  if (gamePlayerIds.length > 0) {
    const { error: insertError } = await supabase.from("squad_reserve_picks").insert(
      gamePlayerIds.map((gamePlayerId, i) => ({
        squad_id: squadId,
        position,
        game_player_id: gamePlayerId,
        rank: i + 1,
      }))
    );
    if (insertError) return { error: insertError.message };
  }

  revalidatePath("/eflfantasy");
  return { success: true };
}

/** Appends one player to the end of their position's reserve list -
 * the "Add as Reserve" pool row action's convenience wrapper around
 * setReservesForPosition above. */
export async function addReserve({ squadId, position, gamePlayerId }: { squadId: number; position: ReservePosition; gamePlayerId: number }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!(await getOwnedSquad(supabase, squadId, user.id))) return { error: "Squad not found." };

  const { data: existing } = await supabase
    .from("squad_reserve_picks")
    .select("game_player_id")
    .eq("squad_id", squadId)
    .eq("position", position)
    .order("rank");
  const ids = (existing ?? []).map((r) => r.game_player_id);
  if (ids.includes(gamePlayerId)) return { error: "Already on your reserve list." };

  return setReservesForPosition({ squadId, position, gamePlayerIds: [...ids, gamePlayerId] });
}

/** Drops one player from their position's reserve list - used both for a
 * manual "Remove" click and to clean up automatically once a reserve gets
 * promoted into the starting squad (see the client's swap-in handler,
 * which calls this right after makeTransfer succeeds). */
export async function removeReserve({ squadId, position, gamePlayerId }: { squadId: number; position: ReservePosition; gamePlayerId: number }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!(await getOwnedSquad(supabase, squadId, user.id))) return { error: "Squad not found." };

  const { error } = await supabase
    .from("squad_reserve_picks")
    .delete()
    .eq("squad_id", squadId)
    .eq("position", position)
    .eq("game_player_id", gamePlayerId);
  if (error) return { error: error.message };

  revalidatePath("/eflfantasy");
  return { success: true };
}

/**
 * Real user request 2026-08-19: "we need the save team button too so it
 * locks the players in and records their score so we can track my team
 * and the decisions" - the same saveSquadGameweekLock mechanism Dream
 * Team/FanTeam/Cloud FF already have (see cloudff/actions.ts's own
 * saveTeamForGameweek), just never wired into EFL Fantasy's board when it
 * was built. Locks in the squad's CURRENT live player list (including
 * CLUB picks - squad_players covers both) as planningGameweek's official
 * submission, re-pressable right up until that gameweek's real deadline.
 * EFL Fantasy has no bench and no squad-level captain (every squad member
 * always starts; match-day-equivalent captaincy isn't a real mechanic
 * here per migration 0089's docstring), so - identically to Cloud FF -
 * only the player list is meaningful; captain/vice/booster are always
 * null. Reserves (squad_reserve_picks) are a separate research list, not
 * part of the live team, so deliberately excluded from the snapshot.
 */
export async function saveTeamForGameweek({ squadId }: { squadId: number }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const squad = await getOwnedSquad(supabase, squadId, user.id);
  if (!squad) return { error: "Squad not found." };

  const { data: squadPlayers } = await supabase.from("squad_players").select("game_player_id").eq("squad_id", squadId);
  if (!squadPlayers || squadPlayers.length === 0) return { error: "Your squad is empty - nothing to save." };

  const gwInfo = await getGameweekInfo(supabase, squad.game_id);
  if (gwInfo.planningGameweek == null) return { error: "No upcoming gameweek to save a team for yet." };
  const deadline = gwInfo.gameweeks.find((g) => g.gameweek === gwInfo.planningGameweek)?.deadline ?? null;

  const result = await saveSquadGameweekLock(supabase, squadId, gwInfo.planningGameweek, deadline, {
    players: squadPlayers.map((p) => ({ game_player_id: p.game_player_id, is_starting: true, bench_order: null })),
    captainGamePlayerId: null,
    viceCaptainGamePlayerId: null,
    activeBooster: null,
  });
  if ("error" in result) return result;

  revalidatePath("/eflfantasy");
  return { success: true as const };
}
