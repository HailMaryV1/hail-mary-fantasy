import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getGameweekInfo, getProjectionsForPlayerIds, fetchAllPaginated } from "@/lib/gameweek";
import { getSquadGameweekLock, getActualPoints, resolvePlayerIdentities } from "@/lib/gameweekHistory";
import { searchPool, listPoolTeams } from "@/lib/poolSearch";
import { buildSquadSummary } from "@/lib/squadSummary";
import EFLFantasyBoard, { type BoardPlayer, type PoolPlayer, type BoardClub, type PoolClub, type FixtureTile, POOL_PAGE_SIZE } from "./EFLFantasyBoard";

export const dynamic = "force-dynamic";

type SquadRow = { id: number; name: string };

type SquadPlayerRow = {
  game_player_id: number;
  game_players: {
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD" | "CLUB"; team_id: number; teams: { name: string } };
  };
};

type ClubHistoryRow = { game_player_id: number; total_points: number | null };

type PoolRow = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD" | "CLUB";
  team_id: number;
  team_name: string;
  hail_mary_score: number | null;
  competition: string | null;
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

const LEAGUE_LABELS: Record<string, string> = {
  efl_championship: "Championship",
  efl_league_one: "League One",
  efl_league_two: "League Two",
};

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
      .select("game_player_id, full_name, position, team_id, team_name, hail_mary_score, competition")
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
      .select("game_player_id, game_players(players(full_name, position, team_id, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squadId)
      .returns<SquadPlayerRow[]>(),
    getGameweekInfo(supabase, game.id),
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
    full_name: sp.game_players.players.full_name,
    position: sp.game_players.players.position,
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

      boardSquad = lockedIdentities
        .filter((id) => id.position !== "CLUB")
        .map((id) => ({
          game_player_id: id.game_player_id,
          full_name: id.full_name,
          position: id.position as "GK" | "DEF" | "MID" | "FWD",
          team_name: id.team_name,
          score: actuals.get(id.game_player_id)?.points ?? null,
          fixtures: buildFixtures(id.team_id),
        }));
      boardClubs = lockedIdentities
        .filter((id) => id.position === "CLUB")
        .map((id) => ({
          game_player_id: id.game_player_id,
          club_name: id.team_name,
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
          score: actuals.get(p.game_player_id)?.points ?? null,
          competition: p.competition ? (LEAGUE_LABELS[p.competition] ?? p.competition) : null,
          fixtures: buildFixtures(p.team_id),
        }))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      boardClubPool = poolRaw
        .filter((p) => p.position === "CLUB" && !lockedIds.has(p.game_player_id))
        .map((p) => ({
          game_player_id: p.game_player_id,
          club_name: p.team_name,
          score: actuals.get(p.game_player_id)?.points ?? null,
          competition: p.competition ? (LEAGUE_LABELS[p.competition] ?? p.competition) : null,
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
    const [scoreRows, initialPool, initialClubPool, teamNames] = await Promise.all([
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
    ]);
    const scoreByGamePlayerId = new Map<number, number>(scoreRows.map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));

    boardSquad = squadPlayers
      .filter((p) => p.position !== "CLUB")
      .map((p) => ({
        game_player_id: p.game_player_id,
        full_name: p.full_name,
        position: p.position as "GK" | "DEF" | "MID" | "FWD",
        team_name: p.team_name,
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
      score: r.hail_mary_score,
      competition: r.competition ? (LEAGUE_LABELS[r.competition] ?? r.competition) : null,
      fixtures: buildFixtures(r.team_id),
    }));
    boardClubPool = initialClubPool.rows.map((r) => ({
      game_player_id: r.game_player_id,
      club_name: r.team_name,
      score: r.hail_mary_score,
      competition: r.competition ? (LEAGUE_LABELS[r.competition] ?? r.competition) : null,
      fixtures: buildFixtures(r.team_id),
      nextFixtureLabel: nextFixtureLabelByTeamId.get(r.team_id) ?? null,
      lastSeasonAvgPoints: lastSeasonPointsByGamePlayerId.get(r.game_player_id) ?? null,
    }));
    poolTotalCount = initialPool.totalCount;
    clubPoolTotalCount = initialClubPool.totalCount;
    teams = teamNames;
  }

  const totalProjectedPoints =
    boardSquad.reduce((sum, p) => sum + (p.score ?? 0), 0) + boardClubs.reduce((sum, c) => sum + (c.score ?? 0), 0);
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

  return (
    <EFLFantasyBoard
      squadId={squadId}
      squadName={squad.name}
      planningGameweek={planningGameweek}
      viewedGameweek={viewedGameweek}
      isPlanningView={isPlanningView}
      isPastView={isPastView}
      pastViewState={pastViewState}
      minGameweek={gwInfo.minGameweek}
      maxGameweek={gwInfo.maxGameweek}
      squad={boardSquad}
      pool={boardPool}
      poolTotalCount={poolTotalCount}
      clubs={boardClubs}
      clubPool={boardClubPool}
      clubPoolTotalCount={clubPoolTotalCount}
      teams={teams}
      squadSummary={squadSummary}
      isPoolServerDriven={!isPastView}
      fixtureTiles={fixtureTilesRecord}
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
