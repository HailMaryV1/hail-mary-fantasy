import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

type FixtureGameweekRow = { gameweek: number; fixtures: { kickoff_at: string } };

/** Earliest AND latest fixture kickoff per gameweek for this game -
 * earliest drives planningGameweek's "the moment its first ball is
 * kicked" deadline; latest drives displayGameweek's "is this gameweek
 * actually over yet" check below. */
async function kickoffRangeByGameweek(supabase: Supabase, gameId: number): Promise<Map<number, { min: number; max: number }>> {
  const { data } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures(kickoff_at)")
    .eq("game_id", gameId)
    .returns<FixtureGameweekRow[]>();

  const byGameweek = new Map<number, { min: number; max: number }>();
  for (const row of data ?? []) {
    const t = new Date(row.fixtures.kickoff_at).getTime();
    const current = byGameweek.get(row.gameweek);
    if (!current) byGameweek.set(row.gameweek, { min: t, max: t });
    else {
      if (t < current.min) current.min = t;
      if (t > current.max) current.max = t;
    }
  }
  return byGameweek;
}

// A gameweek counts as "over" once its last real fixture kicked off at
// least 3 hours ago - the same real-data-grounded proxy for "the match
// has finished" already relied on elsewhere without a separate full-time-
// status source (capture_gameweek_actuals.py's Cloud FF path, accrue_
// free_transfers.py, compute_projections.py's season-games-elapsed
// count - no fixture-level "finished" column exists in this schema at
// all, see fixtures table).
const GAMEWEEK_OVER_BUFFER_MS = 3 * 60 * 60 * 1000;

export type GameweekInfo = {
  seasonStarted: boolean;
  /** "Which gameweek can transfers/recommendations still actually affect" -
   * the instant a gameweek's first ball is kicked, planning shifts to the
   * next one, even if that gameweek still has fixtures left to play. */
  planningGameweek: number | null;
  /** Real user report 2026-08-22: with planningGameweek used as the
   * board's default landing view, the page jumped to GW2 the instant
   * GW1's first fixture kicked off - even though GW1 still had 9 more
   * fixtures left to play and no results existed yet for anything. This
   * is the SEPARATE "what should I show by default when just browsing"
   * gameweek - stays on a gameweek that's kicked off but not yet over
   * (see GAMEWEEK_OVER_BUFFER_MS above), only advancing once that
   * gameweek is genuinely done. Deliberately never null (falls back to
   * maxGameweek once every known gameweek is over) and deliberately NOT
   * planningGameweek - transfer/Ask-Mary logic must keep moving to the
   * next week the instant a gameweek kicks off, unaffected by this. */
  displayGameweek: number;
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
  const byGameweek = await kickoffRangeByGameweek(supabase, gameId);
  if (byGameweek.size === 0) {
    return { seasonStarted: false, planningGameweek: null, displayGameweek: 1, minGameweek: 1, maxGameweek: 1, gameweeks: [] };
  }

  const now = Date.now();
  const gameweek1Kickoff = byGameweek.get(1)?.min;
  const seasonStarted = gameweek1Kickoff !== undefined && now >= gameweek1Kickoff;

  const sorted = Array.from(byGameweek.entries())
    .map(([gameweek, range]) => ({ gameweek, ...range }))
    .sort((a, b) => a.gameweek - b.gameweek);
  const upcoming = sorted.filter((g) => g.min >= now);
  const planningGameweek = upcoming.length > 0 ? upcoming[0].gameweek : null;

  const notYetOver = sorted.filter((g) => now < g.max + GAMEWEEK_OVER_BUFFER_MS);
  const displayGameweek = notYetOver.length > 0 ? notYetOver[0].gameweek : sorted[sorted.length - 1].gameweek;

  return {
    seasonStarted,
    planningGameweek,
    displayGameweek,
    minGameweek: sorted[0].gameweek,
    maxGameweek: sorted[sorted.length - 1].gameweek,
    gameweeks: sorted.map(({ gameweek, min }) => ({ gameweek, deadline: new Date(min).toISOString() })),
  };
}

/** @deprecated use getGameweekInfo - kept for the handful of callers
 * (actions.ts files, captains page) that only ever needed this half. */
export async function getSeasonTiming(supabase: Supabase, gameId: number): Promise<{ seasonStarted: boolean; planningGameweek: number | null }> {
  const info = await getGameweekInfo(supabase, gameId);
  return { seasonStarted: info.seasonStarted, planningGameweek: info.planningGameweek };
}

/**
 * Paginated in 1000-row pages - PostgREST silently caps any single query
 * at 1000 rows server-side regardless of what the client asks for, so a
 * pool the size of EFL Fantasy's (~3,458 rows) needs multiple pages.
 *
 * Sequential, deliberately not parallel - firing every page at once was
 * tried and made things worse, not better: confirmed live, EFL Fantasy's
 * board page (which already runs several other queries in the same
 * parallel batch) went from ~5s to ~17s once its two paginated reads each
 * fired 4 concurrent requests on top of that - almost certainly Supabase's
 * free-tier pooler connection limit getting saturated and queuing/
 * throttling the pile-up, not the extra requests' raw latency. A page at
 * a time keeps this call's own connection footprint at exactly one.
 */
export async function fetchAllPaginated<T>(fetchPage: (from: number, to: number) => Promise<T[] | null>): Promise<T[]> {
  const PAGE_SIZE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = (await fetchPage(from, from + PAGE_SIZE - 1)) ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

export type GameweekProjectionRow<TInputs> = {
  game_player_id: number;
  hail_mary_score: number | null;
  hail_mary_rating: number | null;
  inputs: TInputs | null;
};

/**
 * Real projections for one specific gameweek, scoped to a known, small
 * set of game_player_ids - a squad's own ~9-15 members, not the whole
 * pool (the pool's browse table gets its scores from
 * search_game_player_pool/poolSearch.ts instead, which only ever touches
 * the one page actually on screen). Unlike player_projection_summary
 * (which always resolves to whichever gameweek is currently "planning",
 * regardless of what's asked for), this reads the raw projections table
 * directly so a board page can browse any computed gameweek, not just
 * the live one.
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
 * touches hail_mary_score/inputs only). With that many ties, a plain
 * ORDER BY created_at + range()-based pagination isn't guaranteed stable
 * across two separate HTTP requests - confirmed live, back when this
 * function fetched an entire game's pool in pages: some of a squad's
 * GW2 rows fell into the gap between page 1 and page 2 and came back as
 * neither, even though every row genuinely existed. id is a real
 * identity column, so adding it as a tiebreaker makes the sort fully
 * deterministic - kept even now that the set being queried is small
 * enough to never need pagination in the first place.
 */
export async function getProjectionsForPlayerIds<TInputs = unknown>(
  supabase: Supabase,
  gameweek: number,
  gamePlayerIds: number[]
): Promise<GameweekProjectionRow<TInputs>[]> {
  if (gamePlayerIds.length === 0) return [];
  type Row = GameweekProjectionRow<TInputs> & { id: number; created_at: string };
  const { data } = await supabase
    .from("projections")
    .select("id, game_player_id, hail_mary_score, hail_mary_rating, inputs, created_at")
    .in("game_player_id", gamePlayerIds)
    .eq("gameweek", gameweek)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .returns<Row[]>();

  const seen = new Set<number>();
  const rows: GameweekProjectionRow<TInputs>[] = [];
  for (const r of data ?? []) {
    if (seen.has(r.game_player_id)) continue;
    seen.add(r.game_player_id);
    rows.push({
      game_player_id: r.game_player_id,
      hail_mary_score: r.hail_mary_score,
      hail_mary_rating: r.hail_mary_rating,
      inputs: r.inputs,
    });
  }
  return rows;
}
