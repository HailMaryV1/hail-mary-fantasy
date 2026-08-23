import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

// rating is only ever meaningful per-player - getSquadProjectionTrend
// below sums score across a whole squad (deliberately stays real points,
// same as the squad-total stat box - see hailMaryRating.ts's own
// docstring on why ratings can't be summed across positions), so its
// own TrendPoints just carry rating: null.
export type TrendPoint = { gameweek: number; score: number; rating: number | null };

/**
 * Latest hail_mary_score/hail_mary_rating per (game_player_id, gameweek)
 * across a gameweek window - same "order by created_at desc, keep first"
 * dedup as gameweek.ts's getProjectionsForPlayerIds (a re-run recompute
 * overwrites the JSON in place but never bumps created_at on UPDATE, so
 * this is really just "the newest row per gameweek", not a real history
 * table). Returns gamePlayerId -> gameweek -> {score, rating}.
 */
async function fetchLatestPerGameweek(
  supabase: Supabase,
  gamePlayerIds: number[],
  fromGameweek: number,
  count: number
): Promise<Map<number, Map<number, { score: number; rating: number | null }>>> {
  const out = new Map<number, Map<number, { score: number; rating: number | null }>>();
  if (gamePlayerIds.length === 0) return out;

  const { data } = await supabase
    .from("projections")
    .select("game_player_id, gameweek, hail_mary_score, hail_mary_rating, created_at")
    .in("game_player_id", gamePlayerIds)
    .gte("gameweek", fromGameweek)
    .lt("gameweek", fromGameweek + count)
    .order("created_at", { ascending: false })
    .returns<
      { game_player_id: number; gameweek: number | null; hail_mary_score: number | null; hail_mary_rating: number | null; created_at: string }[]
    >();

  for (const row of data ?? []) {
    if (row.gameweek == null) continue;
    const byGw = out.get(row.game_player_id) ?? new Map<number, { score: number; rating: number | null }>();
    if (!byGw.has(row.gameweek)) byGw.set(row.gameweek, { score: Number(row.hail_mary_score ?? 0), rating: row.hail_mary_rating });
    out.set(row.game_player_id, byGw);
  }
  return out;
}

/** One player's projected-rating trend across the next `count` gameweeks
 * starting at `fromGameweek` - a gameweek with no projection yet (e.g.
 * beyond how far the calendar's been imported) shows as score 0/rating
 * null, not omitted, so the chart's x-axis always covers the full
 * requested window. */
export async function getPlayerProjectionTrend(supabase: Supabase, gamePlayerId: number, fromGameweek: number, count = 5): Promise<TrendPoint[]> {
  const byPlayer = await fetchLatestPerGameweek(supabase, [gamePlayerId], fromGameweek, count);
  const byGw = byPlayer.get(gamePlayerId) ?? new Map<number, { score: number; rating: number | null }>();
  return Array.from({ length: count }, (_, i) => fromGameweek + i).map((gameweek) => {
    const point = byGw.get(gameweek);
    return { gameweek, score: point?.score ?? 0, rating: point?.rating ?? null };
  });
}

/** A whole squad's total projected-points trend across the next `count`
 * gameweeks, assuming the CURRENT squad is kept unchanged - "if you made
 * no further transfers, here's where your points are heading," same
 * framing as the transfer search's own PLANNING_LOOKAHEAD_GAMEWEEKS.
 * Deliberately stays real points (rating: null throughout) - this sums
 * across every position in the squad, exactly the cross-position sum
 * ratings can't safely support. */
export async function getSquadProjectionTrend(supabase: Supabase, gamePlayerIds: number[], fromGameweek: number, count = 5): Promise<TrendPoint[]> {
  const byPlayer = await fetchLatestPerGameweek(supabase, gamePlayerIds, fromGameweek, count);
  return Array.from({ length: count }, (_, i) => fromGameweek + i).map((gameweek) => {
    let sum = 0;
    for (const byGw of byPlayer.values()) sum += byGw.get(gameweek)?.score ?? 0;
    return { gameweek, score: Math.round(sum * 10) / 10, rating: null };
  });
}
