"use server";

import { createAuthServerClient } from "./supabaseServerClient";
import { createServiceSupabaseClient } from "./supabaseServiceClient";

/**
 * Team Strength admin page (2026-08-27 user request - "maybe we should
 * build our own adjustable fixture difficulty scale... for when form
 * alters throughout the season... when adjusted and saved it should
 * recompute all our projections"). Premier League only by design - see
 * scripts/compute_fixture_strength_probabilities.py's own docstring:
 * Championship/League One/League Two already get a real, frequently-
 * refreshed FDR straight from fantasy.efl.com (import_eflfantasy.py's
 * seed_team_strength), so there's nothing to adjust there.
 *
 * Reuses the exact 1-5 rating scale and to_strength() conversion the
 * user already transcribed once, by hand, in
 * scripts/set_manual_pl_fixture_strength.py - same convention Fantasy
 * Premier League itself uses, not a raw -1..1 number nobody has
 * intuition for. Saving writes manual_strength_override (migration
 * 0151) - which now wins over that script's own home_strength/
 * away_strength columns too, see compute_fixture_strength_
 * probabilities.py's 2026-08-27 fix - then dispatches the new
 * team_strength_adjusted.yml workflow for exactly the 3 real games a
 * Premier League team's strength affects (never eflfantasy, which has
 * its own real source and would just waste a recompute).
 */

const GITHUB_REPO = "HailMaryV1/hail-mary-fantasy";
const GITHUB_TEAM_STRENGTH_WORKFLOW = "team_strength_adjusted.yml";
const PL_SEASON = "2026/27";
const PL_SOURCE = "user_manual_fdr_2026-08-07";
const AFFECTED_GAME_SLUGS = ["dreamteam", "fanteam", "cloudff"] as const;

export type TeamStrengthRow = {
  teamId: number;
  teamName: string;
  // Automated baseline actually in effect today (home_strength/
  // away_strength, converted back to the familiar 1-5 scale) - shown
  // read-only for context so an override always reads as a delta from
  // something real, not a number out of nowhere.
  baselineHomeRating: number;
  baselineAwayRating: number;
  // null when no override is set (baseline is in effect).
  overrideRating: number | null;
};

function toRating(strength: number): number {
  return strength * 2 + 3;
}

function toStrength(rating: number): number {
  return (rating - 3) / 2;
}

async function requireSignedIn(): Promise<{ error: string } | null> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? null : { error: "Not signed in." };
}

export async function listPremierLeagueTeamStrength(): Promise<TeamStrengthRow[]> {
  const supabase = await createAuthServerClient();
  const { data } = await supabase
    .from("team_season_strength")
    .select("team_id, home_strength, away_strength, manual_strength_override, teams!inner(name)")
    .eq("season", PL_SEASON)
    .eq("source", PL_SOURCE)
    .returns<{ team_id: number; home_strength: number; away_strength: number; manual_strength_override: number | null; teams: { name: string } }[]>();

  return (data ?? [])
    .map((row) => ({
      teamId: row.team_id,
      teamName: row.teams.name,
      baselineHomeRating: toRating(Number(row.home_strength)),
      baselineAwayRating: toRating(Number(row.away_strength)),
      overrideRating: row.manual_strength_override != null ? toRating(Number(row.manual_strength_override)) : null,
    }))
    .sort((a, b) => a.teamName.localeCompare(b.teamName));
}

async function dispatchTeamStrengthRecompute(gameSlug: string, token: string): Promise<{ dispatched: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_TEAM_STRENGTH_WORKFLOW}/dispatches`, {
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
      return { dispatched: false, error: `GitHub API ${res.status}: ${body}` };
    }
    return { dispatched: true };
  } catch (e) {
    return { dispatched: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveTeamStrengthOverride(teamId: number, rating1to5: number | null): Promise<{ saved: boolean; error?: string }> {
  const authError = await requireSignedIn();
  if (authError) return { saved: false, error: authError.error };

  if (rating1to5 !== null && (!Number.isFinite(rating1to5) || rating1to5 < 1 || rating1to5 > 5)) {
    return { saved: false, error: "Rating must be between 1 and 5." };
  }

  const service = createServiceSupabaseClient();
  const { error: writeError } = await service
    .from("team_season_strength")
    .update({
      manual_strength_override: rating1to5 !== null ? toStrength(rating1to5) : null,
      manual_strength_updated_at: rating1to5 !== null ? new Date().toISOString() : null,
    })
    .eq("team_id", teamId)
    .eq("season", PL_SEASON)
    .eq("source", PL_SOURCE);
  if (writeError) return { saved: false, error: writeError.message };

  const token = process.env.GITHUB_ACTIONS_TOKEN;
  if (!token) return { saved: true, error: "Saved, but GITHUB_ACTIONS_TOKEN isn't configured - recompute wasn't triggered." };

  const results = await Promise.all(AFFECTED_GAME_SLUGS.map((slug) => dispatchTeamStrengthRecompute(slug, token)));
  const failed = results.filter((r) => !r.dispatched);
  if (failed.length > 0) {
    return { saved: true, error: `Saved, but recompute failed to trigger for ${failed.length} of ${AFFECTED_GAME_SLUGS.length} game(s): ${failed.map((f) => f.error).join("; ")}` };
  }
  return { saved: true };
}
