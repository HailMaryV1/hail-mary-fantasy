"use server";

import { createAuthServerClient } from "./supabaseServerClient";
import { fetchEngineExplanation, type EngineExplanation } from "./engineExplainability";
import { getPlayerProjectionTrend, type TrendPoint } from "./projectionTrend";

/**
 * On-demand fetch for one player's full projection breakdown (bookmaker
 * intelligence, fixture model, recent form, opportunity model - see
 * engineExplainability.ts) - a server action rather than something baked
 * into the board's initial page load, deliberately: the `inputs` JSON blob
 * behind this is heavy, and fetching it for the whole pool just so ONE
 * player's info panel can show it later would undo the fetch-parallelization
 * and pagination work already done to keep the board's initial load light.
 * Shared across every game with the modular engine (fanteam, dreamteam) -
 * same read pattern engineExplainability.ts's own fetchEngineExplanation
 * already generalizes over gameSlug.
 */
export async function getPlayerExplanation(gameSlug: string, gamePlayerId: number): Promise<EngineExplanation | null> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return fetchEngineExplanation(supabase, gameSlug, gamePlayerId);
}

/**
 * On-demand fetch for a player's projected-points trend across their
 * next few gameweeks (real user request 2026-08-18) - a second,
 * separate action rather than folded into getPlayerExplanation above,
 * same "don't fetch it until the panel that shows it is actually open"
 * reasoning that action's own docstring already gives, and this needs
 * `fromGameweek` (the player's own currently-viewed gameweek) which only
 * the caller knows once getPlayerExplanation's result is in.
 */
export async function getPlayerProjectionTrendAction(gamePlayerId: number, fromGameweek: number, count = 5): Promise<TrendPoint[]> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  return getPlayerProjectionTrend(supabase, gamePlayerId, fromGameweek, count);
}

export type PlayerRealStats = {
  totalPoints: number | null;
  appearances: number | null;
  goals: number | null;
  assists: number | null;
  cleanSheets: number | null;
  saves: number | null;
  tackles: number | null;
  clearances: number | null;
  blocks: number | null;
  interceptions: number | null;
  keyPasses: number | null;
  shotsOnTarget: number | null;
  lastGw: number | null;
  lastGwPoints: number | null;
};

/**
 * On-demand fetch for a player's real (not projected) stats this season -
 * 2026-08-19 user request, mirroring fantasy.efl.com's own player popup
 * ("Recent Gameweeks" points + a tackles/clearances/blocks/interceptions/
 * key passes breakdown). Reads game_player_pool directly (see migration
 * 0121) rather than going back to game_player_stats itself - the view
 * already does the "most recent real snapshot" resolution once, no need
 * for a second copy of that logic here. Same lazy-on-open pattern as
 * getPlayerExplanation above - this data has no reason to load for the
 * whole pool up front.
 */
export async function getPlayerRealStatsAction(gamePlayerId: number): Promise<PlayerRealStats | null> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("game_player_pool")
    .select(
      "real_total_points, real_appearances, real_goals, real_assists, real_clean_sheets, real_saves, real_tackles, real_clearances, real_blocks, real_interceptions, real_key_passes, real_shots_on_target, last_gw, last_gw_points"
    )
    .eq("game_player_id", gamePlayerId)
    .maybeSingle();
  if (error || !data) return null;

  return {
    totalPoints: data.real_total_points != null ? Number(data.real_total_points) : null,
    appearances: data.real_appearances,
    goals: data.real_goals,
    assists: data.real_assists,
    cleanSheets: data.real_clean_sheets,
    saves: data.real_saves,
    tackles: data.real_tackles,
    clearances: data.real_clearances,
    blocks: data.real_blocks,
    interceptions: data.real_interceptions,
    keyPasses: data.real_key_passes,
    shotsOnTarget: data.real_shots_on_target,
    lastGw: data.last_gw,
    lastGwPoints: data.last_gw_points != null ? Number(data.last_gw_points) : null,
  };
}
