import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * EFL Fantasy's real season-long rule: the same club can only be picked
 * for 5 gameweeks total before the real site auto-swaps it out (see
 * migration 0090's docstring, confirmed live via fantasy.efl.com's own
 * "club_cap" copy). Hail Mary never syncs a real submitted squad for
 * this game (no external auth, unlike FanTeam), so there's nothing to
 * enforce server-side the way the real site does - this is advisory
 * only, derived from squad_gameweek_locks (migration 0043), which
 * already captures "what team I had saved for the week" either from a
 * manual Save Team press or automatically once a gameweek's deadline
 * passes (scripts/capture_squad_gameweek_state.py).
 *
 * lineup_snapshot's shape varies by writer (see that script's own
 * docstring: a plain game_player_id array from the manual Save Team
 * action, or a richer object from the automatic capture) - this reads
 * defensively across both rather than assuming one.
 *
 * Returns 0 counts for every club until a real gameweek deadline has
 * actually passed and been captured - genuinely empty right now
 * (pre-season, EFL Fantasy's GW1 hasn't locked yet), not a bug.
 */
export async function getClubPickCounts(supabase: SupabaseClient, squadId: number): Promise<Map<number, number>> {
  const { data } = await supabase.from("squad_gameweek_locks").select("lineup_snapshot").eq("squad_id", squadId);
  const counts = new Map<number, number>();
  for (const row of data ?? []) {
    const snapshot = row.lineup_snapshot as unknown;
    const gamePlayerIds = extractGamePlayerIds(snapshot);
    for (const id of gamePlayerIds) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

function extractGamePlayerIds(snapshot: unknown): number[] {
  if (Array.isArray(snapshot)) {
    // Plain array shape - either raw numbers or {game_player_id} objects.
    return snapshot.map((entry) => (typeof entry === "number" ? entry : entry?.game_player_id)).filter((id): id is number => typeof id === "number");
  }
  if (snapshot && typeof snapshot === "object") {
    const players = (snapshot as { players?: unknown; squad?: unknown }).players ?? (snapshot as { squad?: unknown }).squad;
    if (Array.isArray(players)) return extractGamePlayerIds(players);
  }
  return [];
}

export const CLUB_CAP = 5;
