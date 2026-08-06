import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

type FixtureGameweekRow = { gameweek: number; fixtures: { kickoff_at: string } };

/** Earliest fixture kickoff per gameweek for this game - the shared read
 * getGameweekInfo builds on, since a fantasy gameweek's real deadline is
 * "the moment its first ball is kicked." */
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

export type GameweekInfo = {
  seasonStarted: boolean;
  /** "Which gameweek can transfers/recommendations still actually affect" -
   * the instant a gameweek's first ball is kicked, planning shifts to the
   * next one, even if that gameweek still has fixtures left to play. */
  planningGameweek: number | null;
  /** For browsing/switching between weeks (not "what should Mary act on
   * right now" - that's planningGameweek above). Lets a caller clamp an
   * untrusted ?gameweek= param into range without a second query. */
  minGameweek: number;
  maxGameweek: number;
  gameweeks: { gameweek: number; deadline: string }[];
};

/**
 * One combined read covering both "what's the current planning week" and
 * "what's the full browsable range" - getSeasonTiming and getGameweekRange
 * used to each run this same game_fixture_gameweeks query independently;
 * every board page needs both, so merging them halves that particular
 * round trip without changing what either was computing.
 */
export async function getGameweekInfo(supabase: Supabase, gameId: number): Promise<GameweekInfo> {
  const byGameweek = await earliestKickoffByGameweek(supabase, gameId);
  if (byGameweek.size === 0) {
    return { seasonStarted: false, planningGameweek: null, minGameweek: 1, maxGameweek: 1, gameweeks: [] };
  }

  const now = Date.now();
  const gameweek1Kickoff = byGameweek.get(1);
  const seasonStarted = gameweek1Kickoff !== undefined && now >= gameweek1Kickoff;

  const sorted = Array.from(byGameweek.entries())
    .map(([gameweek, kickoff]) => ({ gameweek, kickoff }))
    .sort((a, b) => a.gameweek - b.gameweek);
  const upcoming = sorted.filter((g) => g.kickoff >= now);
  const planningGameweek = upcoming.length > 0 ? upcoming[0].gameweek : null;

  return {
    seasonStarted,
    planningGameweek,
    minGameweek: sorted[0].gameweek,
    maxGameweek: sorted[sorted.length - 1].gameweek,
    gameweeks: sorted.map(({ gameweek, kickoff }) => ({ gameweek, deadline: new Date(kickoff).toISOString() })),
  };
}

/** @deprecated use getGameweekInfo - kept for the handful of callers
 * (actions.ts files, captains page) that only ever needed this half. */
export async function getSeasonTiming(supabase: Supabase, gameId: number): Promise<{ seasonStarted: boolean; planningGameweek: number | null }> {
  const info = await getGameweekInfo(supabase, gameId);
  return { seasonStarted: info.seasonStarted, planningGameweek: info.planningGameweek };
}

/**
 * Paginated in 1000-row pages, fetched speculatively in parallel rather
 * than one page at a time - PostgREST silently caps any single query at
 * 1000 rows server-side regardless of what the client asks for, so a pool
 * the size of EFL Fantasy's (~3,458 rows) needs multiple pages, and a
 * naive sequential loop turns that into N full network round trips
 * stacked back to back (confirmed live: this was a real, measurable chunk
 * of a ~5s page load). Firing a fixed batch of page requests at once costs
 * the same as one request's worth of latency for every pool below
 * SPECULATIVE_PAGES * PAGE_SIZE rows - every real pool in this app today -
 * and only falls back to a sequential tail for the (currently
 * hypothetical) case of a pool larger than that.
 */
export async function fetchAllPaginated<T>(fetchPage: (from: number, to: number) => Promise<T[] | null>): Promise<T[]> {
  const PAGE_SIZE = 1000;
  const SPECULATIVE_PAGES = 4;
  const speculative = await Promise.all(
    Array.from({ length: SPECULATIVE_PAGES }, (_, i) => fetchPage(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1))
  );
  const rows: T[] = [];
  let lastPageWasFull = false;
  for (const page of speculative) {
    rows.push(...(page ?? []));
    lastPageWasFull = (page ?? []).length === PAGE_SIZE;
  }
  if (lastPageWasFull) {
    for (let from = SPECULATIVE_PAGES * PAGE_SIZE; ; from += PAGE_SIZE) {
      const page = (await fetchPage(from, from + PAGE_SIZE - 1)) ?? [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
  }
  return rows;
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
  const data = await fetchAllPaginated<Row>(async (from, to) => {
    const { data: page } = await supabase
      .from("projections")
      .select("id, game_player_id, hail_mary_score, inputs, created_at, game_players!inner(game_id)")
      .eq("game_players.game_id", gameId)
      .eq("gameweek", gameweek)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to)
      .returns<Row[]>();
    return page;
  });

  const seen = new Set<number>();
  const rows: GameweekProjectionRow<TInputs>[] = [];
  for (const r of data) {
    if (seen.has(r.game_player_id)) continue;
    seen.add(r.game_player_id);
    rows.push({ game_player_id: r.game_player_id, hail_mary_score: r.hail_mary_score, inputs: r.inputs });
  }
  return rows;
}
