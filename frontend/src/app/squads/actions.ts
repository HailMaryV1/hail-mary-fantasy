"use server";

import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

type SaveSquadArgs = {
  gameSlug: string;
  formationCode: string | null;
  gamePlayerIds: number[];
  name: string;
};

/**
 * Re-validates budget/quota/club-limit server-side before saving.
 * The client-side builder already enforces these live for UX, but a
 * server action is a trust boundary - never rely solely on client checks.
 */
export async function saveSquad({ gameSlug, formationCode, gamePlayerIds, name }: SaveSquadArgs) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase
    .from("fantasy_games")
    .select("id")
    .eq("slug", gameSlug)
    .single();
  if (!game) return { error: "Unknown game." };

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("*")
    .eq("game_id", game.id)
    .single();
  if (!rules) return { error: "No squad rules configured for this game." };

  let formation = null;
  if (rules.uses_formations) {
    if (!formationCode) return { error: "This game requires picking a formation." };
    const { data } = await supabase
      .from("game_formations")
      .select("*")
      .eq("game_id", game.id)
      .eq("code", formationCode)
      .single();
    if (!data) return { error: "Unknown formation." };
    formation = data;
  }

  const { data: players } = await supabase
    .from("game_players")
    .select("id, price, position_code, player_id, players(position, team_id)")
    .eq("game_id", game.id)
    .in("id", gamePlayerIds);

  if (!players || players.length !== gamePlayerIds.length) {
    return { error: "One or more selected players couldn't be found." };
  }

  if (players.length !== rules.squad_size) {
    return { error: `Squad must have exactly ${rules.squad_size} players (got ${players.length}).` };
  }

  const totalPrice = players.reduce((sum, p) => sum + Number(p.price), 0);
  if (totalPrice > Number(rules.budget)) {
    return { error: `Squad costs £${totalPrice.toFixed(1)}m, over the £${rules.budget}m budget.` };
  }

  const counts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubCounts = new Map<number, number>();
  for (const p of players) {
    const position = (p.players as unknown as { position: string; team_id: number }).position;
    const teamId = (p.players as unknown as { position: string; team_id: number }).team_id;
    counts[position] = (counts[position] ?? 0) + 1;
    clubCounts.set(teamId, (clubCounts.get(teamId) ?? 0) + 1);
  }

  const quota = rules.uses_formations
    ? { GK: formation!.gk_count, DEF: formation!.def_count, MID: formation!.mid_count, FWD: formation!.fwd_count }
    : { GK: rules.gk_quota, DEF: rules.def_quota, MID: rules.mid_quota, FWD: rules.fwd_quota };

  for (const pos of ["GK", "DEF", "MID", "FWD"] as const) {
    if (counts[pos] !== quota[pos]) {
      return { error: `Need exactly ${quota[pos]} ${pos}, got ${counts[pos]}.` };
    }
  }

  if (rules.max_per_club) {
    for (const [, count] of clubCounts) {
      if (count > rules.max_per_club) {
        return { error: `Max ${rules.max_per_club} players allowed from the same club.` };
      }
    }
  }

  const { data: squad, error: squadError } = await supabase
    .from("squads")
    .insert({
      user_id: user.id,
      game_id: game.id,
      name,
      formation_id: formation?.id ?? null,
    })
    .select("id")
    .single();

  if (squadError || !squad) {
    return { error: squadError?.message ?? "Failed to create squad." };
  }

  const { error: playersError } = await supabase
    .from("squad_players")
    .insert(gamePlayerIds.map((gamePlayerId) => ({ squad_id: squad.id, game_player_id: gamePlayerId })));

  if (playersError) {
    return { error: playersError.message };
  }

  redirect("/squads");
}

type SaveLineupArgs = {
  squadId: number;
  formationCode: string;
  startingGamePlayerIds: number[];
};

/**
 * Sets which squad members start this gameweek (games with a bench,
 * e.g. FanTeam's 15-man squad / 11 starters). Re-validates ownership and
 * the formation quota server-side, same trust-boundary reasoning as
 * saveSquad above.
 */
export async function saveLineup({ squadId, formationCode, startingGamePlayerIds }: SaveLineupArgs) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: squad } = await supabase
    .from("squads")
    .select("id, user_id, game_id")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("starting_size")
    .eq("game_id", squad.game_id)
    .single();
  if (!rules) return { error: "No squad rules configured for this game." };

  const { data: formation } = await supabase
    .from("game_formations")
    .select("*")
    .eq("game_id", squad.game_id)
    .eq("code", formationCode)
    .single();
  if (!formation) return { error: "Unknown formation." };

  const { data: squadPlayers } = await supabase
    .from("squad_players")
    .select("game_player_id, game_players(position_code, players(position))")
    .eq("squad_id", squadId);

  const validIds = new Set((squadPlayers ?? []).map((sp) => sp.game_player_id));
  if (startingGamePlayerIds.some((id) => !validIds.has(id))) {
    return { error: "One or more players aren't in this squad." };
  }
  if (startingGamePlayerIds.length !== rules.starting_size) {
    return { error: `Starting XI must have exactly ${rules.starting_size} players.` };
  }

  const startingSet = new Set(startingGamePlayerIds);
  const counts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const sp of squadPlayers ?? []) {
    if (!startingSet.has(sp.game_player_id)) continue;
    const position = (sp.game_players as unknown as { players: { position: string } }).players.position;
    counts[position] = (counts[position] ?? 0) + 1;
  }

  const quota = { GK: formation.gk_count, DEF: formation.def_count, MID: formation.mid_count, FWD: formation.fwd_count };
  for (const pos of ["GK", "DEF", "MID", "FWD"] as const) {
    if (counts[pos] !== quota[pos]) {
      return { error: `${formationCode} needs exactly ${quota[pos]} ${pos}, got ${counts[pos]}.` };
    }
  }

  const { error: squadUpdateError } = await supabase
    .from("squads")
    .update({ starting_formation_id: formation.id, updated_at: new Date().toISOString() })
    .eq("id", squadId);
  if (squadUpdateError) return { error: squadUpdateError.message };

  const { error: startError } = await supabase
    .from("squad_players")
    .update({ is_starting: true })
    .eq("squad_id", squadId)
    .in("game_player_id", startingGamePlayerIds);
  if (startError) return { error: startError.message };

  const benchIds = Array.from(validIds).filter((id) => !startingSet.has(id));
  if (benchIds.length > 0) {
    const { error: benchError } = await supabase
      .from("squad_players")
      .update({ is_starting: false })
      .eq("squad_id", squadId)
      .in("game_player_id", benchIds);
    if (benchError) return { error: benchError.message };
  }

  redirect("/squads");
}

type MakeTransferArgs = {
  squadId: number;
  outGamePlayerId: number;
  inGamePlayerId: number;
  useWildcard?: boolean;
};

/**
 * Current/next gameweek for a game - the one whose deadline hasn't
 * passed yet (earliest gameweek with a fixture still in the future).
 * Null for games with no published calendar (Dream Team, still
 * off-season) - transfer-limit enforcement is skipped entirely for
 * those rather than guessed at, since Dream Team's real rules (2/week,
 * 6 banked - different from FanTeam) aren't wired up yet either.
 */
async function getCurrentGameweek(
  supabase: Awaited<ReturnType<typeof createAuthServerClient>>,
  gameId: number
): Promise<number | null> {
  const { data } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures!inner(kickoff_at)")
    .eq("game_id", gameId)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.gameweek ?? null;
}

/**
 * Executes a single sell/buy swap, enforcing FanTeam's real transfer
 * rules (from the user's copy of FanTeam's own rules page): 1 free
 * transfer per gameweek banking up to 37, -4 points per transfer beyond
 * that, 2 wildcards (WC1 usable gameweeks 2-19, WC2 gameweeks 20-38,
 * each resets banked free transfers to zero on activation). The "+1
 * free transfer per gameweek" accrual itself isn't automated - see
 * migration 0022 - so free_transfers only ever goes down here, never
 * up, until that's built.
 */
export async function makeTransfer({ squadId, outGamePlayerId, inGamePlayerId, useWildcard }: MakeTransferArgs) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: squad } = await supabase
    .from("squads")
    .select("id, user_id, game_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("budget, max_per_club")
    .eq("game_id", squad.game_id)
    .single();
  if (!rules) return { error: "No squad rules configured for this game." };

  const { data: squadPlayers } = await supabase
    .from("squad_players")
    .select("game_player_id, is_starting, game_players(price, position_code, players(position, team_id))")
    .eq("squad_id", squadId);
  if (!squadPlayers) return { error: "Couldn't load squad." };

  type Row = { game_player_id: number; is_starting: boolean; game_players: { price: number; players: { position: string; team_id: number } } };
  const rows = squadPlayers as unknown as Row[];
  const outgoing = rows.find((r) => r.game_player_id === outGamePlayerId);
  if (!outgoing) return { error: "That player isn't in this squad." };
  if (rows.some((r) => r.game_player_id === inGamePlayerId)) return { error: "That player is already in this squad." };

  const { data: incomingGp } = await supabase
    .from("game_players")
    .select("id, price, players(position, team_id)")
    .eq("id", inGamePlayerId)
    .single();
  if (!incomingGp) return { error: "Incoming player not found." };
  const incoming = incomingGp as unknown as { id: number; price: number; players: { position: string; team_id: number } };

  if (incoming.players.position !== outgoing.game_players.players.position) {
    return { error: "Replacement must be the same position." };
  }

  const currentTotal = rows.reduce((sum, r) => sum + Number(r.game_players.price), 0);
  const newTotal = currentTotal - Number(outgoing.game_players.price) + Number(incoming.price);
  if (newTotal > Number(rules.budget)) {
    return { error: `That transfer costs £${newTotal.toFixed(1)}m, over the £${rules.budget}m budget.` };
  }

  if (rules.max_per_club) {
    const clubCounts = new Map<number, number>();
    for (const r of rows) {
      if (r.game_player_id === outGamePlayerId) continue;
      const teamId = r.game_players.players.team_id;
      clubCounts.set(teamId, (clubCounts.get(teamId) ?? 0) + 1);
    }
    const newClubCount = (clubCounts.get(incoming.players.team_id) ?? 0) + 1;
    if (newClubCount > rules.max_per_club) {
      return { error: `Max ${rules.max_per_club} players allowed from the same club.` };
    }
  }

  // Transfer cost - only meaningful for games with a real gameweek
  // calendar (currently FanTeam). Games without one skip this entirely
  // (same as before this feature existed), not guessed at.
  const gameweek = await getCurrentGameweek(supabase, squad.game_id);
  let costPoints = 0;
  let usedWildcard = false;
  let newFreeTransfers = squad.free_transfers;
  const squadUpdate: Record<string, number> = {};

  if (gameweek !== null) {
    const wc1Active = squad.wildcard_1_used_gameweek === gameweek;
    const wc2Active = squad.wildcard_2_used_gameweek === gameweek;

    if (wc1Active || wc2Active) {
      usedWildcard = true; // wildcard already active this gameweek from an earlier transfer
    } else if (useWildcard) {
      const wc1Window = gameweek >= 2 && gameweek <= 19;
      const wc2Window = gameweek >= 20 && gameweek <= 38;
      if (wc1Window && squad.wildcard_1_used_gameweek === null) {
        squadUpdate.wildcard_1_used_gameweek = gameweek;
      } else if (wc2Window && squad.wildcard_2_used_gameweek === null) {
        squadUpdate.wildcard_2_used_gameweek = gameweek;
      } else {
        return { error: "No wildcard is available to use this gameweek (wrong window or already used)." };
      }
      usedWildcard = true;
      newFreeTransfers = 0; // activating a wildcard resets banked free transfers
    } else if (squad.free_transfers > 0) {
      newFreeTransfers = squad.free_transfers - 1;
    } else {
      costPoints = -4;
    }
  }

  const { error: deleteError } = await supabase
    .from("squad_players")
    .delete()
    .eq("squad_id", squadId)
    .eq("game_player_id", outGamePlayerId);
  if (deleteError) return { error: deleteError.message };

  const { error: insertError } = await supabase
    .from("squad_players")
    .insert({ squad_id: squadId, game_player_id: inGamePlayerId, is_starting: outgoing.is_starting });
  if (insertError) return { error: insertError.message };

  if (gameweek !== null) {
    await supabase.from("squad_transfers").insert({
      squad_id: squadId,
      gameweek,
      out_game_player_id: outGamePlayerId,
      in_game_player_id: inGamePlayerId,
      cost_points: costPoints,
      used_wildcard: usedWildcard,
    });
    await supabase
      .from("squads")
      .update({ free_transfers: newFreeTransfers, ...squadUpdate })
      .eq("id", squadId);
  }

  redirect(`/squads/${squadId}/transfers`);
}

type SetCaptainArgs = {
  squadId: number;
  captainGamePlayerId: number;
  viceCaptainGamePlayerId: number;
};

export async function setCaptain({ squadId, captainGamePlayerId, viceCaptainGamePlayerId }: SetCaptainArgs) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (captainGamePlayerId === viceCaptainGamePlayerId) {
    return { error: "Captain and vice-captain must be different players." };
  }

  const { data: squad } = await supabase.from("squads").select("id, user_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: starters } = await supabase
    .from("squad_players")
    .select("game_player_id")
    .eq("squad_id", squadId)
    .eq("is_starting", true);
  const startingIds = new Set((starters ?? []).map((s) => s.game_player_id));

  if (!startingIds.has(captainGamePlayerId) || !startingIds.has(viceCaptainGamePlayerId)) {
    return { error: "Captain and vice-captain must both be in the starting XI." };
  }

  const { error } = await supabase
    .from("squads")
    .update({ captain_game_player_id: captainGamePlayerId, vice_captain_game_player_id: viceCaptainGamePlayerId })
    .eq("id", squadId);
  if (error) return { error: error.message };

  redirect(`/squads/${squadId}/captain`);
}
