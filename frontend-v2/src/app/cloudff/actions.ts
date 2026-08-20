"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming, getGameweekInfo } from "@/lib/gameweek";
import { getMatchDaysForSquad, ensureAutoPicks, fetchScoresForMatchDays } from "@/lib/matchDayCaptains";

// Matches the Captains page's own window (cloudff/captains/page.tsx) so a
// transfer's captain-coverage refill never looks at a narrower slice of
// the calendar than the page the user would otherwise visit by hand.
const CAPTAIN_REFILL_WINDOW_GAMEWEEKS = 3;
import { saveSquadGameweekLock } from "@/lib/gameweekHistory";
import { isLegalFormationPick, countByPosition, ELEVEN_A_SIDE_FORMATIONS, type SquadPosition } from "@/lib/squadFormation";

/**
 * A real like-for-like transfer (out one squad player, in one pool player
 * of the same position). Cloud FF's real transfer rules (50 transfers/
 * season total, one "Overhaul" window, no points cost at all) don't fit
 * this app's FanTeam-shaped cost/wildcard model and there's no schema
 * support for a season-total cap yet - building a partial or guessed
 * version would itself be inventing rules. This replicates "always free,
 * no cap" only, not the real 50/season+Overhaul model: only budget and
 * position legality are enforced, no club-limit check needed (Cloud FF's
 * game_squad_rules.max_per_club is null - no restriction), and
 * squad_transfers is always logged with cost_points: 0, used_wildcard:
 * false.
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

  const { data: squadPlayerRow } = await supabase
    .from("squad_players")
    .select("id, game_players(price, position_code)")
    .eq("squad_id", squadId)
    .eq("game_player_id", outGamePlayerId)
    .single<{ id: number; game_players: { price: number; position_code: string } }>();
  if (!squadPlayerRow) return { error: "That player isn't in your squad." };

  const { data: incoming } = await supabase
    .from("game_players")
    .select("id, price, is_active, position_code")
    .eq("id", inGamePlayerId)
    .single<{ id: number; price: number; is_active: boolean; position_code: string }>();
  if (!incoming || !incoming.is_active) return { error: "That player isn't available." };

  const { data: allSquadPlayers } = await supabase
    .from("squad_players")
    .select("game_player_id, game_players(price, position_code)")
    .eq("squad_id", squadId)
    .returns<{ game_player_id: number; game_players: { price: number; position_code: string } }[]>();
  // 2026-08-20 user report (same fix as Dream Team's makeTransfer): a
  // replacement was always required to match its outgoing player's OWN
  // position, blocking a swap that would still leave the squad on one of
  // Cloud FF's 7 real formations (identical shapes to Dream Team's - see
  // squadFormation.ts). isLegalFormationPick with totalOpenSlots=1 is
  // exactly "does this single swap still reach a real formation."
  const keptCounts = countByPosition(
    (allSquadPlayers ?? [])
      .filter((p) => p.game_player_id !== outGamePlayerId)
      .map((p) => ({ position: p.game_players.position_code as SquadPosition }))
  );
  if (!isLegalFormationPick(keptCounts, { GK: 0, DEF: 0, MID: 0, FWD: 0 }, incoming.position_code as SquadPosition, 1, ELEVEN_A_SIDE_FORMATIONS)) {
    return { error: "That swap would leave the squad off every real formation (needs exactly 1 GK plus a legal DEF/MID/FWD split, e.g. 4-4-2 or 3-5-2)." };
  }

  const teamValue = (allSquadPlayers ?? []).reduce((sum, p) => sum + Number(p.game_players.price), 0);
  const { data: rules } = await supabase.from("game_squad_rules").select("budget").eq("game_id", squad.game_id).single();
  const bank = Number(rules?.budget ?? 100) - teamValue;
  if (bank + Number(squadPlayerRow.game_players.price) - Number(incoming.price) < 0) {
    return { error: "Not enough budget for that transfer." };
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

  // Real user request 2026-08-18: Cloud FF transfers happen BETWEEN
  // match-days mid-gameweek (unlike the other 3 games, which lock once
  // their gameweek starts), so a captain pick made before this transfer
  // can now point at a player who just left the squad. Clear any
  // FUTURE match-day pick (past days are real history - a captain who
  // already played that day stays on record) that named the outgoing
  // player as captain or vice, then immediately refill using the same
  // auto-pick logic the Captains page uses, so the squad never sits with
  // a stale or genuinely-empty captain slot just because the user hasn't
  // opened that page since transferring.
  if (planningGameweek !== null) {
    const todayIso = new Date().toISOString().slice(0, 10);
    await supabase
      .from("squad_match_day_captains")
      .delete()
      .eq("squad_id", squadId)
      .gte("match_date", todayIso)
      .or(`captain_game_player_id.eq.${outGamePlayerId},vice_captain_game_player_id.eq.${outGamePlayerId}`);

    const matchDays = await getMatchDaysForSquad(
      supabase,
      squad.game_id,
      squadId,
      planningGameweek,
      planningGameweek + CAPTAIN_REFILL_WINDOW_GAMEWEEKS - 1
    );
    const scoresByGameweek = await fetchScoresForMatchDays(supabase, matchDays);
    await ensureAutoPicks(supabase, squadId, matchDays, scoresByGameweek);
  }

  revalidatePath("/cloudff");
  revalidatePath("/cloudff/captains");
  return { success: true };
}

/**
 * Cloud FF's real captain rule - one captain per calendar match-day, not
 * per gameweek (see migration 0083's docstring). Eligibility is "in the
 * squad AND has a real fixture kicking off that exact day" - reuses
 * getMatchDaysForSquad (lib/matchDayCaptains.ts) so this action and the
 * Captains page it's called from can never disagree about who's actually
 * eligible on a given day. No bench concept applies here (Cloud FF has
 * none), so unlike Dream Team/FanTeam's setCaptain there's no is_starting
 * check - every squad player already counts as "starting" for a no-bench
 * game.
 */
export async function setMatchDayCaptain({
  squadId,
  matchDate,
  captainGamePlayerId,
  viceCaptainGamePlayerId,
}: {
  squadId: number;
  matchDate: string;
  captainGamePlayerId: number;
  viceCaptainGamePlayerId: number | null;
}) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  if (viceCaptainGamePlayerId !== null && captainGamePlayerId === viceCaptainGamePlayerId) {
    return { error: "Captain and vice-captain must be different players." };
  }

  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { planningGameweek } = await getSeasonTiming(supabase, squad.game_id);
  const currentGameweek = planningGameweek ?? 1;
  // Wide enough to cover any real match_date a caller could legally pass
  // (the Captains page only ever renders days within its own planning
  // window) without needing the caller to also pass a gameweek.
  const matchDays = await getMatchDaysForSquad(supabase, squad.game_id, squadId, currentGameweek, currentGameweek + 10);
  const day = matchDays.find((d) => d.matchDate === matchDate);
  if (!day) return { error: "No real fixture found for this squad on that day." };

  const eligibleIds = new Set(day.eligiblePlayers.map((p) => p.gamePlayerId));
  if (!eligibleIds.has(captainGamePlayerId)) return { error: "That player doesn't have a fixture on this day." };
  if (viceCaptainGamePlayerId !== null && !eligibleIds.has(viceCaptainGamePlayerId)) {
    return { error: "That vice-captain doesn't have a fixture on this day." };
  }

  const { error } = await supabase.from("squad_match_day_captains").upsert(
    {
      squad_id: squadId,
      match_date: matchDate,
      captain_game_player_id: captainGamePlayerId,
      vice_captain_game_player_id: viceCaptainGamePlayerId,
      auto_picked: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "squad_id,match_date" }
  );
  if (error) return { error: error.message };

  revalidatePath("/cloudff/captains");
  return { success: true };
}

/**
 * Manual "Save Team" (real user request 2026-08-18, same pattern as
 * Dream Team/FanTeam's own saveTeamForGameweek) - locks in the squad's
 * CURRENT live player list as planningGameweek's official submission,
 * re-pressable right up until that gameweek's real deadline. Cloud FF has
 * no bench (every squad member always starts - is_starting true,
 * bench_order null) and no squad-level captain (match-day captains live
 * in squad_match_day_captains instead, a different table this
 * intentionally doesn't touch), so the snapshot's captain/vice/booster
 * fields are always null - only the player list is meaningful here.
 */
export async function saveTeamForGameweek({ squadId }: { squadId: number }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

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

  revalidatePath("/cloudff");
  return { success: true as const };
}
