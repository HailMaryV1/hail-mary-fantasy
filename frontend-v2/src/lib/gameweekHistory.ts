import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

export type LockedSnapshotPlayer = { game_player_id: number; is_starting: boolean; bench_order: number | null };
export type LockedSnapshot = {
  players: LockedSnapshotPlayer[];
  captainGamePlayerId: number | null;
  viceCaptainGamePlayerId: number | null;
  activeBooster: string | null;
};

/**
 * squad_gameweek_locks.lineup_snapshot has two shapes on purpose (see
 * migration 0043 + capture_squad_gameweek_state.py's docstring): the
 * retired frontend's manual "Save Team" wrote a bare player array, the
 * new auto-capture script writes {players, captain_game_player_id, ...}.
 * Every reader has to handle both - this is the one place that does.
 */
function parseLineupSnapshot(raw: unknown): LockedSnapshot {
  if (Array.isArray(raw)) {
    return {
      players: raw as LockedSnapshotPlayer[],
      captainGamePlayerId: null,
      viceCaptainGamePlayerId: null,
      activeBooster: null,
    };
  }
  const obj = (raw ?? {}) as {
    players?: LockedSnapshotPlayer[];
    captain_game_player_id?: number | null;
    vice_captain_game_player_id?: number | null;
    active_booster?: string | null;
  };
  return {
    players: obj.players ?? [],
    captainGamePlayerId: obj.captain_game_player_id ?? null,
    viceCaptainGamePlayerId: obj.vice_captain_game_player_id ?? null,
    activeBooster: obj.active_booster ?? null,
  };
}

/** The locked squad for one gameweek, or null if that gameweek was never
 * locked in (deadline hasn't passed yet, or passed with no squad set). */
export async function getSquadGameweekLock(
  supabase: Supabase,
  squadId: number,
  gameweek: number
): Promise<{ lockedAt: string; snapshot: LockedSnapshot } | null> {
  const { data } = await supabase
    .from("squad_gameweek_locks")
    .select("locked_at, lineup_snapshot")
    .eq("squad_id", squadId)
    .eq("gameweek", gameweek)
    .maybeSingle<{ locked_at: string; lineup_snapshot: unknown }>();
  if (!data) return null;
  return { lockedAt: data.locked_at, snapshot: parseLineupSnapshot(data.lineup_snapshot) };
}

/** {game_player_id: {points, minutes}} actually scored in a completed
 * gameweek - empty for games/gameweeks where nothing's been captured yet
 * (see player_gameweek_results, migration 0034; currently populated for
 * FanTeam + Cloud FF only, once a real gameweek has finished). */
export async function getActualPoints(
  supabase: Supabase,
  gameId: number,
  gameweek: number
): Promise<Map<number, { points: number | null; minutes: number | null }>> {
  const { data } = await supabase
    .from("player_gameweek_results")
    .select("game_player_id, actual_points, actual_minutes")
    .eq("game_id", gameId)
    .eq("gameweek", gameweek)
    .returns<{ game_player_id: number; actual_points: number | null; actual_minutes: number | null }[]>();
  return new Map((data ?? []).map((r) => [r.game_player_id, { points: r.actual_points, minutes: r.actual_minutes }]));
}

export type ResolvedPlayerIdentity = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_id: number;
  team_name: string;
  price: number;
};

/**
 * Identity for a specific set of game_player_ids, including
 * transferred-out/deactivated ones - unlike game_player_pool (which
 * filters to gp.is_active only), a locked historical squad can contain
 * a player no longer in the live pool.
 */
export async function resolvePlayerIdentities(supabase: Supabase, gamePlayerIds: number[]): Promise<Map<number, ResolvedPlayerIdentity>> {
  if (gamePlayerIds.length === 0) return new Map();
  const { data } = await supabase
    .from("game_players")
    .select("id, price, position_code, players(full_name, team_id, teams!players_team_id_fkey(name))")
    .in("id", gamePlayerIds)
    .returns<{ id: number; price: number; position_code: string; players: { full_name: string; team_id: number; teams: { name: string } } }[]>();
  return new Map(
    (data ?? []).map((r) => [
      r.id,
      {
        game_player_id: r.id,
        full_name: r.players.full_name,
        // This game's OWN classification - not the shared players.position,
        // which can genuinely disagree between games (2026-08-08 fix).
        position: r.position_code,
        team_id: r.players.team_id,
        team_name: r.players.teams.name,
        price: Number(r.price),
      },
    ])
  );
}
