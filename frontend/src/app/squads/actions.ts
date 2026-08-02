"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { suggestBestXI } from "@/lib/squadOptimizer";
import { wildcardWindowFor, isWildcardActive, TRANSFER_HIT_COST } from "@/lib/transferEconomy";
import { runAskMaryAnalysis } from "@/lib/askMaryEngine";
import { recordPredictions } from "@/app/ask-mary/actions";
import type { Strategy } from "@/lib/recommendationScoring";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

/**
 * Decides is_starting for a freshly saved/edited squad. Without this,
 * a new squad_players row has no starting/bench split at all - every
 * player looked like a "confirmed starter" on the pitch view until the
 * user separately visited the Lineup page, which was never actually
 * correct (found when Auto-fill Best XI put all 15 players on the pitch
 * with an empty bench). Reuses the same suggestBestXI the Lineup page's
 * own "Auto-fill optimal XI" button already uses - one algorithm, not two.
 *
 * Games with no bench (squad_size === starting_size, e.g. Dream Team)
 * have nothing to decide - every player IS a starter.
 */
async function computeStartingSplit(
  supabase: Supabase,
  gameId: number,
  gamePlayerIds: number[],
  squadSize: number,
  startingSize: number
): Promise<{ startingIds: Set<number>; formationId: number | null }> {
  if (squadSize === startingSize) {
    return { startingIds: new Set(gamePlayerIds), formationId: null };
  }

  const { data: gameRow } = await supabase.from("fantasy_games").select("slug").eq("id", gameId).single();
  if (!gameRow) return { startingIds: new Set(), formationId: null };

  const { data: formations } = await supabase
    .from("game_formations")
    .select("id, code, gk_count, def_count, mid_count, fwd_count")
    .eq("game_id", gameId);
  if (!formations || formations.length === 0) return { startingIds: new Set(), formationId: null };

  const { data: pool } = await supabase
    .from("game_player_pool")
    .select("game_player_id, position, hail_mary_score")
    .eq("game_slug", gameRow.slug)
    .in("game_player_id", gamePlayerIds)
    .returns<{ game_player_id: number; position: "GK" | "DEF" | "MID" | "FWD"; hail_mary_score: number | null }[]>();

  const suggestion = suggestBestXI(
    (pool ?? []).map((p) => ({
      game_player_id: p.game_player_id,
      position: p.position,
      score: p.hail_mary_score != null ? Number(p.hail_mary_score) : 0,
    })),
    formations
  );
  if (!suggestion) return { startingIds: new Set(), formationId: null };

  const formationRow = formations.find((f) => f.code === suggestion.formationCode);
  return { startingIds: new Set(suggestion.startingGamePlayerIds), formationId: formationRow?.id ?? null };
}

type SaveSquadArgs = {
  gameSlug: string;
  formationCode: string | null;
  gamePlayerIds: number[];
  name: string;
  // A scratch squad is a real `squads` row (gets all the same
  // infrastructure - Ask Mary, lineup rules, etc. - for free) but is
  // excluded from /squads' main list and Performance Lab's grading, and
  // redirects to Ask Mary instead of the squad list on save - it exists
  // purely to test an alternative route, not as a real entry. See
  // migration 0059.
  isScratch?: boolean;
};

/**
 * Re-validates budget/quota/club-limit server-side before saving.
 * The client-side builder already enforces these live for UX, but a
 * server action is a trust boundary - never rely solely on client checks.
 */
export async function saveSquad({ gameSlug, formationCode, gamePlayerIds, name, isScratch }: SaveSquadArgs) {
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

  const { startingIds, formationId } = await computeStartingSplit(supabase, game.id, gamePlayerIds, rules.squad_size, rules.starting_size);

  const { data: squad, error: squadError } = await supabase
    .from("squads")
    .insert({
      user_id: user.id,
      game_id: game.id,
      name,
      formation_id: formation?.id ?? null,
      starting_formation_id: formationId,
      is_scratch: !!isScratch,
    })
    .select("id")
    .single();

  if (squadError || !squad) {
    return { error: squadError?.message ?? "Failed to create squad." };
  }

  const { error: playersError } = await supabase.from("squad_players").insert(
    gamePlayerIds.map((gamePlayerId) => ({
      squad_id: squad.id,
      game_player_id: gamePlayerId,
      is_starting: startingIds.has(gamePlayerId),
    }))
  );

  if (playersError) {
    return { error: playersError.message };
  }

  // A scratch squad exists to be analysed, not managed like a real
  // entry - straight to Ask Mary rather than the squad list.
  redirect(isScratch ? `/ask-mary?squad=${squad.id}` : "/squads");
}

/**
 * Clones a real squad's current 15 players + transfer/wildcard state
 * into a brand new scratch squad, then sends the user straight to Ask
 * Mary for it - "duplicate an existing squad to test an alternative
 * route" from the audit's Phase B spec. Deliberately does NOT copy
 * captain/vice-captain or preferred_strategy/horizon - those are
 * decisions Ask Mary will recompute fresh for the clone, not assumptions
 * carried over from the original.
 */
export async function duplicateSquadAsScratch(sourceSquadId: number) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: source } = await supabase
    .from("squads")
    .select("id, name, user_id, game_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek")
    .eq("id", sourceSquadId)
    .single();
  if (!source || source.user_id !== user.id) return { error: "Squad not found." };

  const { data: sourcePlayers } = await supabase
    .from("squad_players")
    .select("game_player_id, is_starting, bench_order")
    .eq("squad_id", sourceSquadId);
  if (!sourcePlayers || sourcePlayers.length === 0) return { error: "That squad has no players to duplicate yet." };

  const { data: newSquad, error: squadError } = await supabase
    .from("squads")
    .insert({
      user_id: user.id,
      game_id: source.game_id,
      name: `${source.name} (test)`,
      free_transfers: source.free_transfers,
      wildcard_1_used_gameweek: source.wildcard_1_used_gameweek,
      wildcard_2_used_gameweek: source.wildcard_2_used_gameweek,
      is_scratch: true,
      scratch_source_squad_id: source.id,
    })
    .select("id")
    .single();
  if (squadError || !newSquad) return { error: squadError?.message ?? "Failed to duplicate squad." };

  const { error: playersError } = await supabase.from("squad_players").insert(
    sourcePlayers.map((p) => ({
      squad_id: newSquad.id,
      game_player_id: p.game_player_id,
      is_starting: p.is_starting,
      bench_order: p.bench_order,
    }))
  );
  if (playersError) return { error: playersError.message };

  redirect(`/ask-mary?squad=${newSquad.id}`);
}

type UpdateSquadPlayersArgs = {
  squadId: number;
  gamePlayerIds: number[];
};

/**
 * Full-replace edit of an existing squad's composition - same
 * budget/quota/club-limit validation as saveSquad, but diffs against the
 * squad's current squad_players rather than inserting a fresh squad.
 * Deliberately bypasses the transfer economy (free_transfers/wildcards/
 * -4pt costs) that makeTransfer enforces - this is meant as a direct
 * "set what the squad actually is" editor mirroring what the user does
 * by hand on FanTeam's own site, not a tracked in-game transfer.
 * Starting/bench is recomputed for the whole squad on every save (see
 * computeStartingSplit) rather than left for the user to fix up
 * separately on the lineup page afterwards.
 */
export async function updateSquadPlayers({ squadId, gamePlayerIds }: UpdateSquadPlayersArgs) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { data: rules } = await supabase.from("game_squad_rules").select("*").eq("game_id", squad.game_id).single();
  if (!rules) return { error: "No squad rules configured for this game." };

  const { data: players } = await supabase
    .from("game_players")
    .select("id, price, position_code, player_id, players(position, team_id)")
    .eq("game_id", squad.game_id)
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

  // Fixed per-position quota only (no formation concept for the full
  // squad) - same as saveSquad's non-formations branch. Games that use
  // formations for full-squad selection aren't wired up here, same gap
  // saveSquad already has (Dream Team has no live data source yet anyway).
  const quota = { GK: rules.gk_quota, DEF: rules.def_quota, MID: rules.mid_quota, FWD: rules.fwd_quota };
  for (const pos of ["GK", "DEF", "MID", "FWD"] as const) {
    if (quota[pos] != null && counts[pos] !== quota[pos]) {
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

  const { data: currentRows } = await supabase.from("squad_players").select("game_player_id").eq("squad_id", squadId);
  const currentIds = new Set((currentRows ?? []).map((r) => r.game_player_id));
  const newIds = new Set(gamePlayerIds);

  const toRemove = Array.from(currentIds).filter((id) => !newIds.has(id));
  const toAdd = Array.from(newIds).filter((id) => !currentIds.has(id));

  // Recomputed from the FULL new 15, not just the diff - an edit can
  // easily invalidate the old starting/bench split even for players who
  // didn't change (e.g. a stronger replacement bumps someone else to the
  // bench), so every row gets refreshed, not only the newly added ones.
  const { startingIds, formationId } = await computeStartingSplit(supabase, squad.game_id, gamePlayerIds, rules.squad_size, rules.starting_size);

  if (toRemove.length > 0) {
    const { error } = await supabase.from("squad_players").delete().eq("squad_id", squadId).in("game_player_id", toRemove);
    if (error) return { error: error.message };
  }
  if (toAdd.length > 0) {
    const { error } = await supabase.from("squad_players").insert(
      toAdd.map((gamePlayerId) => ({ squad_id: squadId, game_player_id: gamePlayerId, is_starting: startingIds.has(gamePlayerId) }))
    );
    if (error) return { error: error.message };
  }
  const kept = gamePlayerIds.filter((id) => currentIds.has(id) && !toAdd.includes(id));
  for (const isStarting of [true, false]) {
    const ids = kept.filter((id) => startingIds.has(id) === isStarting);
    if (ids.length === 0) continue;
    const { error } = await supabase.from("squad_players").update({ is_starting: isStarting }).eq("squad_id", squadId).in("game_player_id", ids);
    if (error) return { error: error.message };
  }

  await supabase.from("squads").update({ starting_formation_id: formationId }).eq("id", squadId);

  redirect("/squads");
}

/**
 * Deletes a squad the user owns. Cascades to squad_players,
 * squad_transfers, squad_captain_history, and predictions (all declared
 * `on delete cascade` against squads.id) - so a deleted squad's
 * Performance Lab history disappears with it automatically, no separate
 * cleanup step needed.
 */
export async function deleteSquad({ squadId }: { squadId: number }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to manage squads." };

  const { data: squad } = await supabase.from("squads").select("id, user_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { error } = await supabase.from("squads").delete().eq("id", squadId);
  if (error) return { error: error.message };

  revalidatePath("/squads");
  return { success: true as const };
}

export async function renameSquad({ squadId, name }: { squadId: number; name: string }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to manage squads." };

  const trimmed = name.trim();
  if (!trimmed) return { error: "Squad name can't be empty." };

  const { data: squad } = await supabase.from("squads").select("id, user_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const { error } = await supabase.from("squads").update({ name: trimmed }).eq("id", squadId);
  if (error) return { error: error.message };

  revalidatePath("/squads");
  return { success: true as const };
}

type SaveLineupArgs = {
  squadId: number;
  formationCode: string;
  startingGamePlayerIds: number[];
  // Auto-substitution priority for the 3 outfield bench spots (1/2/3) -
  // game_player_id -> order. Undefined/missing entries (the GK reserve,
  // or a caller that predates this) are written as bench_order = null.
  benchOrder?: Record<number, number>;
};

/**
 * Validates and writes a lineup (formation + starting/bench split + bench
 * auto-sub order) to squad_players/squads - the part shared by saveLineup
 * (a normal, unlocked edit) and saveTeamForGameweek below (the same
 * write, plus locking it in as the official submission for a gameweek).
 * Doesn't redirect - callers decide what happens next.
 */
async function writeLineup(
  supabase: Supabase,
  userId: string,
  { squadId, formationCode, startingGamePlayerIds, benchOrder }: SaveLineupArgs
): Promise<{ error?: string; gameId?: number }> {
  const { data: squad } = await supabase
    .from("squads")
    .select("id, user_id, game_id")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== userId) return { error: "Squad not found." };

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
    .update({ is_starting: true, bench_order: null })
    .eq("squad_id", squadId)
    .in("game_player_id", startingGamePlayerIds);
  if (startError) return { error: startError.message };

  // Written per-player rather than one bulk update, since bench_order
  // differs per player (null for the reserve GK, 1/2/3 for the outfield
  // reserves) - the bench is always at most 4 players, so this is a
  // handful of extra round trips, not a real cost.
  const benchIds = Array.from(validIds).filter((id) => !startingSet.has(id));
  for (const benchId of benchIds) {
    const { error: benchError } = await supabase
      .from("squad_players")
      .update({ is_starting: false, bench_order: benchOrder?.[benchId] ?? null })
      .eq("squad_id", squadId)
      .eq("game_player_id", benchId);
    if (benchError) return { error: benchError.message };
  }

  return { gameId: squad.game_id };
}

/**
 * Sets which squad members start this gameweek (games with a bench,
 * e.g. FanTeam's 15-man squad / 11 starters). A normal, freely-editable
 * save - see saveTeamForGameweek below for the separate "this is my
 * final, locked-in submission" action.
 */
export async function saveLineup(args: SaveLineupArgs) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const result = await writeLineup(supabase, user.id, args);
  if (result.error) return result;

  redirect(`/squads/${args.squadId}`);
}

/**
 * "Save Team" - the same lineup write as saveLineup, plus locking it in
 * as the official submission for the current gameweek
 * (squad_gameweek_locks, migration 0043) and archiving Ask Mary's current
 * recommendation as one immutable prediction snapshot right at that
 * moment. Meant to be pressed once the user has actually locked their
 * team in on the real FanTeam site - this mirrors that real action inside
 * the app, rather than the old behaviour of re-archiving a fresh
 * "recommendation" on every idle Ask Mary / Performance Lab page view
 * (mostly noise from mid-tinkering, not genuine decisions - see migration
 * 0043's docstring). Upserts on (squad_id, gameweek), so pressing this
 * again before the real deadline updates the locked snapshot rather than
 * erroring - a reasonable "I changed my mind" path.
 */
export async function saveTeamForGameweek(args: SaveLineupArgs) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const writeResult = await writeLineup(supabase, user.id, args);
  if (writeResult.error) return writeResult;

  const gameweek = await getCurrentGameweek(supabase, writeResult.gameId!);
  if (gameweek === null) {
    return { error: "Lineup saved, but there's no published gameweek yet to lock this team in against." };
  }

  const { data: snapshot } = await supabase
    .from("squad_players")
    .select("game_player_id, is_starting, bench_order")
    .eq("squad_id", args.squadId);

  const { error: lockError } = await supabase
    .from("squad_gameweek_locks")
    .upsert(
      { squad_id: args.squadId, gameweek, lineup_snapshot: snapshot ?? [], locked_at: new Date().toISOString() },
      { onConflict: "squad_id,gameweek" }
    );
  if (lockError) return { error: lockError.message };

  const { data: squadRow } = await supabase
    .from("squads")
    .select(
      "id, name, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek, preferred_strategy, preferred_captain_horizon, is_scratch, fantasy_games(id, slug, display_name)"
    )
    .eq("id", args.squadId)
    .single();
  const game = squadRow?.fantasy_games as unknown as { id: number; slug: string; display_name: string } | undefined;
  // Scratch squads (migration 0059) never archive predictions - they
  // exist purely to test an alternative route, and Performance Lab's
  // grading should only ever reflect real decisions on real teams.
  if (squadRow && game?.slug === "fanteam" && !squadRow.is_scratch) {
    // Strategy is no longer user-selectable - always "balanced". Captain
    // horizon is no longer user-selectable either - runAskMaryAnalysis
    // itself always scores next-gameweek-only now (see askMaryEngine.ts).
    await runAskMaryAnalysis(
      supabase,
      {
        id: squadRow.id,
        name: squadRow.name,
        free_transfers: squadRow.free_transfers,
        wildcard_1_used_gameweek: squadRow.wildcard_1_used_gameweek,
        wildcard_2_used_gameweek: squadRow.wildcard_2_used_gameweek,
      },
      { id: game.id, display_name: game.display_name },
      "balanced" as Strategy,
      recordPredictions
    ).catch(() => null);
  }

  redirect(`/squads/${args.squadId}`);
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
 * Ownership, position-match, budget, and club-limit validation plus the
 * actual squad_players delete+insert - the part of a transfer that's
 * identical whether it's a normal swap (makeTransfer) or undoing one
 * (reverseTransfer, which just calls this with the roles reversed).
 * Extracted so those two don't duplicate the same ~40 lines of checks.
 */
async function performSwap(
  supabase: Supabase,
  squad: { id: number; game_id: number },
  outGamePlayerId: number,
  inGamePlayerId: number
): Promise<{ error?: string }> {
  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("budget, max_per_club")
    .eq("game_id", squad.game_id)
    .single();
  if (!rules) return { error: "No squad rules configured for this game." };

  const { data: squadPlayers } = await supabase
    .from("squad_players")
    .select("game_player_id, is_starting, game_players(price, position_code, players(position, team_id))")
    .eq("squad_id", squad.id);
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

  const { error: deleteError } = await supabase
    .from("squad_players")
    .delete()
    .eq("squad_id", squad.id)
    .eq("game_player_id", outGamePlayerId);
  if (deleteError) return { error: deleteError.message };

  const { error: insertError } = await supabase
    .from("squad_players")
    .insert({ squad_id: squad.id, game_player_id: inGamePlayerId, is_starting: outgoing.is_starting });
  if (insertError) return { error: insertError.message };

  return {};
}

type SquadForTransfer = {
  id: number;
  game_id: number;
  free_transfers: number;
  wildcard_1_used_gameweek: number | null;
  wildcard_2_used_gameweek: number | null;
};

/**
 * Executes a single sell/buy swap, enforcing FanTeam's real transfer
 * rules (see lib/transferEconomy.ts for the shared cost/wildcard-window
 * logic - this is the only place that actually writes the consequences).
 * The "+1 free transfer per gameweek" accrual itself isn't automated -
 * see migration 0022 - so free_transfers only ever goes down here, never
 * up, until that's built.
 *
 * Before the season actually starts (season's own gameweek-1 kickoff
 * hasn't passed yet), none of that applies - you're still building your
 * squad, not "using" a real transfer, so it's free and unlimited (and,
 * via reverseTransfer below, undoable).
 *
 * Extracted from makeTransfer (which now just calls this once and
 * redirects) so a multi-transfer bundle (applyRecommendation below) can
 * call it in a loop - makeTransfer's redirect() would otherwise abort a
 * loop after the first call, since a Next.js redirect throws to unwind
 * the stack.
 */
async function executeTransfer(
  supabase: Supabase,
  squad: SquadForTransfer,
  outGamePlayerId: number,
  inGamePlayerId: number,
  useWildcard: boolean | undefined
): Promise<{ error?: string; transferId?: number }> {
  const swapResult = await performSwap(supabase, squad, outGamePlayerId, inGamePlayerId);
  if (swapResult.error) return swapResult;

  // Cloud FF's real transfer rules (50 transfers/season total, one
  // "Overhaul" window, no points cost at all) don't fit this FanTeam-shaped
  // cost/wildcard model and there's no schema support for a season-total
  // cap yet - building a partial or guessed version would itself be
  // inventing rules. Skip cost/wildcard accounting entirely for cloudff
  // (legality - budget/formation/club-limit - is already fully enforced
  // above by performSwap, unconditionally) as a temporary compatibility
  // measure until the real model is scoped and built.
  const { data: game } = await supabase.from("fantasy_games").select("slug").eq("id", squad.game_id).single();
  const isCloudFF = game?.slug === "cloudff";

  // Transfer cost - only meaningful for games with a real gameweek
  // calendar (currently FanTeam). Games without one skip this entirely.
  const gameweek = await getCurrentGameweek(supabase, squad.game_id);
  let costPoints = 0;
  let usedWildcard = false;
  let newFreeTransfers = squad.free_transfers;
  const squadUpdate: Record<string, number> = {};

  if (gameweek !== null && !isCloudFF) {
    const { seasonStarted } = await getSeasonTiming(supabase, squad.game_id);

    if (seasonStarted) {
      const wildcardAlreadyActive = isWildcardActive(gameweek, squad.wildcard_1_used_gameweek, squad.wildcard_2_used_gameweek);

      if (wildcardAlreadyActive) {
        usedWildcard = true; // wildcard already active this gameweek from an earlier transfer
      } else if (useWildcard) {
        const window = wildcardWindowFor(gameweek);
        if (window === "wc1" && squad.wildcard_1_used_gameweek === null) {
          squadUpdate.wildcard_1_used_gameweek = gameweek;
        } else if (window === "wc2" && squad.wildcard_2_used_gameweek === null) {
          squadUpdate.wildcard_2_used_gameweek = gameweek;
        } else {
          return { error: "No wildcard is available to use this gameweek (wrong window or already used)." };
        }
        usedWildcard = true;
        newFreeTransfers = 0; // activating a wildcard resets banked free transfers
      } else if (squad.free_transfers > 0) {
        newFreeTransfers = squad.free_transfers - 1;
      } else {
        costPoints = TRANSFER_HIT_COST;
      }
    }
    // Pre-season: costPoints stays 0, free_transfers stays untouched -
    // unlimited, free transfers until the season actually kicks off.
  }

  if (gameweek !== null) {
    const { data: inserted, error: insertError } = await supabase
      .from("squad_transfers")
      .insert({
        squad_id: squad.id,
        gameweek,
        out_game_player_id: outGamePlayerId,
        in_game_player_id: inGamePlayerId,
        cost_points: costPoints,
        used_wildcard: usedWildcard,
      })
      .select("id")
      .single();
    if (insertError) return { error: insertError.message };
    const { error: updateError } = await supabase
      .from("squads")
      .update({ free_transfers: newFreeTransfers, ...squadUpdate })
      .eq("id", squad.id);
    if (updateError) return { error: updateError.message };
    return { transferId: inserted?.id };
  }

  return {};
}

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

  const result = await executeTransfer(supabase, squad, outGamePlayerId, inGamePlayerId, useWildcard);
  if (result.error) return result;

  redirect(`/squads/${squadId}`);
}

type ApplyRecommendationArgs = {
  squadId: number;
  transfers: { outGamePlayerId: number; inGamePlayerId: number }[];
  useWildcard?: boolean;
};

/**
 * Applies a Mary's Recommendations bundle (1-3 transfers, see
 * lib/askMaryEngine.ts) as one action - even a single-transfer
 * recommendation is a bundle of 1, so this is the one apply path both
 * the Ask Mary page and the Transfers page's compact panel use, not two.
 *
 * Re-fetches the squad fresh from DB (never trusts client state, since
 * the recommendation may have been generated a while before the user
 * clicked Apply) and re-validates the WHOLE bundle - cumulative budget,
 * position/quota counts, club limits - before executing anything, closing
 * the bug where two individually-affordable recommendations could each
 * look legal but not actually both be affordable together. Every swap in
 * a bundle is a same-position replacement (enforced by
 * findBuyCandidatesForOutgoing when the bundle was built), so
 * per-position counts are invariant across the bundle by construction -
 * no separate formation/quota check is needed beyond the existing
 * per-swap one inside performSwap.
 */
export async function applyRecommendation({ squadId, transfers, useWildcard }: ApplyRecommendationArgs) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (transfers.length === 0) return { error: "Nothing to apply." };

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

  const { data: squadPlayersRaw } = await supabase
    .from("squad_players")
    .select("game_player_id, game_players(price, players(position, team_id))")
    .eq("squad_id", squadId);
  if (!squadPlayersRaw) return { error: "Couldn't load squad." };
  type Row = { game_player_id: number; game_players: { price: number; players: { position: string; team_id: number } } };
  const currentRows = squadPlayersRaw as unknown as Row[];

  const outIds = transfers.map((t) => t.outGamePlayerId);
  const inIds = transfers.map((t) => t.inGamePlayerId);
  if (new Set(outIds).size !== outIds.length || new Set(inIds).size !== inIds.length) {
    return { error: "A bundle can't sell or buy the same player twice." };
  }
  for (const outId of outIds) {
    if (!currentRows.some((r) => r.game_player_id === outId)) return { error: "One of the players to sell isn't in this squad." };
  }
  for (const inId of inIds) {
    if (currentRows.some((r) => r.game_player_id === inId)) return { error: "One of the players to buy is already in this squad." };
  }

  const { data: incomingRows } = await supabase
    .from("game_players")
    .select("id, price, players(position, team_id)")
    .in("id", inIds);
  if (!incomingRows || incomingRows.length !== inIds.length) return { error: "One or more incoming players couldn't be found." };
  const incomingById = new Map(
    (incomingRows as unknown as { id: number; price: number; players: { position: string; team_id: number } }[]).map((r) => [r.id, r])
  );

  // Simulate the whole bundle against one working copy of the squad
  // before writing anything.
  let workingRows = currentRows.slice();
  for (const { outGamePlayerId, inGamePlayerId } of transfers) {
    const outgoing = workingRows.find((r) => r.game_player_id === outGamePlayerId);
    if (!outgoing) return { error: "One of the players to sell isn't in this squad." };
    const incoming = incomingById.get(inGamePlayerId)!;
    if (incoming.players.position !== outgoing.game_players.players.position) {
      return { error: "Every replacement in this recommendation must be the same position." };
    }
    workingRows = workingRows
      .filter((r) => r.game_player_id !== outGamePlayerId)
      .concat({ game_player_id: inGamePlayerId, game_players: { price: incoming.price, players: incoming.players } });
  }

  const finalTotal = workingRows.reduce((sum, r) => sum + Number(r.game_players.price), 0);
  if (finalTotal > Number(rules.budget)) {
    return { error: `This recommendation costs £${finalTotal.toFixed(1)}m in total, over the £${rules.budget}m budget.` };
  }
  if (rules.max_per_club) {
    const clubCounts = new Map<number, number>();
    for (const r of workingRows) {
      const teamId = r.game_players.players.team_id;
      clubCounts.set(teamId, (clubCounts.get(teamId) ?? 0) + 1);
    }
    for (const [, count] of clubCounts) {
      if (count > rules.max_per_club) return { error: `Max ${rules.max_per_club} players allowed from the same club.` };
    }
  }

  // Whole bundle is jointly legal - execute sequentially, re-reading
  // free-transfer/wildcard state fresh each iteration so consumption
  // across multiple transfers in one gameweek falls out correctly. If a
  // later leg fails (e.g. a genuine concurrent edit between the joint
  // validation above and now), undo every already-completed leg rather
  // than leaving the squad half-applied - a partial bundle would be a
  // more confusing state than the single-transfer failure this feature
  // was built to fix.
  //
  // Execution order matters even though the bundle as a whole is
  // affordable: each leg is written one at a time, and performSwap
  // re-checks budget against whatever's in the DB at that instant - a
  // budget-pooled recommendation (see askMaryEngine.ts's paired-transfer
  // search, e.g. selling a premium to help fund a bigger signing
  // elsewhere) can have one leg that needs more money than it alone
  // frees, funded by another leg's sale. Applying that purchase leg
  // before its funding sale would transiently blow the budget even
  // though the fully-applied bundle doesn't. Sorting every leg by its
  // own price delta (incoming - outgoing) ascending - biggest
  // budget-freeing sells first, biggest budget-consuming buys last -
  // guarantees no intermediate step ever exceeds budget: sorting a
  // sequence of deltas ascending minimizes every prefix sum, so since the
  // starting total and the fully-applied total are both already known to
  // be within budget (checked above), every point in between is too.
  const outgoingPriceById = new Map(currentRows.map((r) => [r.game_player_id, Number(r.game_players.price)]));
  const orderedTransfers = transfers.slice().sort((a, b) => {
    const deltaA = Number(incomingById.get(a.inGamePlayerId)!.price) - (outgoingPriceById.get(a.outGamePlayerId) ?? 0);
    const deltaB = Number(incomingById.get(b.inGamePlayerId)!.price) - (outgoingPriceById.get(b.outGamePlayerId) ?? 0);
    return deltaA - deltaB;
  });

  const completed: { outGamePlayerId: number; inGamePlayerId: number; transferId?: number }[] = [];
  let workingSquad: SquadForTransfer = squad;
  for (const { outGamePlayerId, inGamePlayerId } of orderedTransfers) {
    const result = await executeTransfer(supabase, workingSquad, outGamePlayerId, inGamePlayerId, useWildcard);
    if (result.error) {
      await rollbackCompletedTransfers(supabase, squad, completed);
      return { error: `${result.error} The rest of this recommendation wasn't applied.` };
    }
    completed.push({ outGamePlayerId, inGamePlayerId, transferId: result.transferId });

    const { data: refreshed } = await supabase
      .from("squads")
      .select("id, game_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek")
      .eq("id", squadId)
      .single();
    if (!refreshed) {
      await rollbackCompletedTransfers(supabase, squad, completed);
      return { error: "Lost track of the squad mid-transfer - the recommendation wasn't applied." };
    }
    workingSquad = refreshed;
  }

  redirect(`/squads/${squadId}`);
}

/**
 * Undoes every leg in `completed`, most recent first, by swapping each
 * back (performSwap with roles reversed, same idea as reverseTransfer)
 * and deleting its squad_transfers row, then restores the squad's
 * free-transfer/wildcard bookkeeping to what it was before the bundle
 * started - `squad` here is the pre-bundle snapshot, not the current row.
 */
async function rollbackCompletedTransfers(
  supabase: Supabase,
  squad: SquadForTransfer,
  completed: { outGamePlayerId: number; inGamePlayerId: number; transferId?: number }[]
) {
  for (const leg of completed.slice().reverse()) {
    await performSwap(supabase, squad, leg.inGamePlayerId, leg.outGamePlayerId);
    if (leg.transferId != null) {
      await supabase.from("squad_transfers").delete().eq("id", leg.transferId);
    }
  }
  if (completed.length > 0) {
    await supabase
      .from("squads")
      .update({
        free_transfers: squad.free_transfers,
        wildcard_1_used_gameweek: squad.wildcard_1_used_gameweek,
        wildcard_2_used_gameweek: squad.wildcard_2_used_gameweek,
      })
      .eq("id", squad.id);
  }
}

type ReverseTransferArgs = {
  squadId: number;
  transferId: number;
};

/**
 * Undoes a logged transfer - only while the season hasn't started (see
 * makeTransfer above), since that's the only window where transfers are
 * free/unlimited and there's no real-transfer bookkeeping to preserve.
 * Reuses performSwap with the roles reversed, then deletes the log row
 * entirely (a true undo, not a new logged transfer).
 */
export async function reverseTransfer({ squadId, transferId }: ReverseTransferArgs) {
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

  const { seasonStarted } = await getSeasonTiming(supabase, squad.game_id);
  if (seasonStarted) return { error: "Transfers can only be reversed before the season starts." };

  const { data: transfer } = await supabase
    .from("squad_transfers")
    .select("id, out_game_player_id, in_game_player_id")
    .eq("id", transferId)
    .eq("squad_id", squadId)
    .single();
  if (!transfer) return { error: "Transfer not found." };

  const { data: currentlyIn } = await supabase
    .from("squad_players")
    .select("game_player_id")
    .eq("squad_id", squadId)
    .eq("game_player_id", transfer.in_game_player_id)
    .maybeSingle();
  if (!currentlyIn) {
    return { error: "Can't reverse - that player is no longer in your squad (transferred out again since)." };
  }

  const swapResult = await performSwap(supabase, squad, transfer.in_game_player_id, transfer.out_game_player_id);
  if (swapResult.error) return swapResult;

  await supabase.from("squad_transfers").delete().eq("id", transferId);

  redirect(`/squads/${squadId}`);
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

  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
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

  // Mary Performance Lab extension - squads only stores the CURRENT
  // captain, so log every choice with its gameweek into its own history
  // (squad_captain_history, migration 0036) - otherwise a past captain
  // prediction becomes ungradeable once a later gameweek's pick
  // overwrites it. Same reasoning as squad_transfers existing alongside
  // squads' own current-state columns.
  const gameweek = await getCurrentGameweek(supabase, squad.game_id);
  await supabase.from("squad_captain_history").insert({
    squad_id: squadId,
    gameweek,
    captain_game_player_id: captainGamePlayerId,
    vice_captain_game_player_id: viceCaptainGamePlayerId,
  });

  redirect(`/squads/${squadId}`);
}

/**
 * Auto Import My Squad - "Sync Now" button (see migration 0071). This
 * NEVER touches a provider credential or calls a provider's API itself -
 * by design, only scripts/sync_provider_squads.py (server-side, holding
 * PROVIDER_SECRETS_KEY) ever does that. All this does is set
 * sync_requested_at, which a scheduled job (running every few minutes,
 * same cadence as the golf live-score poller) picks up and clears once
 * it's actually processed the request. RLS's "own provider squad links
 * request sync" policy is the real enforcement here - this update simply
 * can't touch a link that isn't the signed-in user's own squad.
 */
export async function requestProviderSync({ squadId }: { squadId: number }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to sync your squad." };

  const { data: link } = await supabase.from("provider_squad_links").select("id, squad_id").eq("squad_id", squadId).maybeSingle();
  if (!link) return { error: "This squad isn't linked to a provider yet." };

  const { error } = await supabase.from("provider_squad_links").update({ sync_requested_at: new Date().toISOString() }).eq("id", link.id);
  if (error) return { error: error.message };

  revalidatePath(`/squads/${squadId}`);
  return { success: true as const };
}
