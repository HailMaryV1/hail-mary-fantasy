"use server";

import { createAuthServerClient } from "./supabaseServerClient";

export type PoolSortBy = "pts" | "goals" | "assists" | "bonus";

export type PoolSearchRow = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_id: number;
  team_name: string;
  price: number;
  competition: string | null;
  hail_mary_score: number | null;
  goalProjected: number;
  assistProjected: number;
  bonusProjected: number;
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
    goal_projected: number | string;
    assist_projected: number | string;
    bonus_projected: number | string;
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
    goalProjected: Number(r.goal_projected),
    assistProjected: Number(r.assist_projected),
    bonusProjected: Number(r.bonus_projected),
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
