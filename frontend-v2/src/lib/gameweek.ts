import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

type FixtureGameweekRow = { gameweek: number; fixtures: { kickoff_at: string } };

/** Earliest fixture kickoff per gameweek for this game - the shared read
 * both getSeasonTiming and getGameweekRange build on, since a fantasy
 * gameweek's real deadline is "the moment its first ball is kicked." */
async function earliestKickoffByGameweek(supabase: Supabase, gameId: number): Promise<Map<number, number>> {
  const { data } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures(kickoff_at)")
    .eq("game_id", gameId)
    .returns<FixtureGameweekRow[]>();

  const byGameweek = new Map<number, number>();
  for (const row of data ?? []) {
    const t = new Date(row.fixtures.kickoff_at).getTime();
    const current = byGameweek.get(row.gameweek);
    if (current === undefined || t < current) byGameweek.set(row.gameweek, t);
  }
  return byGameweek;
}

/**
 * "Which gameweek can transfers/recommendations still actually affect" -
 * the instant a gameweek's first ball is kicked, planning shifts to the
 * next one, even if that gameweek still has fixtures left to play.
 */
export async function getSeasonTiming(
  supabase: Supabase,
  gameId: number
): Promise<{ seasonStarted: boolean; planningGameweek: number | null }> {
  const byGameweek = await earliestKickoffByGameweek(supabase, gameId);
  if (byGameweek.size === 0) {
    return { seasonStarted: false, planningGameweek: null };
  }

  const now = Date.now();
  const gameweek1Kickoff = byGameweek.get(1);
  const seasonStarted = gameweek1Kickoff !== undefined && now >= gameweek1Kickoff;

  const upcoming = Array.from(byGameweek.entries())
    .filter(([, kickoff]) => kickoff >= now)
    .sort((a, b) => a[0] - b[0]);
  const planningGameweek = upcoming.length > 0 ? upcoming[0][0] : null;

  return { seasonStarted, planningGameweek };
}

/**
 * Every gameweek this game's calendar currently knows about, with its
 * computed deadline - for browsing/switching between weeks (not for
 * "what should Mary act on right now", that's still getSeasonTiming).
 * min/maxGameweek let callers clamp an untrusted ?gameweek= param into
 * range without a second query.
 */
export async function getGameweekRange(
  supabase: Supabase,
  gameId: number
): Promise<{ minGameweek: number; maxGameweek: number; gameweeks: { gameweek: number; deadline: string }[] }> {
  const byGameweek = await earliestKickoffByGameweek(supabase, gameId);
  if (byGameweek.size === 0) {
    return { minGameweek: 1, maxGameweek: 1, gameweeks: [] };
  }

  const gameweeks = Array.from(byGameweek.entries())
    .map(([gameweek, kickoff]) => ({ gameweek, deadline: new Date(kickoff).toISOString() }))
    .sort((a, b) => a.gameweek - b.gameweek);

  return {
    minGameweek: gameweeks[0].gameweek,
    maxGameweek: gameweeks[gameweeks.length - 1].gameweek,
    gameweeks,
  };
}

export type GameweekProjectionRow<TInputs> = { game_player_id: number; hail_mary_score: number | null; inputs: TInputs | null };

/**
 * Real projections for one specific gameweek of this game - unlike
 * player_projection_summary (which always resolves to whichever
 * gameweek is currently "planning", regardless of what's asked for),
 * this reads the raw projections table directly so a board page can
 * browse any computed gameweek, not just the live one.
 *
 * projections is unique on (algorithm_version_id, game_player_id,
 * gameweek), not (game_player_id, gameweek) - if an algorithm version
 * ever changes, more than one row can exist per player/gameweek, so this
 * dedupes to the newest created_at per player, same tie-break
 * player_projection_summary's own view definition already uses.
 *
 * Paginated in 1000-row pages - PostgREST silently caps any single query
 * at 1000 rows server-side regardless of what the client asks for (the
 * same truncation eflfantasy/page.tsx's fetchAllPoolRows already works
 * around). A large pool (EFL Fantasy's ~3,458 rows) makes this the first
 * caller to actually hit it.
 *
 * Ordered by created_at desc THEN id desc, not created_at alone - every
 * row from a single compute_projections.py run shares the exact same
 * created_at (one transaction-scoped now()), and its upsert never
 * advances created_at on a later re-run either (on conflict do update
 * touches hail_mary_score/inputs only). With that many ties, plain
 * ORDER BY created_at + range()-based pagination is not guaranteed
 * stable across two separate HTTP requests - confirmed live: some of a
 * squad's GW2 rows fell into the gap between page 1 and page 2 and came
 * back as neither, even though every row genuinely existed. id is a
 * real identity column, so adding it as a tiebreaker makes the sort (and
 * therefore the pagination) fully deterministic.
 */
export async function getProjectionsForGameweek<TInputs = unknown>(
  supabase: Supabase,
  gameId: number,
  gameweek: number
): Promise<GameweekProjectionRow<TInputs>[]> {
  type Row = GameweekProjectionRow<TInputs> & { id: number; created_at: string };
  const PAGE_SIZE = 1000;
  const data: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page } = await supabase
      .from("projections")
      .select("id, game_player_id, hail_mary_score, inputs, created_at, game_players!inner(game_id)")
      .eq("game_players.game_id", gameId)
      .eq("gameweek", gameweek)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
      .returns<Row[]>();
    if (!page || page.length === 0) break;
    data.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const seen = new Set<number>();
  const rows: GameweekProjectionRow<TInputs>[] = [];
  for (const r of data ?? []) {
    if (seen.has(r.game_player_id)) continue;
    seen.add(r.game_player_id);
    rows.push({ game_player_id: r.game_player_id, hail_mary_score: r.hail_mary_score, inputs: r.inputs });
  }
  return rows;
}
