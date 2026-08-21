import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getProjectionsForPlayerIds, fetchAllPaginated } from "@/lib/gameweek";
import { getEflGameweekInfo, getTeamKickoffMap, isTeamLocked } from "@/lib/eflFixtureLocking";
import { getSquadGameweekLock, getActualPoints, resolvePlayerIdentities, isSquadSaved, getSquadActualPointsForGameweek } from "@/lib/gameweekHistory";
import { searchPool, listPoolTeams } from "@/lib/poolSearch";
import { getProjectionFreshness } from "@/lib/projectionFreshness";
import { buildSquadSummary } from "@/lib/squadSummary";
import EFLFantasyBoard, {
  type BoardPlayer,
  type PoolPlayer,
  type BoardClub,
  type PoolClub,
  type FixtureTile,
  type ReservePosition,
  type ReservePick,
  POOL_PAGE_SIZE,
} from "./EFLFantasyBoard";

export const dynamic = "force-dynamic";

type SquadRow = { id: number; name: string };

type SquadPlayerRow = {
  game_player_id: number;
  game_players: {
    // EFL Fantasy's OWN classification, not the shared players.position
    // which can genuinely disagree with what this game calls a player
    // (2026-08-08 fix). CLUB rows are eflfantasy-only synthetic entities,
    // never cross-game, so no ambiguity risk there either way.
    position_code: "GK" | "DEF" | "MID" | "FWD" | "CLUB";
    players: { id: number; full_name: string; team_id: number; teams: { name: string } };
  };
};

type ClubHistoryRow = { game_player_id: number; total_points: number | null };

type ReservePickRow = {
  position: ReservePosition;
  rank: number;
  game_player_id: number;
  game_players: { players: { id: number; full_name: string; team_id: number; teams: { name: string } } };
};

type PoolRow = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD" | "CLUB";
  team_id: number;
  team_name: string;
  hail_mary_score: number | null;
  competition: string | null;
  ownership_pct: number | null;
};

type FixtureRow = {
  gameweek: number;
  fixtures: {
    id: number;
    home_team_id: number;
    away_team_id: number;
    home: { name: string };
    away: { name: string };
  } | null;
};

type DifficultyRow = { fixture_id: number; team_id: number; attack_score: number; source: "real_odds" | "fdr" };

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

// Only used for the past-gameweek branch below (browsing a completed
// week's actual results, which player_gameweek_results doesn't cover yet
// for any game - see gameweekHistory.ts) - a genuinely rare path with no
// real data to show today, unlike the planning/future branch this page
// hits on every normal load. Full-pool fetching is fine to keep here
// rather than building a whole second search RPC for it: correctness for
// "what else was available, by real result" matters more than raw speed
// on a path nobody can actually reach until a gameweek finishes.
async function fetchAllPoolRows(supabase: Supabase, gameSlug: string): Promise<PoolRow[]> {
  return fetchAllPaginated<PoolRow>(async (from, to) => {
    const { data } = await supabase
      .from("game_player_pool")
      .select("game_player_id, full_name, position, team_id, team_name, hail_mary_score, competition, ownership_pct")
      .eq("game_slug", gameSlug)
      .range(from, to)
      .returns<PoolRow[]>();
    return data;
  });
}

export default async function EFLFantasyPage({ searchParams }: { searchParams: Promise<{ gameweek?: string }> }) {
  const { gameweek: gameweekParam } = await searchParams;
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", "eflfantasy").maybeSingle();

  const { data: squad } = game
    ? await supabase
        .from("squads")
        .select("id, name")
        .eq("game_id", game.id)
        .eq("user_id", user.id)
        .eq("is_archived", false)
        .order("created_at")
        .limit(1)
        .maybeSingle<SquadRow>()
    : { data: null };

  if (!game || !squad) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-lg">
          <h1 className="mt-6 text-xl font-semibold text-white">EFL Fantasy</h1>
          <p className="mt-2 text-sm text-navy-300">No squad yet.</p>
        </main>
      </div>
    );
  }

  const squadId = squad.id;

  const [{ data: squadPlayersRaw }, gwInfo, { data: clubHistoryRaw }] = await Promise.all([
    supabase
      .from("squad_players")
      .select("game_player_id, game_players(position_code, players(id, full_name, team_id, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squadId)
      .returns<SquadPlayerRow[]>(),
    getEflGameweekInfo(supabase, game.id),
    supabase
      .from("game_player_stats")
      .select("game_player_id, total_points, game_players!inner(game_id, position_code)")
      .eq("game_players.game_id", game.id)
      .eq("game_players.position_code", "CLUB")
      .eq("season", "2025/26")
      .eq("gameweek", 0)
      .returns<ClubHistoryRow[]>(),
  ]);

  const squadPlayers = (squadPlayersRaw ?? []).map((sp) => ({
    game_player_id: sp.game_player_id,
    player_id: sp.game_players.players.id,
    full_name: sp.game_players.players.full_name,
    position: sp.game_players.position_code,
    team_id: sp.game_players.players.team_id,
    team_name: sp.game_players.players.teams.name,
  }));
  const squadIds = squadPlayers.map((p) => p.game_player_id);

  const planningGameweek = gwInfo.planningGameweek ?? 1;
  const requestedGameweek = Number(gameweekParam);
  const viewedGameweek = Number.isInteger(requestedGameweek)
    ? Math.min(Math.max(requestedGameweek, gwInfo.minGameweek), gwInfo.maxGameweek)
    : planningGameweek;
  const isPlanningView = viewedGameweek === planningGameweek;
  const isPastView = viewedGameweek < planningGameweek;

  // Next-6-gameweek fixture difficulty for every team (not just the
  // gameweek being viewed) - the colour-coded pills need a run of
  // fixtures to show "next 1/2/3", same pattern as FanTeamBoard/
  // DreamTeamBoard's page.tsx. attack_score comes straight from the
  // team_fixture_difficulty view, which already prefers real bookmaker
  // odds over the EFL-FDR fallback per fixture (see migration 0017 +
  // this project's fixture-difficulty memory) - this display picks up
  // that real-vs-fallback distinction automatically, no separate query
  // needed.
  // team_fixture_difficulty spans every gameweek of all 3 EFL competitions
  // at once (3,000+ rows for this game_id) - well past PostgREST's default
  // 1000-row cap, which silently truncated this query and left later
  // fixture/team combos missing from the map entirely. A missing entry
  // fell back to the neutral 0.5 default below, which - being just inside
  // the "easy fixture" emerald band - could paint a genuinely hard
  // fixture green instead of merely blank. fetchAllPaginated (already
  // used a few lines up for the pool) pages past that cap.
  const [{ data: gwFixtureRows }, difficultyRows] = await Promise.all([
    supabase
      .from("game_fixture_gameweeks")
      .select("gameweek, fixtures(id, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))")
      .eq("game_id", game.id)
      .gte("gameweek", viewedGameweek)
      .lte("gameweek", viewedGameweek + 5)
      .returns<FixtureRow[]>(),
    fetchAllPaginated<DifficultyRow>(async (from, to) => {
      const { data } = await supabase
        .from("team_fixture_difficulty")
        .select("fixture_id, team_id, attack_score, source")
        .eq("game_id", game.id)
        .range(from, to)
        .returns<DifficultyRow[]>();
      return data;
    }),
  ]);

  const difficultyByFixtureTeam = new Map(
    difficultyRows.map((d) => [`${d.fixture_id}:${d.team_id}`, { attackScore: Number(d.attack_score), source: d.source }])
  );
  const tilesByTeamGw = new Map<string, FixtureTile>();
  // Full (non-abbreviated) opponent name for just the viewed gameweek -
  // only used by the "Why These Clubs" panel's prose line, which reads
  // better as "next vs Millwall" than the abbreviated pill's "MIL".
  const nextFixtureLabelByTeamId = new Map<number, string>();
  for (const row of gwFixtureRows ?? []) {
    const f = row.fixtures;
    if (!f) continue;
    for (const [teamId, oppName, isHome] of [
      [f.home_team_id, f.away.name, true],
      [f.away_team_id, f.home.name, false],
    ] as [number, string, boolean][]) {
      const key = `${teamId}:${row.gameweek}`;
      const entry = difficultyByFixtureTeam.get(`${f.id}:${teamId}`);
      tilesByTeamGw.set(key, {
        opponentAbbr: abbreviate(oppName),
        isHome,
        difficulty: entry?.attackScore ?? 0.5,
        source: entry?.source ?? "fdr",
      });
      if (row.gameweek === viewedGameweek) {
        nextFixtureLabelByTeamId.set(teamId, `next ${isHome ? "vs" : "away to"} ${oppName} (GW${row.gameweek})`);
      }
    }
  }
  // Plain-object mirror of tilesByTeamGw - see DreamTeamBoard.tsx's page
  // for why this crosses the server/client boundary as a prop instead of
  // being recomputed per pool row.
  const fixtureTilesRecord: Record<string, FixtureTile> = Object.fromEntries(tilesByTeamGw);

  function buildFixtures(teamId: number): (FixtureTile | null)[] {
    return Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${teamId}:${viewedGameweek + i}`) ?? null);
  }

  // Real 2025/26 season-average points per club (same historical
  // baseline compute_club_scores() fixture-adjusts from) - shown as-is
  // alongside the fixture, so "why was this club picked" has a real
  // number behind it, not just this gameweek's projected score. Season
  // total, not gameweek-scoped, so unaffected by which week is viewed.
  const lastSeasonPointsByGamePlayerId = new Map<number, number>((clubHistoryRaw ?? []).map((r) => [r.game_player_id, Number(r.total_points ?? 0)]));

  let boardSquad: BoardPlayer[];
  let boardClubs: BoardClub[];
  let boardPool: PoolPlayer[];
  let boardClubPool: PoolClub[];
  let poolTotalCount = 0;
  let clubPoolTotalCount = 0;
  let teams: string[] = [];
  let pastViewState: "not_locked" | "no_results_yet" | null = null;
  // Reserve shortlist (2026-08-11 request) makes no sense on a past/locked
  // gameweek - it's about backing up THIS week's live decisions - so it's
  // only ever populated in the planning branch below.
  let boardReserves: Record<ReservePosition, ReservePick[]> = { DEF: [], MID: [], FWD: [] };
  let isTeamSaved = false;
  // Teams whose own fixture in the viewed gameweek has already kicked off -
  // only meaningful on the planning branch below (see eflFixtureLocking.ts).
  let lockedTeamIds: number[] = [];

  if (isPastView) {
    const [lock, poolRaw] = await Promise.all([getSquadGameweekLock(supabase, squadId, viewedGameweek), fetchAllPoolRows(supabase, "eflfantasy")]);
    if (!lock) {
      boardSquad = [];
      boardClubs = [];
      boardPool = [];
      boardClubPool = [];
      pastViewState = "not_locked";
    } else {
      const [identities, actuals] = await Promise.all([
        resolvePlayerIdentities(
          supabase,
          lock.snapshot.players.map((p) => p.game_player_id)
        ),
        getActualPoints(supabase, game.id, viewedGameweek),
      ]);
      const hasAnyResult = lock.snapshot.players.some((p) => actuals.get(p.game_player_id)?.points != null);
      pastViewState = hasAnyResult ? null : "no_results_yet";

      const lockedIdentities = lock.snapshot.players
        .map((sp) => identities.get(sp.game_player_id))
        .filter((id): id is NonNullable<typeof id> => id != null);

      // Real EFL Fantasy doubles the captain's points - this app has no
      // captain-selection UI of its own yet, but the lock snapshot's
      // captain_game_player_id field (migration 0043) already exists for
      // exactly this, so a past-gameweek's real total can be accurate even
      // before that UI is built.
      const captainId = lock.snapshot.captainGamePlayerId;
      const scoreFor = (gamePlayerId: number) => {
        const points = actuals.get(gamePlayerId)?.points ?? null;
        return points != null && gamePlayerId === captainId ? points * 2 : points;
      };

      boardSquad = lockedIdentities
        .filter((id) => id.position !== "CLUB")
        .map((id) => ({
          game_player_id: id.game_player_id,
          full_name: id.full_name,
          position: id.position as "GK" | "DEF" | "MID" | "FWD",
          team_name: id.team_name,
          teamId: id.team_id,
          score: scoreFor(id.game_player_id),
          fixtures: buildFixtures(id.team_id),
        }));
      boardClubs = lockedIdentities
        .filter((id) => id.position === "CLUB")
        .map((id) => ({
          game_player_id: id.game_player_id,
          club_name: id.team_name,
          teamId: id.team_id,
          score: actuals.get(id.game_player_id)?.points ?? null,
          fixtures: buildFixtures(id.team_id),
          nextFixtureLabel: nextFixtureLabelByTeamId.get(id.team_id) ?? null,
          lastSeasonAvgPoints: lastSeasonPointsByGamePlayerId.get(id.game_player_id) ?? null,
        }));

      const lockedIds = new Set(lock.snapshot.players.map((p) => p.game_player_id));
      boardPool = poolRaw
        .filter((p) => p.position !== "CLUB" && !lockedIds.has(p.game_player_id))
        .map((p) => ({
          game_player_id: p.game_player_id,
          full_name: p.full_name,
          position: p.position as "GK" | "DEF" | "MID" | "FWD",
          team_name: p.team_name,
          teamId: p.team_id,
          score: actuals.get(p.game_player_id)?.points ?? null,
          // Raw code (e.g. "efl_league_one"), not the friendly label - the
          // league <select>'s option values are raw codes too (see
          // EFLFantasyBoard.tsx), matching what the server-driven pool
          // path already sends as p_competition. Was friendly-labeled here
          // until 2026-08-19, which made this client-side filter (used
          // only on past-gameweek views) silently return zero results for
          // League One/Two - a real "no players found" bug the user hit.
          competition: p.competition,
          fixtures: buildFixtures(p.team_id),
          ownershipPct: p.ownership_pct,
        }))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      boardClubPool = poolRaw
        .filter((p) => p.position === "CLUB" && !lockedIds.has(p.game_player_id))
        .map((p) => ({
          game_player_id: p.game_player_id,
          club_name: p.team_name,
          teamId: p.team_id,
          score: actuals.get(p.game_player_id)?.points ?? null,
          competition: p.competition,
          fixtures: buildFixtures(p.team_id),
          nextFixtureLabel: nextFixtureLabelByTeamId.get(p.team_id) ?? null,
          lastSeasonAvgPoints: lastSeasonPointsByGamePlayerId.get(p.game_player_id) ?? null,
        }))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      poolTotalCount = boardPool.length;
      clubPoolTotalCount = boardClubPool.length;
    }
  } else {
    // Real per-gameweek scores for just the squad's own ~9 members - the
    // pool's browse table gets its scores from search_game_player_pool
    // instead (via EFLFantasyBoard's own on-demand fetch), never a
    // whole-pool read here.
    const [scoreRows, initialPool, initialClubPool, teamNames, { data: reserveRowsRaw }, teamKickoffMap] = await Promise.all([
      getProjectionsForPlayerIds(supabase, viewedGameweek, squadIds),
      searchPool({
        gameSlug: "eflfantasy",
        gameweek: viewedGameweek,
        excludeIds: squadIds,
        excludeClub: true,
        page: 1,
        pageSize: POOL_PAGE_SIZE,
      }),
      searchPool({
        gameSlug: "eflfantasy",
        gameweek: viewedGameweek,
        position: "CLUB",
        excludeIds: squadIds,
        page: 1,
        pageSize: POOL_PAGE_SIZE,
      }),
      listPoolTeams("eflfantasy"),
      supabase
        .from("squad_reserve_picks")
        .select("position, rank, game_player_id, game_players(players(id, full_name, team_id, teams!players_team_id_fkey(name)))")
        .eq("squad_id", squadId)
        .order("position")
        .order("rank")
        .returns<ReservePickRow[]>(),
      getTeamKickoffMap(supabase, game.id, viewedGameweek),
    ]);
    const scoreByGamePlayerId = new Map<number, number>(scoreRows.map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));
    // Per-player locking (real EFL Fantasy rule, user-confirmed 2026-08-20:
    // "a player is locked once they kick off ... it locks game by game") -
    // a team_id whose own fixture in the viewed gameweek has already kicked
    // off, not the gameweek-wide cutoff planningGameweek uses. Only
    // computed on the planning branch - past/locked-snapshot gameweeks are
    // already fully read-only for a different reason.
    lockedTeamIds = Array.from(teamKickoffMap.keys()).filter((teamId) => isTeamLocked(teamKickoffMap, teamId));

    // Reserve scores are a separate small fetch (not part of the squad's
    // score call above) since the reserve player ids aren't known until
    // the query above resolves - fine given the reserve list is only ever
    // a handful of players.
    const reserveGamePlayerIds = (reserveRowsRaw ?? []).map((r) => r.game_player_id);
    const reserveScoreRows = reserveGamePlayerIds.length > 0 ? await getProjectionsForPlayerIds(supabase, viewedGameweek, reserveGamePlayerIds) : [];
    const reserveScoreByGamePlayerId = new Map<number, number>(reserveScoreRows.map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));
    boardReserves = { DEF: [], MID: [], FWD: [] };
    for (const r of reserveRowsRaw ?? []) {
      boardReserves[r.position].push({
        game_player_id: r.game_player_id,
        full_name: r.game_players.players.full_name,
        team_name: r.game_players.players.teams.name,
        teamId: r.game_players.players.team_id,
        score: reserveScoreByGamePlayerId.get(r.game_player_id) ?? null,
        fixtures: buildFixtures(r.game_players.players.team_id),
      });
    }

    boardSquad = squadPlayers
      .filter((p) => p.position !== "CLUB")
      .map((p) => ({
        game_player_id: p.game_player_id,
        full_name: p.full_name,
        position: p.position as "GK" | "DEF" | "MID" | "FWD",
        team_name: p.team_name,
        teamId: p.team_id,
        score: scoreByGamePlayerId.get(p.game_player_id) ?? null,
        fixtures: buildFixtures(p.team_id),
      }));
    boardClubs = squadPlayers
      .filter((p) => p.position === "CLUB")
      .map((p) => ({
        game_player_id: p.game_player_id,
        // p.team_name (the real "Millwall") not p.full_name (the synthetic
        // "Millwall Team" row name, see migration 0087's docstring) - the
        // "Team" suffix exists only to disambiguate the DB row, never meant
        // for display.
        club_name: p.team_name,
        teamId: p.team_id,
        score: scoreByGamePlayerId.get(p.game_player_id) ?? null,
        fixtures: buildFixtures(p.team_id),
        nextFixtureLabel: nextFixtureLabelByTeamId.get(p.team_id) ?? null,
        lastSeasonAvgPoints: lastSeasonPointsByGamePlayerId.get(p.game_player_id) ?? null,
      }));

    boardPool = initialPool.rows.map((r) => ({
      game_player_id: r.game_player_id,
      full_name: r.full_name,
      position: r.position as "GK" | "DEF" | "MID" | "FWD",
      team_name: r.team_name,
      teamId: r.team_id,
      score: r.hail_mary_score,
      competition: r.competition,
      fixtures: buildFixtures(r.team_id),
      ownershipPct: r.ownershipPct,
      realTotalPoints: r.realTotalPoints,
      realMinutesPlayed: r.realMinutesPlayed,
      realGoals: r.realGoals,
      realAssists: r.realAssists,
      realCleanSheets: r.realCleanSheets,
      realSaves: r.realSaves,
      realTackles: r.realTackles,
      realClearances: r.realClearances,
      realBlocks: r.realBlocks,
      realInterceptions: r.realInterceptions,
      realKeyPasses: r.realKeyPasses,
      realShotsOnTarget: r.realShotsOnTarget,
      lastGw: r.lastGw,
      lastGwPoints: r.lastGwPoints,
    }));
    boardClubPool = initialClubPool.rows.map((r) => ({
      game_player_id: r.game_player_id,
      club_name: r.team_name,
      teamId: r.team_id,
      score: r.hail_mary_score,
      competition: r.competition,
      fixtures: buildFixtures(r.team_id),
      nextFixtureLabel: nextFixtureLabelByTeamId.get(r.team_id) ?? null,
      lastSeasonAvgPoints: lastSeasonPointsByGamePlayerId.get(r.game_player_id) ?? null,
    }));
    poolTotalCount = initialPool.totalCount;
    clubPoolTotalCount = initialClubPool.totalCount;
    teams = teamNames;

    // Save Team indicator (real user request 2026-08-19 - "we need the
    // save team button too... this should already be built", true for
    // every other game, just never wired in here) - only meaningful on
    // the current planning gameweek, the only one a save can target (see
    // eflfantasy/actions.ts's saveTeamForGameweek). No bench and no
    // squad-level captain here (identical shape to Cloud FF), so the
    // snapshot compares players only - CLUB picks included, since
    // squad_players covers both.
    if (isPlanningView) {
      const lock = await getSquadGameweekLock(supabase, squadId, planningGameweek);
      isTeamSaved = isSquadSaved(
        {
          players: squadPlayers.map((p) => ({ game_player_id: p.game_player_id, is_starting: true, bench_order: null })),
          captainGamePlayerId: null,
          viceCaptainGamePlayerId: null,
          activeBooster: null,
        },
        lock?.snapshot ?? null
      );
    }
  }

  const totalProjectedPoints =
    boardSquad.reduce((sum, p) => sum + (p.score ?? 0), 0) + boardClubs.reduce((sum, c) => sum + (c.score ?? 0), 0);

  // Season-to-date real total (2026-08-19 user request: "a large current
  // points total somewhere on the page") - sums every completed
  // gameweek's captain-doubled actual result, not just whichever one is
  // currently being viewed. Reuses totalProjectedPoints for the viewed
  // gameweek when it's itself a completed one (already computed above
  // from the same real actuals) rather than re-querying it.
  const completedGameweeks: number[] = [];
  for (let gw = gwInfo.minGameweek; gw < planningGameweek; gw++) completedGameweeks.push(gw);
  const otherGameweekTotals = await Promise.all(
    completedGameweeks.filter((gw) => gw !== viewedGameweek).map((gw) => getSquadActualPointsForGameweek(supabase, game.id, squadId, gw))
  );
  const viewedGameweekTotal = isPastView && pastViewState === null ? totalProjectedPoints : null;
  const allGameweekTotals = [...otherGameweekTotals, viewedGameweekTotal];
  const seasonTotalPoints = allGameweekTotals.some((t) => t != null)
    ? allGameweekTotals.reduce((sum: number, t) => sum + (t ?? 0), 0)
    : null;

  const squadSummary = isPlanningView
    ? buildSquadSummary({
        players: boardSquad.map((p) => ({ fullName: p.full_name, position: p.position, price: 0, score: p.score })),
        totalProjectedPoints,
        teamValue: 0,
        budgetRemaining: 0,
        hasBudget: false,
        captain: null,
        // Fixture/health-derived reasoning lives only in the full Ask Mary
        // analysis - deliberately not run on every squad-board page load,
        // same reasoning as dreamteam/page.tsx.
        topStrength: null,
        topWeakness: null,
        nextStepTransferCount: null,
        nextStepGameweek: null,
      })
    : [];

  // Real user request 2026-08-21 - see lib/projectionFreshness.ts.
  const projectionsUpdatedAt = await getProjectionFreshness(supabase, "eflfantasy");

  return (
    <EFLFantasyBoard
      squadId={squadId}
      squadName={squad.name}
      isTeamSaved={isTeamSaved}
      planningGameweek={planningGameweek}
      viewedGameweek={viewedGameweek}
      isPlanningView={isPlanningView}
      isPastView={isPastView}
      pastViewState={pastViewState}
      minGameweek={gwInfo.minGameweek}
      maxGameweek={gwInfo.maxGameweek}
      lockedTeamIds={lockedTeamIds}
      squad={boardSquad}
      pool={boardPool}
      poolTotalCount={poolTotalCount}
      clubs={boardClubs}
      clubPool={boardClubPool}
      clubPoolTotalCount={clubPoolTotalCount}
      teams={teams}
      squadSummary={squadSummary}
      actualTotalPoints={isPastView && pastViewState === null ? totalProjectedPoints : null}
      seasonTotalPoints={seasonTotalPoints}
      isPoolServerDriven={!isPastView}
      fixtureTiles={fixtureTilesRecord}
      reserves={boardReserves}
      projectionsUpdatedAt={projectionsUpdatedAt}
    />
  );
}

function abbreviate(teamName: string): string {
  return teamName
    .replace(/^(AFC|FC)\s+/, "")
    .replace(/\s+(FC|United|Town|City|Hotspur|Wanderers|Albion)$/, "")
    .slice(0, 3)
    .toUpperCase();
}
