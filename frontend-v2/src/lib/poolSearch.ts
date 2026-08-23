"use server";

import { createAuthServerClient } from "./supabaseServerClient";
import type { RotationRiskInfo } from "./rotationRisk";

export type PoolSortBy =
  | "pts"
  | "goals"
  | "assists"
  | "bonus"
  | "price"
  | "owned"
  | "real_pts"
  | "tackles"
  | "clearances"
  | "blocks"
  | "interceptions"
  | "key_passes"
  | "shots_on_target"
  | "saves";

export type PoolSearchRow = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_id: number;
  team_name: string;
  price: number;
  competition: string | null;
  hail_mary_score: number | null;
  /** The 1-10 within-position/gameweek/game rating (migration 0135) -
   * this is what should be SHOWN to a user; hail_mary_score above is a
   * backend-only value now (still real, still queried for sorting/
   * tiebreaks, never displayed). Null until compute_projections.py's
   * next run touches this exact player/gameweek row. */
  hailMaryRating: number | null;
  goalProjected: number;
  assistProjected: number;
  bonusProjected: number;
  /** Live ownership % (2026-08-10 user request) - only real for EFL
   * Fantasy and Cloud FF (see migration 0114's docstring); null on
   * Dream Team/FanTeam, whose real feeds have no such field. */
  ownershipPct: number | null;
  /** Real stats (2026-08-19 user request, mirroring fantasy.efl.com's own
   * player popup) - see migration 0121's docstring. realTotalPoints is a
   * rolling season-to-date total; lastGw/lastGwPoints is a single real
   * gameweek's result. The counting stats (tackles/clearances/etc) are
   * only ever real for EFL Fantasy today - null everywhere else, same
   * "absence of data is never treated as a real value" convention
   * ownershipPct already documents. */
  realTotalPoints: number | null;
  realMinutesPlayed: number | null;
  realGoals: number | null;
  realAssists: number | null;
  realCleanSheets: number | null;
  realSaves: number | null;
  realTackles: number | null;
  realClearances: number | null;
  realBlocks: number | null;
  realInterceptions: number | null;
  realKeyPasses: number | null;
  realShotsOnTarget: number | null;
  lastGw: number | null;
  lastGwPoints: number | null;
  /** Real live team news from fantasyfootballscout.co.uk (2026-08-19 user
   * request - see migration 0122/0123's docstrings) - 'out'|'doubt'|
   * 'banned', or null if FFScout has no current news on this player.
   * ffscoutStartProbability (0-100) is only meaningful when status is
   * 'doubt'. Real for Dream Team/FanTeam/Cloud FF's real Premier League
   * pool; always null for EFL Fantasy (Championship/League One/League
   * Two, outside FFScout's coverage). */
  ffscoutStatus: string | null;
  ffscoutStartProbability: number | null;
  /** Real injury type/description + expected return date (2026-08-20 user
   * request, see migration 0127's docstring) - null whenever FFScout's
   * injuries page has never captured anything for this player. */
  ffscoutDetail: string | null;
  ffscoutExpectedReturnDate: string | null;
  /** Predicted-lineup rotation-battle data (2026-08-19 user request, see
   * migration 0124's docstring) - null whenever this player isn't covered
   * by the screenshot batch or the batch has gone stale. Real Premier
   * League scope only, same as ffscoutStatus above. */
  rotationRisk: RotationRiskInfo | null;
};

export type PoolSearchResult = { rows: PoolSearchRow[]; totalCount: number };

/**
 * Server-side filter+sort+paginate over a game's player/club pool - see
 * migration 0099/0100's search_game_player_pool for why this exists (that
 * pool can be thousands of rows; a squad board's browse table only ever
 * shows ~15 at a time, so fetching the whole thing on every load/filter
 * change was pure waste). Sorting happens in the same RPC call, not
 * client-side after - only one page is ever fetched, so sorting locally
 * would just reorder whichever 15 rows happened to load, not find the
 * real top-N across the whole filtered pool. Called directly from a
 * client component (no revalidatePath - this never mutates anything), so
 * it stays a plain read even though the file needs "use server" to be
 * callable that way.
 */
export async function searchPool(params: {
  gameSlug: string;
  gameweek: number;
  position?: string | null;
  teamName?: string | null;
  competition?: string | null;
  search?: string | null;
  excludeIds: number[];
  maxPrice?: number | null;
  sortBy?: PoolSortBy;
  /** EFL Fantasy only - true for the "Players" tab so CLUB picks (a
   * separate pool of their own) never leak into the GK/DEF/MID/FWD list
   * when no specific position is selected. No other game has CLUB rows,
   * so this is a no-op everywhere else. */
  excludeClub?: boolean;
  page: number;
  pageSize: number;
}): Promise<PoolSearchResult> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { rows: [], totalCount: 0 };

  const { data, error } = await supabase.rpc("search_game_player_pool", {
    p_game_slug: params.gameSlug,
    p_gameweek: params.gameweek,
    p_position: params.position ?? null,
    p_team_name: params.teamName ?? null,
    p_competition: params.competition ?? null,
    p_search: params.search && params.search.trim() !== "" ? params.search.trim() : null,
    p_exclude_ids: params.excludeIds,
    p_max_price: params.maxPrice ?? null,
    p_sort_by: params.sortBy ?? "pts",
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
    competition: string | null;
    hail_mary_score: number | string | null;
    hail_mary_rating: number | null;
    goal_projected: number | string;
    assist_projected: number | string;
    bonus_projected: number | string;
    ownership_pct: number | string | null;
    real_total_points: number | string | null;
    real_minutes_played: number | null;
    real_goals: number | null;
    real_assists: number | null;
    real_clean_sheets: number | null;
    real_saves: number | null;
    real_tackles: number | null;
    real_clearances: number | null;
    real_blocks: number | null;
    real_interceptions: number | null;
    real_key_passes: number | null;
    real_shots_on_target: number | null;
    last_gw: number | null;
    last_gw_points: number | string | null;
    ffscout_status: string | null;
    ffscout_start_probability: number | string | null;
    ffscout_detail: string | null;
    ffscout_expected_return_date: string | null;
    rotation_start_probability: number | string | null;
    rotation_contender_name: string | null;
    rotation_contender_probability: number | string | null;
    rotation_risk_level: string | null;
    total_count: number | string;
  };
  const rpcRows = data as RpcRow[];
  const rows: PoolSearchRow[] = rpcRows.map((r) => ({
    game_player_id: r.game_player_id,
    full_name: r.full_name,
    position: r.position,
    team_id: r.team_id,
    team_name: r.team_name,
    price: Number(r.price),
    competition: r.competition,
    hail_mary_score: r.hail_mary_score != null ? Number(r.hail_mary_score) : null,
    hailMaryRating: r.hail_mary_rating,
    goalProjected: Number(r.goal_projected),
    assistProjected: Number(r.assist_projected),
    bonusProjected: Number(r.bonus_projected),
    ownershipPct: r.ownership_pct != null ? Number(r.ownership_pct) : null,
    realTotalPoints: r.real_total_points != null ? Number(r.real_total_points) : null,
    realMinutesPlayed: r.real_minutes_played,
    realGoals: r.real_goals,
    realAssists: r.real_assists,
    realCleanSheets: r.real_clean_sheets,
    realSaves: r.real_saves,
    realTackles: r.real_tackles,
    realClearances: r.real_clearances,
    realBlocks: r.real_blocks,
    realInterceptions: r.real_interceptions,
    realKeyPasses: r.real_key_passes,
    realShotsOnTarget: r.real_shots_on_target,
    lastGw: r.last_gw,
    lastGwPoints: r.last_gw_points != null ? Number(r.last_gw_points) : null,
    ffscoutStatus: r.ffscout_status,
    ffscoutStartProbability: r.ffscout_start_probability != null ? Number(r.ffscout_start_probability) : null,
    ffscoutDetail: r.ffscout_detail,
    ffscoutExpectedReturnDate: r.ffscout_expected_return_date,
    rotationRisk:
      r.rotation_start_probability != null && r.rotation_risk_level != null
        ? {
            level: r.rotation_risk_level as RotationRiskInfo["level"],
            ownProbability: Number(r.rotation_start_probability),
            contenderName: r.rotation_contender_name,
            contenderProbability: r.rotation_contender_probability != null ? Number(r.rotation_contender_probability) : null,
            contenderPlayerId: null,
          }
        : null,
  }));
  const totalCount = rpcRows.length > 0 ? Number(rpcRows[0].total_count) : 0;
  return { rows, totalCount };
}

/** Every real club name in a game's pool - for the team-filter dropdown,
 * which needs the full distinct list even though the pool table itself
 * only ever loads one page at a time. */
export async function listPoolTeams(gameSlug: string): Promise<string[]> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase.rpc("list_game_pool_teams", { p_game_slug: gameSlug });
  return ((data as { team_name: string }[]) ?? []).map((r) => r.team_name);
}
