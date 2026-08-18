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
