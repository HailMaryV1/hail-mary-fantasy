"use server";

import { createAuthServerClient } from "./supabaseServerClient";
import { createServiceSupabaseClient } from "./supabaseServiceClient";

/**
 * "Update Odds" button (2026-08-08 user request) - shared across every
 * game's page, not per-game, since the underlying mechanism is
 * identical for all four (only the game_slug parameter changes) and
 * the odds sources it refreshes are game-independent by construction
 * (bookmaker_player_features/fixture_probabilities etc. have no game_id
 * at all - see scripts/refresh_odds_for_game.py). Same workflow_dispatch
 * pattern already proven by golf's dispatchGolfCompute
 * (frontend-v2/src/app/golf/import/actions.ts).
 */

const GITHUB_REPO = "HailMaryV1/hail-mary-fantasy";
const GITHUB_ODDS_REFRESH_WORKFLOW = "odds_refresh_requested.yml";

export type OddsRefreshStatus = {
  status: "idle" | "running" | "ok" | "error";
  requestedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
};

async function requireSignedIn(): Promise<{ error: string } | null> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? null : { error: "Not signed in." };
}

export async function getOddsRefreshStatus(gameSlug: string): Promise<OddsRefreshStatus | null> {
  const supabase = await createAuthServerClient();
  const { data } = await supabase
    .from("odds_refresh_status")
    .select("status, requested_at, completed_at, error_message, fantasy_games!inner(slug)")
    .eq("fantasy_games.slug", gameSlug)
    .maybeSingle();
  if (!data) return null;
  return {
    status: data.status as OddsRefreshStatus["status"],
    requestedAt: data.requested_at,
    completedAt: data.completed_at,
    errorMessage: data.error_message,
  };
}

export async function dispatchOddsRefresh(gameSlug: string): Promise<{ dispatched: boolean; error?: string }> {
  const authError = await requireSignedIn();
  if (authError) return { dispatched: false, error: authError.error };

  const token = process.env.GITHUB_ACTIONS_TOKEN;
  if (!token) return { dispatched: false, error: "GITHUB_ACTIONS_TOKEN not configured" };

  // Marked 'running' here, immediately, rather than waiting for the
  // workflow to actually start - GitHub Actions queue time means the
  // real job can take tens of seconds to even begin, and the button
  // should show "in progress" from the moment the user clicks it, not
  // once the runner happens to pick up the job. Same reasoning as
  // provider_squad_links.sync_requested_at (migration 0071). Service
  // client, not the anon one - odds_refresh_status is reference-shaped
  // data (one row per game), not user-owned, same precedent as the golf
  // tournament importer's own writes (see supabaseServiceClient.ts).
  const service = createServiceSupabaseClient();
  const { data: game } = await service.from("fantasy_games").select("id").eq("slug", gameSlug).maybeSingle();
  if (!game) return { dispatched: false, error: `Unknown game slug: ${gameSlug}` };
  await service
    .from("odds_refresh_status")
    .update({ status: "running", requested_at: new Date().toISOString(), completed_at: null, error_message: null })
    .eq("game_id", game.id);

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_ODDS_REFRESH_WORKFLOW}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { game_slug: gameSlug } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      await service.from("odds_refresh_status").update({ status: "error", error_message: `GitHub API ${res.status}`, completed_at: new Date().toISOString() }).eq("game_id", game.id);
      return { dispatched: false, error: `GitHub API ${res.status}: ${body}` };
    }
    return { dispatched: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await service.from("odds_refresh_status").update({ status: "error", error_message: message, completed_at: new Date().toISOString() }).eq("game_id", game.id);
    return { dispatched: false, error: message };
  }
}
