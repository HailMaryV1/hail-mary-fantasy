"use server";

import { createAuthServerClient } from "./supabaseServerClient";

export type TargetScoreWindowFixture = {
  opponentTeamName: string | null;
  isHome: boolean;
  kickoffAt: string | null;
  difficultyRaw: number | null;
};

export type TargetScoreWindow = {
  startGameweek: number;
  endGameweek: number;
  fixtures: TargetScoreWindowFixture[];
};

/**
 * On-demand fetch of a player's REAL fixture window for the horizon
 * currently selected on /ratings (2026-08-26 user request - "verbruggen
 * player info should show the 3 fixtures... use the difficulty pills
 * with differing colours too"). PlayerInfoPanel's own `data.primaryFixture`
 * is always just the single nearest fixture regardless of horizon (the
 * same field every other board also reads) - this reads target_scores.
 * inputs.window_fixtures instead, the exact per-fixture list + position-
 * weighted difficulty compute_target_scores.py already computed for
 * this player/horizon/anchor-gameweek, so the panel and the downloadable
 * card (api/player-card/route.tsx, same table/row) never disagree.
 * Same lazy-on-open pattern as getPlayerExplanation - only fetched once
 * a player is actually clicked, not for the whole top-5 list up front.
 */
export async function getPlayerTargetScoreWindow(
  gamePlayerId: number,
  gameweek: number,
  horizon: number
): Promise<TargetScoreWindow | null> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("target_scores")
    .select("start_gameweek, end_gameweek, inputs")
    .eq("game_player_id", gamePlayerId)
    .eq("horizon", horizon)
    .eq("start_gameweek", gameweek)
    .maybeSingle<{
      start_gameweek: number;
      end_gameweek: number;
      inputs: {
        window_fixtures?: { opponent_team_name: string | null; is_home: boolean; kickoff_at: string | null; difficulty_raw: number | null }[];
      };
    }>();
  if (!data) return null;

  return {
    startGameweek: data.start_gameweek,
    endGameweek: data.end_gameweek,
    fixtures: (data.inputs?.window_fixtures ?? []).map((f) => ({
      opponentTeamName: f.opponent_team_name,
      isHome: f.is_home,
      kickoffAt: f.kickoff_at,
      difficultyRaw: f.difficulty_raw,
    })),
  };
}
