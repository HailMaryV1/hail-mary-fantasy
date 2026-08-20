"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming, getGameweekInfo } from "@/lib/gameweek";
import { saveSquadGameweekLock } from "@/lib/gameweekHistory";
import { isLegalFormationPick, countByPosition, DREAMTEAM_FORMATIONS, type SquadPosition } from "@/lib/squadFormation";

type Booster = "goal_bonus" | "twelfth_man" | "max_captain";

/**
 * Dream Team's captain/vice-captain (doubles points, see
 * compute_projections.py's captain multiplier) - both must be different
 * squad members. Unlike FanTeam there's no provider-sync guard here (Dream
 * Team has no live sync path yet) and no starting-XI concept to check
 * against (an 11-man squad with no bench - every squad member always
 * counts). Logs to squad_captain_history for Performance Lab grading, same
 * pattern as FanTeam's setFanteamCaptain.
 */
export async function setCaptain({
  squadId,
  captainGamePlayerId,
  viceCaptainGamePlayerId,
}: {
  squadId: number;
  captainGamePlayerId: number;
  viceCaptainGamePlayerId: number;
}) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  if (captainGamePlayerId === viceCaptainGamePlayerId) {
    return { error: "Captain and vice-captain must be different players." };
  }

  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: squadPlayers } = await supabase.from("squad_players").select("game_player_id").eq("squad_id", squadId);
  const squadIds = new Set((squadPlayers ?? []).map((s) => s.game_player_id));
  if (!squadIds.has(captainGamePlayerId) || !squadIds.has(viceCaptainGamePlayerId)) {
    return { error: "Captain and vice-captain must both be in your squad." };
  }

  const { error } = await supabase
    .from("squads")
    .update({ captain_game_player_id: captainGamePlayerId, vice_captain_game_player_id: viceCaptainGamePlayerId })
    .eq("id", squadId);
  if (error) return { error: error.message };

  const { planningGameweek } = await getSeasonTiming(supabase, squad.game_id);
  await supabase.from("squad_captain_history").insert({
    squad_id: squadId,
    gameweek: planningGameweek ?? 1,
    captain_game_player_id: captainGamePlayerId,
    vice_captain_game_player_id: viceCaptainGamePlayerId,
  });

  revalidatePath("/dreamteam");
  return { success: true };
}

/**
 * A real like-for-like transfer (out one squad player, in one pool
 * player of the same position). Dream Team's real rules (confirmed with
 * the user directly, not inferred): pre-season is free and unlimited
 * (1.2.2.3); once the season starts, a hard 2/gameweek cap rolling to 6
 * with NO points-hit for going over it - so unlike FanTeam, there's no
 * "make it anyway at a cost" path once free_transfers hits 0, the
 * transfer is simply refused. No club-limit check needed (1.2.2.4: no
 * restriction on players from one club).
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

  const { data: squad } = await supabase
    .from("squads")
    .select("id, user_id, game_id, free_transfers")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { seasonStarted } = await getSeasonTiming(supabase, squad.game_id);

  if (seasonStarted && squad.free_transfers <= 0) {
    return { error: "No transfers left this gameweek - Dream Team has a hard cap, no points-hit option." };
  }

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
  // 2026-08-20 user report: a replacement was always required to match
  // its outgoing player's OWN position, blocking a swap that would still
  // leave the squad on one of Dream Team's 7 real formations (e.g.
  // selling a MID and buying a DEF, going 4-4-2 -> 5-3-2). isLegalFormationPick
  // with totalOpenSlots=1 is exactly "does this single swap still reach a
  // real formation" - see squadFormation.ts's docstring (same relaxation
  // already shipped for EFL Fantasy's own transfer flow, eflFormation.ts).
  const keptCounts = countByPosition(
    (allSquadPlayers ?? [])
      .filter((p) => p.game_player_id !== outGamePlayerId)
      .map((p) => ({ position: p.game_players.position_code as SquadPosition }))
  );
  if (!isLegalFormationPick(keptCounts, { GK: 0, DEF: 0, MID: 0, FWD: 0 }, incoming.position_code as SquadPosition, 1, DREAMTEAM_FORMATIONS)) {
    return { error: "That swap would leave the squad off every real formation (needs exactly 1 GK plus a legal DEF/MID/FWD split, e.g. 4-4-2 or 3-5-2)." };
  }

  const teamValue = (allSquadPlayers ?? []).reduce((sum, p) => sum + Number(p.game_players.price), 0);
  const { data: rules } = await supabase.from("game_squad_rules").select("budget").eq("game_id", squad.game_id).single();
  const bank = Number(rules?.budget ?? 50) - teamValue;
  if (bank + Number(squadPlayerRow.game_players.price) - Number(incoming.price) < 0) {
    return { error: "Not enough budget for that transfer." };
  }

  const { error: updateError } = await supabase.from("squad_players").update({ game_player_id: inGamePlayerId }).eq("id", squadPlayerRow.id);
  if (updateError) return { error: updateError.message };

  if (seasonStarted) {
    await supabase
      .from("squads")
      .update({ free_transfers: squad.free_transfers - 1 })
      .eq("id", squadId);
  }

  const { planningGameweek } = await getSeasonTiming(supabase, squad.game_id);
  await supabase.from("squad_transfers").insert({
    squad_id: squadId,
    gameweek: planningGameweek ?? 1,
    out_game_player_id: outGamePlayerId,
    in_game_player_id: inGamePlayerId,
    cost_points: 0,
    used_wildcard: false,
  });

  revalidatePath("/dreamteam");
  return { success: true };
}

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

  revalidatePath("/dreamteam");
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

  revalidatePath("/dreamteam");
  return { success: true };
}

/**
 * Manual "Save Team" - real user request 2026-08-18: locks in the
 * squad's CURRENT live state as planningGameweek's official submission,
 * re-pressable (overwrites) right up until that gameweek's real deadline,
 * after which saveSquadGameweekLock refuses (see its own docstring).
 * Dream Team has no bench (every squad member always starts - is_starting
 * true, bench_order null for every row, unlike FanTeam), so the snapshot
 * always reflects the whole squad.
 */
export async function saveTeamForGameweek({ squadId }: { squadId: number }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: squad } = await supabase
    .from("squads")
    .select("id, user_id, game_id, captain_game_player_id, vice_captain_game_player_id, active_booster, active_booster_gameweek")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: squadPlayers } = await supabase.from("squad_players").select("game_player_id").eq("squad_id", squadId);
  if (!squadPlayers || squadPlayers.length === 0) return { error: "Your squad is empty - nothing to save." };

  const gwInfo = await getGameweekInfo(supabase, squad.game_id);
  if (gwInfo.planningGameweek == null) return { error: "No upcoming gameweek to save a team for yet." };
  const deadline = gwInfo.gameweeks.find((g) => g.gameweek === gwInfo.planningGameweek)?.deadline ?? null;

  const result = await saveSquadGameweekLock(supabase, squadId, gwInfo.planningGameweek, deadline, {
    players: squadPlayers.map((p) => ({ game_player_id: p.game_player_id, is_starting: true, bench_order: null })),
    captainGamePlayerId: squad.captain_game_player_id,
    viceCaptainGamePlayerId: squad.vice_captain_game_player_id,
    activeBooster: squad.active_booster_gameweek === gwInfo.planningGameweek ? squad.active_booster : null,
  });
  if ("error" in result) return result;

  revalidatePath("/dreamteam");
  return { success: true as const };
}
