import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

export type FfscoutStatusInfo = { status: string; startProbability: number | null };

/**
 * Batch fetch from ffscout_player_status (migration 0122) for a squad's
 * worth of player_ids - one query per page load, same "one query, not one
 * per player" pattern as rotationRisk.ts's fetchRotationRiskByPlayerIds.
 * Squad (pitch) players need this fetched separately from the pool -
 * game_player_pool/search_game_player_pool (migration 0123) already
 * carries ffscoutStatus/ffscoutStartProbability for pool rows, but a
 * squad's own player list is built from a different query with no such
 * join. Real news only, same "absence of data is never treated as a
 * flag" convention every other status source in this project follows -
 * a player with no current FFScout row simply has no entry in the
 * returned map.
 */
export async function fetchFfscoutStatusByPlayerIds(supabase: Supabase, playerIds: number[]): Promise<Map<number, FfscoutStatusInfo>> {
  const map = new Map<number, FfscoutStatusInfo>();
  const ids = [...new Set(playerIds)];
  if (ids.length === 0) return map;

  const { data } = await supabase
    .from("ffscout_player_status")
    .select("player_id, status, start_probability, snapshot_date, captured_at")
    .in("player_id", ids)
    .gte("snapshot_date", new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
    .order("snapshot_date", { ascending: false })
    .order("captured_at", { ascending: false });

  // Most-recent-row-per-player - the query above is already ordered
  // newest-first, so the first row seen per player_id is the one to keep.
  for (const row of (data ?? []) as { player_id: number; status: string; start_probability: number | string | null }[]) {
    if (map.has(row.player_id)) continue;
    map.set(row.player_id, {
      status: row.status,
      startProbability: row.start_probability != null ? Number(row.start_probability) : null,
    });
  }
  return map;
}
