"use server";

import { createAuthServerClient } from "./supabaseServerClient";

export type TargetScoreWindowFixture = {
  opponentTeamName: string | null;
  isHome: boolean | null;
  kickoffAt: string | null;
  difficultyRaw: number | null;
  gameweek: number | null;
  // A projected cup/Europe fixture (2026-08-27 user report - Dream Team
  // Tonic's own fixture ticker shows a real double gameweek's second
  // leg before we know the opponent - see compute_target_scores.py's
  // fetch_window_projected_fixtures) - opponent/kickoff/difficulty are
  // deliberately null for these, never fabricated. competition names
  // which one (via engineExplainability.ts's competitionLabel);
  // confidence is 1.0 (TBA - date confirmed) or 0.5 (IF - contingent on
  // cup progression).
  isProjected: boolean;
  competition: string | null;
  confidence: number | null;
};

export type TargetScoreWindow = {
  startGameweek: number;
  endGameweek: number;
  // The SAME composite/sub-ratings the rankings list and the
  // downloadable card show (2026-08-27 user report: PlayerInfoPanel's
  // own headline "Hail Mary Rating" was actually the single-gameweek
  // rating, not this window's Target Score - the two are genuinely
  // different numbers, but nothing here let the panel show the one
  // that matches whatever list the player was opened from).
  targetScore: number;
  formRating: number | null;
  fixtureDifficultyRating: number | null;
  fixtureQuantityRating: number | null;
  liveOddsRating: number | null;
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
    .select("start_gameweek, end_gameweek, target_score, form_rating, fixture_difficulty_rating, fixture_quantity_rating, live_odds_rating, inputs")
    .eq("game_player_id", gamePlayerId)
    .eq("horizon", horizon)
    .eq("start_gameweek", gameweek)
    .maybeSingle<{
      start_gameweek: number;
      end_gameweek: number;
      target_score: number;
      form_rating: number | null;
      fixture_difficulty_rating: number | null;
      fixture_quantity_rating: number | null;
      live_odds_rating: number | null;
      inputs: {
        window_fixtures?: {
          opponent_team_name: string | null;
          is_home: boolean | null;
          kickoff_at: string | null;
          difficulty_raw: number | null;
          gameweek: number | null;
          is_projected?: boolean;
          competition?: string | null;
          confidence?: number | null;
        }[];
      };
    }>();
  if (!data) return null;

  return {
    startGameweek: data.start_gameweek,
    endGameweek: data.end_gameweek,
    targetScore: Number(data.target_score),
    formRating: data.form_rating,
    fixtureDifficultyRating: data.fixture_difficulty_rating,
    fixtureQuantityRating: data.fixture_quantity_rating,
    liveOddsRating: data.live_odds_rating,
    // Real fixture order (2026-08-27 user report - "the fixtures are not
    // in order") - window_fixtures' own storage order isn't chronological
    // (confirmed live, fetch_window_fixture_rows has no ORDER BY), same
    // fix already applied to the downloadable card's own secondary
    // fixture list (playerCard.ts). Sorted by gameweek first, not just
    // kickoff - a projected TBA/IF entry has no real kickoff to sort by,
    // so a kickoff-only sort would dump every one of them at the very
    // top regardless of which week they're actually in.
    fixtures: (data.inputs?.window_fixtures ?? [])
      .map((f) => ({
        opponentTeamName: f.opponent_team_name,
        isHome: f.is_home,
        kickoffAt: f.kickoff_at,
        difficultyRaw: f.difficulty_raw,
        gameweek: f.gameweek,
        isProjected: f.is_projected ?? false,
        competition: f.competition ?? null,
        confidence: f.confidence ?? null,
      }))
      .sort((a, b) => (a.gameweek ?? 0) - (b.gameweek ?? 0) || (a.kickoffAt ?? "").localeCompare(b.kickoffAt ?? "")),
  };
}

export type TargetScorePoolRow = {
  gamePlayerId: number;
  fullName: string;
  position: string;
  teamId: number;
  teamName: string;
  price: number;
  ownershipPct: number | null;
  displayedRating: number | null;
  formRating: number | null;
  fixtureDifficultyRating: number | null;
  fixtureQuantityRating: number | null;
  liveOddsRating: number | null;
  realTotalPoints: number | null;
  windowFixtures: TargetScoreWindowFixture[];
  endGameweek: number | null;
};

export type TargetScorePoolSortBy = "rating" | "owned" | "price" | "real_pts";

/**
 * Paginated, filterable browse over the RATED pool for a horizon - the
 * Target Score equivalent of poolSearch.ts's searchPool, powering
 * RatingsBrowseTable's own filters (2026-08-26 user request: "I should
 * be able to check boxes that narrows the players down to what im
 * after... a 9 or 10 rated defender for the next 3 gameweeks that is
 * under 20% owned" + "add the price points too"). Wraps
 * search_target_score_pool (migration 0147/0148) - a NEW RPC, not an
 * extension of search_game_player_pool (that one's shared by every
 * squad board's own pool tab, a much larger blast radius than this
 * page alone - see that migration's own docstring).
 */
export async function searchTargetScorePool(params: {
  gameSlug: string;
  gameweek: number;
  horizon: number;
  position?: string | null;
  teamName?: string | null;
  search?: string | null;
  minRating?: number | null;
  maxRating?: number | null;
  minOwned?: number | null;
  maxOwned?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  sortBy?: TargetScorePoolSortBy;
  excludeClub?: boolean;
  page: number;
  pageSize: number;
}): Promise<{ rows: TargetScorePoolRow[]; totalCount: number }> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { rows: [], totalCount: 0 };

  const { data, error } = await supabase.rpc("search_target_score_pool", {
    p_game_slug: params.gameSlug,
    p_gameweek: params.gameweek,
    p_horizon: params.horizon,
    p_position: params.position ?? null,
    p_team_name: params.teamName ?? null,
    p_search: params.search && params.search.trim() !== "" ? params.search.trim() : null,
    p_min_rating: params.minRating ?? null,
    p_max_rating: params.maxRating ?? null,
    p_min_owned: params.minOwned ?? null,
    p_max_owned: params.maxOwned ?? null,
    p_min_price: params.minPrice ?? null,
    p_max_price: params.maxPrice ?? null,
    p_sort_by: params.sortBy ?? "rating",
    p_exclude_club: params.excludeClub ?? false,
    p_limit: params.pageSize,
    p_offset: (params.page - 1) * params.pageSize,
  });
  if (error || !data) return { rows: [], totalCount: 0 };

  type RpcRow = {
    game_player_id: number;
    full_name: string;
    position: string;
    team_id: number;
    team_name: string;
    price: number | string;
    ownership_pct: number | string | null;
    displayed_rating: number | null;
    form_rating: number | null;
    fixture_difficulty_rating: number | null;
    fixture_quantity_rating: number | null;
    live_odds_rating: number | null;
    real_total_points: number | string | null;
    window_fixtures:
      | {
          opponent_team_name: string | null;
          is_home: boolean | null;
          kickoff_at: string | null;
          difficulty_raw: number | null;
          gameweek: number | null;
          is_projected?: boolean;
          competition?: string | null;
          confidence?: number | null;
        }[]
      | null;
    end_gameweek: number | null;
    total_count: number | string;
  };
  const rpcRows = data as RpcRow[];
  const rows: TargetScorePoolRow[] = rpcRows.map((r) => ({
    gamePlayerId: r.game_player_id,
    fullName: r.full_name,
    position: r.position,
    teamId: r.team_id,
    teamName: r.team_name,
    price: Number(r.price),
    ownershipPct: r.ownership_pct != null ? Number(r.ownership_pct) : null,
    displayedRating: r.displayed_rating,
    formRating: r.form_rating,
    fixtureDifficultyRating: r.fixture_difficulty_rating,
    fixtureQuantityRating: r.fixture_quantity_rating,
    liveOddsRating: r.live_odds_rating,
    realTotalPoints: r.real_total_points != null ? Number(r.real_total_points) : null,
    // Real fixture order - window_fixtures' own storage order isn't
    // chronological (see getPlayerTargetScoreWindow above; same real
    // bug hit Browse All Players' own fixture pills, confirmed live:
    // "Charlton Athletic" showing twice out of order for a duplicated
    // fixture, now fixed at the source in dedupe_fixture_reissues.py).
    windowFixtures: (r.window_fixtures ?? [])
      .map((f) => ({
        opponentTeamName: f.opponent_team_name,
        isHome: f.is_home,
        kickoffAt: f.kickoff_at,
        difficultyRaw: f.difficulty_raw,
        gameweek: f.gameweek,
        isProjected: f.is_projected ?? false,
        competition: f.competition ?? null,
        confidence: f.confidence ?? null,
      }))
      .sort((a, b) => (a.gameweek ?? 0) - (b.gameweek ?? 0) || (a.kickoffAt ?? "").localeCompare(b.kickoffAt ?? "")),
    endGameweek: r.end_gameweek,
  }));
  const totalCount = rpcRows.length > 0 ? Number(rpcRows[0].total_count) : 0;
  return { rows, totalCount };
}
