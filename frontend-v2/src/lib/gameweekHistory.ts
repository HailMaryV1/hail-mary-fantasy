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

/**
 * Manually locks in the squad's CURRENT live state as `gameweek`'s
 * official submission - real user request 2026-08-18: "once i've locked
 * it in it saves all my choices... if i make changes before the deadline
 * i have to re save... once the deadline has passed i cant make changes
 * to that gameweek's team again". Upserts (unlike
 * capture_squad_gameweek_state.py's automatic fallback, which only fills
 * a genuine gap and never overwrites a real decision) - a manual Save is
 * always the freshest decision, re-pressable as many times as the user
 * likes right up until the real deadline. Once that deadline passes, this
 * same (squad_id, gameweek) row simply never gets touched again - by this
 * function (the caller must check the deadline before calling; see each
 * game's own saveTeamForGameweek action) or by the auto-capture script
 * (which only fills gaps, never overwrites), so it stays exactly what was
 * last saved - the real "final team" record Mary Performance Lab grades.
 */
export async function saveSquadGameweekLock(
  supabase: Supabase,
  squadId: number,
  gameweek: number,
  deadlineIso: string | null,
  snapshot: LockedSnapshot
): Promise<{ error: string } | { success: true }> {
  if (deadlineIso && new Date(deadlineIso).getTime() <= Date.now()) {
    return { error: "This gameweek's deadline has already passed - it's locked in as your final team." };
  }
  const { error } = await supabase.from("squad_gameweek_locks").upsert(
    {
      squad_id: squadId,
      gameweek,
      locked_at: new Date().toISOString(),
      lineup_snapshot: {
        players: snapshot.players,
        captain_game_player_id: snapshot.captainGamePlayerId,
        vice_captain_game_player_id: snapshot.viceCaptainGamePlayerId,
        active_booster: snapshot.activeBooster,
      },
    },
    { onConflict: "squad_id,gameweek" }
  );
  if (error) return { error: error.message };
  return { success: true };
}

/** Does the squad's current live state already match its latest saved
 * lock for this gameweek? Drives the Save button's "Saved" vs "Unsaved
 * changes" indicator - order-independent on players (a reorder alone
 * isn't a real change), exact match on starting/bench slot per player. */
export function isSquadSaved(current: LockedSnapshot, saved: LockedSnapshot | null): boolean {
  if (!saved) return false;
  if (current.captainGamePlayerId !== saved.captainGamePlayerId) return false;
  if (current.viceCaptainGamePlayerId !== saved.viceCaptainGamePlayerId) return false;
  if (current.activeBooster !== saved.activeBooster) return false;
  if (current.players.length !== saved.players.length) return false;
  const byId = new Map(saved.players.map((p) => [p.game_player_id, p]));
  return current.players.every((p) => {
    const match = byId.get(p.game_player_id);
    return !!match && match.is_starting === p.is_starting && match.bench_order === p.bench_order;
  });
}

/** {game_player_id: {points, minutes}} actually scored in a completed
 * gameweek - empty for games/gameweeks where nothing's been captured yet
 * (see player_gameweek_results, migration 0034; currently populated for
 * FanTeam + Cloud FF only, once a real gameweek has finished). Paginates
 * in PostgREST's own page size rather than a single unbounded select -
 * a whole game+gameweek's row count (every player in the pool, e.g.
 * EFL Fantasy's ~3500) can exceed PostgREST's default 1000-row response
 * cap, which was silently truncating this to an arbitrary subset (real
 * bug found 2026-08-19 investigating GW1 actual points missing for
 * exactly the players whose rows fell past row #1000). */
export async function getActualPoints(
  supabase: Supabase,
  gameId: number,
  gameweek: number
): Promise<Map<number, { points: number | null; minutes: number | null }>> {
  const PAGE_SIZE = 1000;
  const rows: { game_player_id: number; actual_points: number | null; actual_minutes: number | null }[] = [];
  for (let page = 0; ; page++) {
    const { data } = await supabase
      .from("player_gameweek_results")
      .select("game_player_id, actual_points, actual_minutes")
      .eq("game_id", gameId)
      .eq("gameweek", gameweek)
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
      .returns<{ game_player_id: number; actual_points: number | null; actual_minutes: number | null }[]>();
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return new Map(rows.map((r) => [r.game_player_id, { points: r.actual_points, minutes: r.actual_minutes }]));
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
