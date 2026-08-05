"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { TRANSFER_HIT_COST as FANTEAM_TRANSFER_HIT_COST, wildcardWindowFor as fanteamWildcardWindow } from "@/lib/transferEconomy";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

/**
 * Real rule: captain/vice-captain must be in the starting XI (enforced
 * at pick time by setFanteamCaptain). A lineup change (manual sub or
 * formation switch) can legitimately bench whoever currently holds
 * either role - clears it rather than leaving a stale pick pointing at
 * a benched player, since guessing a replacement isn't this action's
 * job.
 */
async function clearInvalidCaptaincy(supabase: Supabase, squadId: number, benchedGamePlayerIds: Set<number>) {
  const { data: squad } = await supabase.from("squads").select("captain_game_player_id, vice_captain_game_player_id").eq("id", squadId).single();
  if (!squad) return;
  const patch: Record<string, null> = {};
  if (squad.captain_game_player_id !== null && benchedGamePlayerIds.has(squad.captain_game_player_id)) patch.captain_game_player_id = null;
  if (squad.vice_captain_game_player_id !== null && benchedGamePlayerIds.has(squad.vice_captain_game_player_id)) patch.vice_captain_game_player_id = null;
  if (Object.keys(patch).length > 0) {
    await supabase.from("squads").update(patch).eq("id", squadId);
  }
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
 * "+1 free transfer per gameweek" accrual happens OUTSIDE this action -
 * scripts/accrue_free_transfers.py, run every refresh_all.py cycle,
 * credits it once a real gameweek actually completes (migration 0022's
 * "needs a live 'a new gameweek has started' trigger" gap, closed
 * 2026-08-06). This action only ever counts a transfer DOWN.
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

  revalidatePath(`/fanteam/${squadId}`);
  return { success: true, costPoints };
}

/**
 * Reorders FanTeam's real auto-substitution priority for the 3 outfield
 * bench spots (bench_order 1/2/3 - the reserve GK has no order, a 15-man
 * squad only ever has one). A direct one-step swap, same as the old
 * frontend's LineupBuilder: moving reserve 3 into reserve 1 trades places
 * with whoever currently holds slot 1, rather than nudging everyone down
 * one at a time.
 *
 * bench_order is nullable and, for at least one real squad, was only
 * partially populated (one outfield reserve had a real value, two had
 * none) - self-heals by assigning every outfield reserve a real
 * sequential value (by game_player_id, a stable tiebreak the client uses
 * for its own display fallback too, so the two never disagree) before
 * applying the requested swap, rather than erroring on missing data.
 */
export async function reorderFanteamBench({
  squadId,
  gamePlayerId,
  targetOrder,
}: {
  squadId: number;
  gamePlayerId: number;
  targetOrder: number;
}) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: squad } = await supabase.from("squads").select("id, user_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: benchRows } = await supabase
    .from("squad_players")
    .select("id, game_player_id, bench_order, game_players(players(position))")
    .eq("squad_id", squadId)
    .eq("is_starting", false)
    .returns<{ id: number; game_player_id: number; bench_order: number | null; game_players: { players: { position: string } } }[]>();
  if (!benchRows) return { error: "Couldn't load squad." };

  const outfield = benchRows.filter((r) => r.game_players.players.position !== "GK");
  const orders = outfield.map((r) => r.bench_order);
  const needsNormalizing = orders.some((o) => o == null) || new Set(orders).size !== orders.length;

  let working = outfield;
  if (needsNormalizing) {
    const sorted = outfield
      .slice()
      .sort((a, b) => (a.bench_order ?? 99) - (b.bench_order ?? 99) || a.game_player_id - b.game_player_id);
    working = sorted.map((r, i) => ({ ...r, bench_order: i + 1 }));
    for (const r of working) {
      const { error } = await supabase.from("squad_players").update({ bench_order: r.bench_order }).eq("id", r.id);
      if (error) return { error: error.message };
    }
  }

  const moving = working.find((r) => r.game_player_id === gamePlayerId);
  if (!moving) return { error: "That player isn't an outfield reserve." };
  if (targetOrder < 1 || targetOrder > working.length) return { error: "Not a valid reserve slot." };
  if (moving.bench_order === targetOrder) {
    revalidatePath(`/fanteam/${squadId}`);
    return { success: true };
  }

  const occupant = working.find((r) => r.bench_order === targetOrder);

  const { error: moveError } = await supabase.from("squad_players").update({ bench_order: targetOrder }).eq("id", moving.id);
  if (moveError) return { error: moveError.message };

  if (occupant) {
    const { error: swapError } = await supabase.from("squad_players").update({ bench_order: moving.bench_order }).eq("id", occupant.id);
    if (swapError) return { error: swapError.message };
  }

  revalidatePath(`/fanteam/${squadId}`);
  return { success: true };
}

/**
 * Switches FanTeam's starting-XI formation and auto-fills the best 11
 * from the full 15-man squad for the new quota - the highest-projected
 * scorer(s) in each position, same "top-N-per-position is provably
 * optimal for a fixed formation" logic as the old frontend's
 * suggestBestXI (no search needed - every slot within a position is
 * interchangeable). Outfield bench priority is re-ranked by score too
 * (best reserve = first auto-sub in), same convention used everywhere
 * else in this file. The reserve GK is whichever of the squad's 2 real
 * GKs isn't starting - never has a bench_order, a 15-man squad only
 * ever has one.
 */
export async function setFanteamFormation({ squadId, formationCode }: { squadId: number; formationCode: string }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: formation } = await supabase
    .from("game_formations")
    .select("code, gk_count, def_count, mid_count, fwd_count")
    .eq("game_id", squad.game_id)
    .eq("code", formationCode)
    .single();
  if (!formation) return { error: "Not a real formation for this game." };

  const { data: squadPlayers } = await supabase
    .from("squad_players")
    .select("id, game_player_id, game_players(players(position))")
    .eq("squad_id", squadId)
    .returns<{ id: number; game_player_id: number; game_players: { players: { position: "GK" | "DEF" | "MID" | "FWD" } } }[]>();
  if (!squadPlayers || squadPlayers.length === 0) return { error: "Couldn't load squad." };

  const { data: scoreRows } = await supabase.from("player_projection_summary").select("game_player_id, hail_mary_score").eq("game_slug", "fanteam");
  const scoreByGamePlayerId = new Map<number, number>((scoreRows ?? []).map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));

  const quota: Record<"GK" | "DEF" | "MID" | "FWD", number> = {
    GK: formation.gk_count,
    DEF: formation.def_count,
    MID: formation.mid_count,
    FWD: formation.fwd_count,
  };
  const byPosition: Record<"GK" | "DEF" | "MID" | "FWD", { id: number; game_player_id: number; score: number }[]> = {
    GK: [],
    DEF: [],
    MID: [],
    FWD: [],
  };
  for (const sp of squadPlayers) {
    const pos = sp.game_players.players.position;
    byPosition[pos].push({ id: sp.id, game_player_id: sp.game_player_id, score: scoreByGamePlayerId.get(sp.game_player_id) ?? 0 });
  }
  for (const pos of ["GK", "DEF", "MID", "FWD"] as const) {
    byPosition[pos].sort((a, b) => b.score - a.score);
    if (byPosition[pos].length < quota[pos]) {
      return { error: `Not enough ${pos} players in your squad for ${formationCode}.` };
    }
  }

  const updates: { id: number; game_player_id: number; is_starting: boolean; bench_order: number | null }[] = [];
  for (const pos of ["GK", "DEF", "MID", "FWD"] as const) {
    byPosition[pos].forEach((p, i) => {
      if (i < quota[pos]) updates.push({ id: p.id, game_player_id: p.game_player_id, is_starting: true, bench_order: null });
      else if (pos === "GK") updates.push({ id: p.id, game_player_id: p.game_player_id, is_starting: false, bench_order: null });
    });
  }
  const outfieldBench = (["DEF", "MID", "FWD"] as const)
    .flatMap((pos) => byPosition[pos].slice(quota[pos]))
    .sort((a, b) => b.score - a.score);
  outfieldBench.forEach((p, i) => updates.push({ id: p.id, game_player_id: p.game_player_id, is_starting: false, bench_order: i + 1 }));

  for (const u of updates) {
    const { error } = await supabase.from("squad_players").update({ is_starting: u.is_starting, bench_order: u.bench_order }).eq("id", u.id);
    if (error) return { error: error.message };
  }

  const benchedIds = new Set(updates.filter((u) => !u.is_starting).map((u) => u.game_player_id));
  await clearInvalidCaptaincy(supabase, squadId, benchedIds);

  revalidatePath(`/fanteam/${squadId}`);
  return { success: true };
}

/**
 * Sets FanTeam's captain/vice-captain (doubles/1.5x points respectively -
 * enforced by compute_projections.py, not here). Both must be different
 * starting-XI players. Blocked for provider-synced squads ONLY when a real
 * synced pick already exists (sync_provider_squads.py pulls captain/VC
 * straight from the real FanTeam site's scraped C/VC badges and overwrites
 * squads.captain_game_player_id/vice_captain_game_player_id unconditionally
 * on every sync run, every ~90 minutes - editing here would look saved and
 * then silently revert with no explanation, the exact confusing behavior
 * the old frontend's read-only pill deliberately avoided). When BOTH are
 * currently null - e.g. clearInvalidCaptaincy just cleared a stale pick
 * after a manual swap/formation change - there's nothing to protect, so a
 * manual pick is allowed as a stopgap; the next real sync overwrites it
 * with the actual site value regardless, exactly as before.
 */
export async function setFanteamCaptain({
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

  const { data: squad } = await supabase
    .from("squads")
    .select("id, user_id, game_id, captain_game_player_id, vice_captain_game_player_id")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: link } = await supabase.from("provider_squad_links").select("sync_enabled").eq("squad_id", squadId).maybeSingle();
  if (link?.sync_enabled && (squad.captain_game_player_id !== null || squad.vice_captain_game_player_id !== null)) {
    return { error: "This squad is synced from FanTeam - captain/vice-captain follow the real site and can't be edited here." };
  }

  if (captainGamePlayerId === viceCaptainGamePlayerId) {
    return { error: "Captain and vice-captain must be different players." };
  }

  const { data: starters } = await supabase.from("squad_players").select("game_player_id").eq("squad_id", squadId).eq("is_starting", true);
  const startingIds = new Set((starters ?? []).map((s) => s.game_player_id));
  if (!startingIds.has(captainGamePlayerId) || !startingIds.has(viceCaptainGamePlayerId)) {
    return { error: "Captain and vice-captain must both be in the starting XI." };
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

  revalidatePath(`/fanteam/${squadId}`);
  return { success: true };
}

/**
 * Manually swaps one starting-XI player for one bench player - a real
 * sub, not a transfer (no budget/club-limit check, no change to which 15
 * players are owned, no cost). Same-position swaps always preserve the
 * current formation's GK/DEF/MID/FWD counts automatically. Cross-position
 * swaps (e.g. a MID for a DEF) are also allowed, but only when the
 * resulting counts still match one of this game's real formations (e.g.
 * swapping a MID for a DEF flips 3-5-2 into 4-4-2) - the starting-XI
 * formation dropdown re-derives itself from these counts on next render
 * (see fanteam/[id]/page.tsx's currentFormationCode), so it follows
 * automatically without any extra bookkeeping here. The two players
 * simply trade is_starting and bench_order wholesale - the promoted
 * player takes on the demoted player's old bench slot (or lack of one,
 * for GK<->GK).
 */
export async function swapFanteamLineup({ squadId, playerAId, playerBId }: { squadId: number; playerAId: number; playerBId: number }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: rows } = await supabase
    .from("squad_players")
    .select("id, game_player_id, is_starting, bench_order, game_players(players(position))")
    .eq("squad_id", squadId)
    .returns<{ id: number; game_player_id: number; is_starting: boolean; bench_order: number | null; game_players: { players: { position: "GK" | "DEF" | "MID" | "FWD" } } }[]>();
  if (!rows) return { error: "Couldn't load squad." };

  const a = rows.find((r) => r.game_player_id === playerAId);
  const b = rows.find((r) => r.game_player_id === playerBId);
  if (!a || !b) return { error: "Couldn't find both players." };
  if (a.is_starting === b.is_starting) {
    return { error: "One player must be starting and the other on the bench." };
  }

  const posA = a.game_players.players.position;
  const posB = b.game_players.players.position;
  if (posA !== posB) {
    const counts: Record<"GK" | "DEF" | "MID" | "FWD", number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const r of rows) if (r.is_starting) counts[r.game_players.players.position] += 1;
    const outgoingPos = a.is_starting ? posA : posB;
    const incomingPos = a.is_starting ? posB : posA;
    counts[outgoingPos] -= 1;
    counts[incomingPos] += 1;

    const { data: formations } = await supabase
      .from("game_formations")
      .select("gk_count, def_count, mid_count, fwd_count")
      .eq("game_id", squad.game_id);
    const isValidFormation = (formations ?? []).some(
      (f) => f.gk_count === counts.GK && f.def_count === counts.DEF && f.mid_count === counts.MID && f.fwd_count === counts.FWD
    );
    if (!isValidFormation) {
      return { error: "That swap wouldn't leave a valid formation." };
    }
  }

  const { error: errA } = await supabase.from("squad_players").update({ is_starting: b.is_starting, bench_order: b.bench_order }).eq("id", a.id);
  if (errA) return { error: errA.message };
  const { error: errB } = await supabase.from("squad_players").update({ is_starting: a.is_starting, bench_order: a.bench_order }).eq("id", b.id);
  if (errB) return { error: errB.message };

  const demoted = a.is_starting ? a.game_player_id : b.game_player_id;
  await clearInvalidCaptaincy(supabase, squadId, new Set([demoted]));

  revalidatePath(`/fanteam/${squadId}`);
  return { success: true };
}
