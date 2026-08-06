import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming, getGameweekRange, getProjectionsForGameweek } from "@/lib/gameweek";
import { getSquadGameweekLock, getActualPoints, resolvePlayerIdentities } from "@/lib/gameweekHistory";
import { buildSquadSummary } from "@/lib/squadSummary";
import EFLFantasyBoard, { type BoardPlayer, type PoolPlayer, type BoardClub, type PoolClub } from "./EFLFantasyBoard";

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
    home_team_id: number;
    away_team_id: number;
    home: { name: string };
    away: { name: string };
  } | null;
};

const LEAGUE_LABELS: Record<string, string> = {
  efl_championship: "Championship",
  efl_league_one: "League One",
  efl_league_two: "League Two",
};

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

// EFL Fantasy's combined pool (3,386 players + 72 clubs = 3,458 rows) is
// the first squad-pool query in this app to exceed PostgREST's row cap -
// confirmed live via a direct REST call that even an explicit
// .limit(4000) still comes back truncated at exactly 1000 rows
// (Content-Range: 0-999/3458), because the cap is enforced server-side
// (Supabase project's db-max-rows setting), not by whatever the client
// asks for. Without this, clubs whose players happened to sort past row
// 1000 (e.g. Blackburn Rovers) silently showed only a handful of their
// real ~47 registered players in the pool/team filter, with no error
// anywhere (same class of bug already documented in this repo's memory
// from an earlier player_gameweek_predictions incident) - paginating in
// 1000-row pages is the only fix that actually gets every row.
async function fetchAllPoolRows(supabase: Supabase, gameSlug: string): Promise<PoolRow[]> {
  const PAGE_SIZE = 1000;
  const rows: PoolRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data } = await supabase
      .from("game_player_pool")
      .select("game_player_id, full_name, position, team_id, team_name, hail_mary_score, competition")
      .eq("game_slug", gameSlug)
      .range(from, from + PAGE_SIZE - 1)
      .returns<PoolRow[]>();
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
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
          <Link href="/" className="text-sm font-medium text-navy-400 hover:text-sky-400">
            ← Back to main menu
          </Link>
          <h1 className="mt-6 text-xl font-semibold text-white">EFL Fantasy</h1>
          <p className="mt-2 text-sm text-navy-300">No squad yet.</p>
        </main>
      </div>
    );
  }

  const squadId = squad.id;

  const [{ data: squadPlayersRaw }, poolRaw, seasonTiming, gwRange, { data: clubHistoryRaw }] = await Promise.all([
    supabase
      .from("squad_players")
      .select("game_player_id, game_players(players(full_name, position, team_id, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squadId)
      .returns<SquadPlayerRow[]>(),
    fetchAllPoolRows(supabase, "eflfantasy"),
    getSeasonTiming(supabase, game.id),
    getGameweekRange(supabase, game.id),
    supabase
      .from("game_player_stats")
      .select("game_player_id, total_points, game_players!inner(game_id, position_code)")
      .eq("game_players.game_id", game.id)
      .eq("game_players.position_code", "CLUB")
      .eq("season", "2025/26")
      .eq("gameweek", 0)
      .returns<ClubHistoryRow[]>(),
  ]);

  const planningGameweek = seasonTiming.planningGameweek ?? 1;
  const requestedGameweek = Number(gameweekParam);
  const viewedGameweek = Number.isInteger(requestedGameweek)
    ? Math.min(Math.max(requestedGameweek, gwRange.minGameweek), gwRange.maxGameweek)
    : planningGameweek;
  const isPlanningView = viewedGameweek === planningGameweek;
  const isPastView = viewedGameweek < planningGameweek;

  // The fixture (if any) each team plays in the gameweek being viewed -
  // not "soonest future fixture from today" (that only ever matched the
  // planning gameweek), so this stays correct when browsing any week.
  const { data: fixturesRaw } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures(home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))")
    .eq("game_id", game.id)
    .eq("gameweek", viewedGameweek)
    .returns<FixtureRow[]>();

  const nextFixtureByTeamId = new Map<number, { opponent: string; isHome: boolean; gameweek: number }>();
  for (const row of fixturesRaw ?? []) {
    const f = row.fixtures;
    if (!f) continue;
    if (!nextFixtureByTeamId.has(f.home_team_id)) {
      nextFixtureByTeamId.set(f.home_team_id, { opponent: f.away.name, isHome: true, gameweek: row.gameweek });
    }
    if (!nextFixtureByTeamId.has(f.away_team_id)) {
      nextFixtureByTeamId.set(f.away_team_id, { opponent: f.home.name, isHome: false, gameweek: row.gameweek });
    }
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
  let pastViewState: "not_locked" | "no_results_yet" | null = null;

  if (isPastView) {
    const lock = await getSquadGameweekLock(supabase, squadId, viewedGameweek);
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
          nextFixture: nextFixtureByTeamId.get(id.team_id) ?? null,
        }));
      boardClubs = lockedIdentities
        .filter((id) => id.position === "CLUB")
        .map((id) => ({
          game_player_id: id.game_player_id,
          club_name: id.team_name,
          score: actuals.get(id.game_player_id)?.points ?? null,
          nextFixture: nextFixtureByTeamId.get(id.team_id) ?? null,
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
          nextFixture: nextFixtureByTeamId.get(p.team_id) ?? null,
        }))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      boardClubPool = poolRaw
        .filter((p) => p.position === "CLUB" && !lockedIds.has(p.game_player_id))
        .map((p) => ({
          game_player_id: p.game_player_id,
          club_name: p.team_name,
          score: actuals.get(p.game_player_id)?.points ?? null,
          competition: p.competition ? (LEAGUE_LABELS[p.competition] ?? p.competition) : null,
          nextFixture: nextFixtureByTeamId.get(p.team_id) ?? null,
          lastSeasonAvgPoints: lastSeasonPointsByGamePlayerId.get(p.game_player_id) ?? null,
        }))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    }
  } else {
    const squadPlayers = (squadPlayersRaw ?? []).map((sp) => ({
      game_player_id: sp.game_player_id,
      full_name: sp.game_players.players.full_name,
      position: sp.game_players.players.position,
      team_id: sp.game_players.players.team_id,
      team_name: sp.game_players.players.teams.name,
    }));
    const squadIds = new Set(squadPlayers.map((p) => p.game_player_id));

    // Real per-gameweek scores for whichever week is being viewed - covers
    // both players and clubs in one query (club picks go through the same
    // projections table, see compute_club_scores()).
    const scoreRows = await getProjectionsForGameweek(supabase, game.id, viewedGameweek);
    const scoreByGamePlayerId = new Map<number, number>(scoreRows.map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));

    boardSquad = squadPlayers
      .filter((p) => p.position !== "CLUB")
      .map((p) => ({
        game_player_id: p.game_player_id,
        full_name: p.full_name,
        position: p.position as "GK" | "DEF" | "MID" | "FWD",
        team_name: p.team_name,
        score: scoreByGamePlayerId.get(p.game_player_id) ?? null,
        nextFixture: nextFixtureByTeamId.get(p.team_id) ?? null,
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
        nextFixture: nextFixtureByTeamId.get(p.team_id) ?? null,
        lastSeasonAvgPoints: lastSeasonPointsByGamePlayerId.get(p.game_player_id) ?? null,
      }));

    boardPool = poolRaw
      .filter((p) => p.position !== "CLUB" && !squadIds.has(p.game_player_id))
      .map((p) => ({
        game_player_id: p.game_player_id,
        full_name: p.full_name,
        position: p.position as "GK" | "DEF" | "MID" | "FWD",
        team_name: p.team_name,
        score: scoreByGamePlayerId.get(p.game_player_id) ?? p.hail_mary_score,
        competition: p.competition ? (LEAGUE_LABELS[p.competition] ?? p.competition) : null,
        nextFixture: nextFixtureByTeamId.get(p.team_id) ?? null,
      }))
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

    boardClubPool = poolRaw
      .filter((p) => p.position === "CLUB" && !squadIds.has(p.game_player_id))
      .map((p) => ({
        game_player_id: p.game_player_id,
        club_name: p.team_name,
        score: scoreByGamePlayerId.get(p.game_player_id) ?? p.hail_mary_score,
        competition: p.competition ? (LEAGUE_LABELS[p.competition] ?? p.competition) : null,
        nextFixture: nextFixtureByTeamId.get(p.team_id) ?? null,
        lastSeasonAvgPoints: lastSeasonPointsByGamePlayerId.get(p.game_player_id) ?? null,
      }))
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
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
      minGameweek={gwRange.minGameweek}
      maxGameweek={gwRange.maxGameweek}
      squad={boardSquad}
      pool={boardPool}
      clubs={boardClubs}
      clubPool={boardClubPool}
      squadSummary={squadSummary}
    />
  );
}
