"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";

type Booster = "goal_bonus" | "twelfth_man" | "max_captain";

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
    .select("id, game_players(price, players(position))")
    .eq("squad_id", squadId)
    .eq("game_player_id", outGamePlayerId)
    .single<{ id: number; game_players: { price: number; players: { position: string } } }>();
  if (!squadPlayerRow) return { error: "That player isn't in your squad." };

  const { data: incoming } = await supabase
    .from("game_players")
    .select("id, price, is_active, players(position)")
    .eq("id", inGamePlayerId)
    .single<{ id: number; price: number; is_active: boolean; players: { position: string } }>();
  if (!incoming || !incoming.is_active) return { error: "That player isn't available." };
  if (incoming.players.position !== squadPlayerRow.game_players.players.position) {
    return { error: "Replacement must be the same position." };
  }

  const { data: allSquadPlayers } = await supabase
    .from("squad_players")
    .select("game_players(price)")
    .eq("squad_id", squadId)
    .returns<{ game_players: { price: number } }[]>();
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

  revalidatePath(`/squads/${squadId}`);
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

// FanTeam's real transfer economy: 1 free transfer per gameweek, -4
// points per transfer beyond that, waived entirely for a gameweek where
// a wildcard is active. Distinct from Dream Team's hard-cap-no-hit model
// (makeTransfer above) - a different game, a different real rule.
const FANTEAM_TRANSFER_HIT_COST = -4;

function fanteamWildcardWindow(gameweek: number): "wc1" | "wc2" | null {
  if (gameweek >= 2 && gameweek <= 19) return "wc1";
  if (gameweek >= 20 && gameweek <= 38) return "wc2";
  return null;
}

type FanteamSquadPlayerRow = {
  id: number;
  game_player_id: number;
  is_starting: boolean;
  game_players: { price: number; players: { position: string; team_id: number } };
};

/**
 * A real like-for-like FanTeam transfer (out one squad player, in one
 * pool player of the same position), enforcing FanTeam's real rules:
 * £100m budget, max 3 players per club, and the free-transfer/-4pt/
 * wildcard cost economy. Pre-season (before this game's real gameweek 1
 * kicks off) is free and unlimited, same convention as Dream Team's
 * makeTransfer.
 *
 * NOTE: "+1 free transfer per gameweek" accrual is NOT implemented here
 * - a known, real gap (see the old frontend's migration 0022 docstring
 * and this project's GW1 launch checklist) - free_transfers only ever
 * goes down via this action, never up, until a live "a new gameweek has
 * started" trigger exists to build that against.
 */
export async function makeFanteamTransfer({
  squadId,
  outGamePlayerId,
  inGamePlayerId,
  useWildcard,
}: {
  squadId: number;
  outGamePlayerId: number;
  inGamePlayerId: number;
  useWildcard: boolean;
}) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: squad } = await supabase
    .from("squads")
    .select("id, user_id, game_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: rules } = await supabase.from("game_squad_rules").select("budget, max_per_club").eq("game_id", squad.game_id).single();
  if (!rules) return { error: "No squad rules configured for this game." };

  const { data: squadPlayers } = await supabase
    .from("squad_players")
    .select("id, game_player_id, is_starting, game_players(price, players(position, team_id))")
    .eq("squad_id", squadId)
    .returns<FanteamSquadPlayerRow[]>();
  if (!squadPlayers) return { error: "Couldn't load squad." };

  const outgoing = squadPlayers.find((r) => r.game_player_id === outGamePlayerId);
  if (!outgoing) return { error: "That player isn't in this squad." };
  if (squadPlayers.some((r) => r.game_player_id === inGamePlayerId)) return { error: "That player is already in this squad." };

  const { data: incoming } = await supabase
    .from("game_players")
    .select("id, price, is_active, players(position, team_id)")
    .eq("id", inGamePlayerId)
    .single<{ id: number; price: number; is_active: boolean; players: { position: string; team_id: number } }>();
  if (!incoming || !incoming.is_active) return { error: "That player isn't available." };
  if (incoming.players.position !== outgoing.game_players.players.position) {
    return { error: "Replacement must be the same position." };
  }

  const currentTotal = squadPlayers.reduce((sum, r) => sum + Number(r.game_players.price), 0);
  const newTotal = currentTotal - Number(outgoing.game_players.price) + Number(incoming.price);
  if (newTotal > Number(rules.budget)) {
    return { error: `That transfer costs £${newTotal.toFixed(1)}m, over the £${Number(rules.budget).toFixed(1)}m budget.` };
  }

  if (rules.max_per_club) {
    const clubCounts = new Map<number, number>();
    for (const r of squadPlayers) {
      if (r.game_player_id === outGamePlayerId) continue;
      clubCounts.set(r.game_players.players.team_id, (clubCounts.get(r.game_players.players.team_id) ?? 0) + 1);
    }
    const newClubCount = (clubCounts.get(incoming.players.team_id) ?? 0) + 1;
    if (newClubCount > rules.max_per_club) {
      return { error: `Max ${rules.max_per_club} players allowed from the same club.` };
    }
  }

  const { seasonStarted, planningGameweek } = await getSeasonTiming(supabase, squad.game_id);

  let costPoints = 0;
  let usedWildcard = false;
  let newFreeTransfers = squad.free_transfers;
  const squadUpdate: Record<string, number> = {};

  if (seasonStarted && planningGameweek !== null) {
    const wildcardAlreadyActive = squad.wildcard_1_used_gameweek === planningGameweek || squad.wildcard_2_used_gameweek === planningGameweek;

    if (wildcardAlreadyActive) {
      usedWildcard = true;
    } else if (useWildcard) {
      const window = fanteamWildcardWindow(planningGameweek);
      if (window === "wc1" && squad.wildcard_1_used_gameweek === null) {
        squadUpdate.wildcard_1_used_gameweek = planningGameweek;
      } else if (window === "wc2" && squad.wildcard_2_used_gameweek === null) {
        squadUpdate.wildcard_2_used_gameweek = planningGameweek;
      } else {
        return { error: "No wildcard is available to use this gameweek (wrong window or already used)." };
      }
      usedWildcard = true;
      newFreeTransfers = 0;
    } else if (squad.free_transfers > 0) {
      newFreeTransfers = squad.free_transfers - 1;
    } else {
      costPoints = FANTEAM_TRANSFER_HIT_COST;
    }
  }

  const { error: deleteError } = await supabase.from("squad_players").delete().eq("squad_id", squadId).eq("game_player_id", outGamePlayerId);
  if (deleteError) return { error: deleteError.message };

  const { error: insertError } = await supabase
    .from("squad_players")
    .insert({ squad_id: squadId, game_player_id: inGamePlayerId, is_starting: outgoing.is_starting });
  if (insertError) return { error: insertError.message };

  const { error: squadError } = await supabase
    .from("squads")
    .update({ ...squadUpdate, free_transfers: newFreeTransfers })
    .eq("id", squadId);
  if (squadError) return { error: squadError.message };

  await supabase.from("squad_transfers").insert({
    squad_id: squadId,
    gameweek: planningGameweek ?? 1,
    out_game_player_id: outGamePlayerId,
    in_game_player_id: inGamePlayerId,
    cost_points: costPoints,
    used_wildcard: usedWildcard,
  });

  revalidatePath(`/squads/${squadId}`);
  return { success: true, costPoints };
}
