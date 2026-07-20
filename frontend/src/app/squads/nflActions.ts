"use server";

import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

const NFL_POSITIONS = ["QB", "RB", "WR", "TE", "DST"] as const;

/**
 * NFL FanTeam-specific squad save/edit - parallels saveSquad/
 * updateSquadPlayers in actions.ts but for NFL's quota shape (QB/RB/WR/TE/
 * DST quota columns rather than GK/DEF/MID/FWD) and its lack of a
 * formations/bench concept: squad_size === starting_size always, so every
 * saved player is a starter with no computeStartingSplit step needed.
 * Kept in its own file rather than added to actions.ts's existing
 * soccer-position-hardcoded validation loops, which are load-bearing for
 * two already-shipped games - see the NFL FanTeam Stage 3 plan for why a
 * parallel file was chosen over genericizing those loops.
 */
async function validateNflSquad(
  supabase: Awaited<ReturnType<typeof createAuthServerClient>>,
  gameId: number,
  gamePlayerIds: number[]
) {
  const { data: rules } = await supabase.from("game_squad_rules").select("*").eq("game_id", gameId).single();
  if (!rules) return { error: "No squad rules configured for this game." } as const;

  const { data: players } = await supabase
    .from("game_players")
    .select("id, price, player_id, players(position, team_id)")
    .eq("game_id", gameId)
    .in("id", gamePlayerIds);

  if (!players || players.length !== gamePlayerIds.length) {
    return { error: "One or more selected players couldn't be found." } as const;
  }
  if (players.length !== rules.squad_size) {
    return { error: `Squad must have exactly ${rules.squad_size} players (got ${players.length}).` } as const;
  }

  const totalPrice = players.reduce((sum, p) => sum + Number(p.price), 0);
  if (totalPrice > Number(rules.budget)) {
    return { error: `Squad costs £${totalPrice.toFixed(1)}m, over the £${rules.budget}m budget.` } as const;
  }

  const counts: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, DST: 0 };
  const clubCounts = new Map<number, number>();
  for (const p of players) {
    const position = (p.players as unknown as { position: string; team_id: number }).position;
    const teamId = (p.players as unknown as { position: string; team_id: number }).team_id;
    counts[position] = (counts[position] ?? 0) + 1;
    clubCounts.set(teamId, (clubCounts.get(teamId) ?? 0) + 1);
  }

  const quota = { QB: rules.qb_quota, RB: rules.rb_quota, WR: rules.wr_quota, TE: rules.te_quota, DST: rules.dst_quota };
  for (const pos of NFL_POSITIONS) {
    if (counts[pos] !== quota[pos]) {
      return { error: `Need exactly ${quota[pos]} ${pos}, got ${counts[pos]}.` } as const;
    }
  }

  if (rules.max_per_club) {
    for (const [, count] of clubCounts) {
      if (count > rules.max_per_club) {
        return { error: `Max ${rules.max_per_club} players allowed from the same team.` } as const;
      }
    }
  }

  return { rules } as const;
}

export async function saveNflSquad({ gamePlayerIds, name }: { gamePlayerIds: number[]; name: string }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "nfl-fanteam").single();
  if (!game) return { error: "Unknown game." };

  const validation = await validateNflSquad(supabase, game.id, gamePlayerIds);
  if ("error" in validation) return validation;

  const { data: squad, error: squadError } = await supabase
    .from("squads")
    .insert({ user_id: user.id, game_id: game.id, name })
    .select("id")
    .single();
  if (squadError || !squad) return { error: squadError?.message ?? "Failed to create squad." };

  const { error: playersError } = await supabase.from("squad_players").insert(
    gamePlayerIds.map((gamePlayerId) => ({ squad_id: squad.id, game_player_id: gamePlayerId, is_starting: true }))
  );
  if (playersError) return { error: playersError.message };

  redirect("/squads");
}

export async function updateNflSquadPlayers({ squadId, gamePlayerIds }: { squadId: number; gamePlayerIds: number[] }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: squad } = await supabase.from("squads").select("id, user_id, game_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id) return { error: "Squad not found." };

  const validation = await validateNflSquad(supabase, squad.game_id, gamePlayerIds);
  if ("error" in validation) return validation;

  const { data: currentRows } = await supabase.from("squad_players").select("game_player_id").eq("squad_id", squadId);
  const currentIds = new Set((currentRows ?? []).map((r) => r.game_player_id));
  const newIds = new Set(gamePlayerIds);

  const toRemove = Array.from(currentIds).filter((id) => !newIds.has(id));
  const toAdd = Array.from(newIds).filter((id) => !currentIds.has(id));

  if (toRemove.length > 0) {
    const { error } = await supabase.from("squad_players").delete().eq("squad_id", squadId).in("game_player_id", toRemove);
    if (error) return { error: error.message };
  }
  if (toAdd.length > 0) {
    const { error } = await supabase.from("squad_players").insert(
      toAdd.map((gamePlayerId) => ({ squad_id: squadId, game_player_id: gamePlayerId, is_starting: true }))
    );
    if (error) return { error: error.message };
  }

  redirect("/squads");
}
