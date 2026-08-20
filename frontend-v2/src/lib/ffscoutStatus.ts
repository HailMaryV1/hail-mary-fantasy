import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

export type FfscoutStatusInfo = {
  status: string;
  startProbability: number | null;
  /** Real injury type/description + expected return date (2026-08-20 user
   * request, see migration 0127) - sourced from whichever row is freshest
   * AND actually has one, which may differ from the row status/
   * startProbability came from (a bare team-news status update carries no
   * detail; see this function's own two-pass logic below). Null whenever
   * FFScout's injuries page has never captured anything for this player. */
  detail: string | null;
  expectedReturnDate: string | null;
};

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
    .select("player_id, status, start_probability, detail, expected_return_date, snapshot_date, captured_at")
    .in("player_id", ids)
    .gte("snapshot_date", new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
    .order("snapshot_date", { ascending: false })
    .order("captured_at", { ascending: false });

  type Row = {
    player_id: number;
    status: string;
    start_probability: number | string | null;
    detail: string | null;
    expected_return_date: string | null;
  };
  const rows = (data ?? []) as Row[];

  // Most-recent-row-per-player for status/startProbability - the query
  // above is already ordered newest-first, so the first row seen per
  // player_id is the one to keep.
  for (const row of rows) {
    if (map.has(row.player_id)) continue;
    map.set(row.player_id, { status: row.status, startProbability: row.start_probability != null ? Number(row.start_probability) : null, detail: null, expectedReturnDate: null });
  }

  // Separate pass for detail/expectedReturnDate - freshest row that
  // actually HAS one, not necessarily the same row status came from (see
  // this file's own FfscoutStatusInfo docstring).
  const detailSeen = new Set<number>();
  for (const row of rows) {
    if (detailSeen.has(row.player_id) || row.detail == null) continue;
    detailSeen.add(row.player_id);
    const entry = map.get(row.player_id);
    if (entry) {
      entry.detail = row.detail;
      entry.expectedReturnDate = row.expected_return_date;
    }
  }
  return map;
}
