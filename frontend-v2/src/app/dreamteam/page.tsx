import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getGameweekInfo, getProjectionsForPlayerIds, type GameweekProjectionRow } from "@/lib/gameweek";
import { getSquadGameweekLock, getActualPoints, resolvePlayerIdentities, isSquadSaved } from "@/lib/gameweekHistory";
import { fetchRotationRiskByPlayerIds } from "@/lib/rotationRisk";
import { fetchFfscoutStatusByPlayerIds } from "@/lib/ffscoutStatus";
import { searchPool, listPoolTeams } from "@/lib/poolSearch";
import { buildSquadSummary } from "@/lib/squadSummary";
import { getSquadProjectionTrend, type TrendPoint } from "@/lib/projectionTrend";
import DreamTeamBoard, { type BoardPlayer, type PoolPlayer, type FixtureTile, POOL_PAGE_SIZE } from "./DreamTeamBoard";

export const dynamic = "force-dynamic";

// Mirrors scripts/compute_projections.py's CUP_COMPETITIONS (same fixture
// dedup problem, same fix shape) - only Dream Team's game_competitions
// includes any of these (FanTeam/Cloud FF are soccer_epl-only, EFL
// Fantasy has no cup competitions at all), so this stays a no-op for
// every other game's own board file.
const CUP_COMPETITIONS = new Set([
  "soccer_england_efl_cup",
  "soccer_fa_cup",
  "soccer_uefa_champs_league",
  "soccer_uefa_champs_league_qualification",
  "soccer_uefa_europa_league",
  "soccer_uefa_europa_conference_league",
]);

type SquadRow = {
  id: number;
  name: string;
  free_transfers: number;
  active_booster: "goal_bonus" | "twelfth_man" | "max_captain" | null;
  active_booster_gameweek: number | null;
  goal_bonus_used_gameweek: number | null;
  twelfth_man_used_gameweek: number | null;
  max_captain_used_gameweek: number | null;
  captain_game_player_id: number | null;
  vice_captain_game_player_id: number | null;
};

type SquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  game_players: {
    price: number;
    // Dream Team's OWN classification (game_players.position_code) - not
    // players.position, which is shared across games and can genuinely
    // disagree with what this specific game calls a player (2026-08-08 fix).
    position_code: "GK" | "DEF" | "MID" | "FWD";
    players: { id: number; full_name: string; team_id: number; teams: { name: string } };
  };
};

type PoolRow = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  price: number;
  hail_mary_score: number | null;
  lineup: string | null;
  status: string | null;
};

// Shape of compute_projections.py's decomposed-scoring `inputs` blob -
// only the fields the "Sort by" dropdown needs, not the full structure.
type ProjectionInputs = {
  fixtures?: { stats?: { goal?: { projected?: number }; assist?: { projected?: number } } }[];
  reconciliation?: { bonus?: number };
};

export default async function DreamTeamPage({ searchParams }: { searchParams: Promise<{ gameweek?: string }> }) {
  const { gameweek: gameweekParam } = await searchParams;
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", "dreamteam").maybeSingle();

  const { data: squad } = game
    ? await supabase
        .from("squads")
        .select(
          "id, name, free_transfers, active_booster, active_booster_gameweek, goal_bonus_used_gameweek, twelfth_man_used_gameweek, max_captain_used_gameweek, captain_game_player_id, vice_captain_game_player_id"
        )
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
          <h1 className="mt-6 text-xl font-semibold text-white">Dream Team</h1>
          <p className="mt-2 text-sm text-navy-300">No squad yet.</p>
        </main>
      </div>
    );
  }

  const squadId = squad.id;

  const [{ data: rulesRow }, { data: squadPlayersRaw }, gwInfo, { count: substitutesUsed }] = await Promise.all([
    supabase.from("game_squad_rules").select("budget").eq("game_id", game.id).single(),
    supabase
      .from("squad_players")
      .select("game_player_id, is_starting, game_players(price, position_code, players(id, full_name, team_id, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squadId)
      .returns<SquadPlayerRow[]>(),
    getGameweekInfo(supabase, game.id),
    supabase.from("squad_substitutions").select("id", { count: "exact", head: true }).eq("squad_id", squadId),
  ]);

  const rules = rulesRow ?? { budget: 50 };
  const planningGameweek = gwInfo.planningGameweek ?? 1;
  const requestedGameweek = Number(gameweekParam);
  const viewedGameweek = Number.isInteger(requestedGameweek)
    ? Math.min(Math.max(requestedGameweek, gwInfo.minGameweek), gwInfo.maxGameweek)
    : planningGameweek;
  const isPlanningView = viewedGameweek === planningGameweek;
  const isPastView = viewedGameweek < planningGameweek;
  const squadIds = (squadPlayersRaw ?? []).map((sp) => sp.game_player_id);

  // Fixture-difficulty tiles for GW(viewed) through GW(viewed+5), per team -
  // reuses the existing team_fixture_difficulty table (already built for
  // the Fixtures page) rather than inventing a new source. Small and
  // game-wide (every team, not just the pool page on screen), so fetched
  // in full regardless of view - bundled with the squad's own real
  // projections (skipped for a past view, which doesn't need them) in one
  // parallel batch, rather than a separate awaited call after.
  const [{ data: gwFixtureRows }, { data: difficultyRows }, scoreRows] = await Promise.all([
    supabase
      .from("game_fixture_gameweeks")
      .select(
        "gameweek, fixtures(id, competition, home_team_id, away_team_id, created_at, teams_home:teams!fixtures_home_team_id_fkey(name), teams_away:teams!fixtures_away_team_id_fkey(name))"
      )
      .eq("game_id", game.id)
      .gte("gameweek", viewedGameweek)
      .lte("gameweek", viewedGameweek + 5),
    supabase.from("team_fixture_difficulty").select("fixture_id, team_id, attack_score, source").eq("game_id", game.id),
    isPastView
      ? Promise.resolve<GameweekProjectionRow<ProjectionInputs>[]>([])
      : getProjectionsForPlayerIds<ProjectionInputs>(supabase, viewedGameweek, squadIds),
  ]);
  const difficultyByFixtureTeam = new Map(
    (difficultyRows ?? []).map((d) => [`${d.fixture_id}:${d.team_id}`, { difficulty: Number(d.attack_score), source: d.source as "real_odds" | "fdr" }])
  );
  type GwFixtureRow = {
    gameweek: number;
    fixtures: {
      id: number;
      competition: string;
      home_team_id: number;
      away_team_id: number;
      created_at: string;
      teams_home: { name: string };
      teams_away: { name: string };
    };
  };
  const gwFixtureRowsTyped = (gwFixtureRows ?? []) as unknown as GwFixtureRow[];
  // Same dedup as compute_projections.py's fixture_meta/best_fixture_by_matchup
  // (FIXTURE_PROBABILITY_SELECT_SQL comment) - the Odds API sometimes carries
  // TWO rows for the same real tie (a provisional placeholder kickoff,
  // overwritten later by a row with the real broadcast time), both of which
  // can land in game_fixture_gameweeks for the same gameweek. That Python
  // fix never touched this frontend query - real user feedback 2026-08-18:
  // once the fixture lookup below moved from a single overwritten tile to an
  // array (to support the double-gameweek pill), this exact duplicate
  // started rendering as the SAME cup opponent shown twice for one gameweek
  // (Joao Pedro showing 3 "fixtures" instead of 2) - previously invisible
  // because the old single-tile overwrite silently collapsed it. Keep only
  // the most-recently-created row per (home, away, competition).
  const bestFixtureByMatchup = new Map<string, { id: number; createdAt: string }>();
  for (const row of gwFixtureRowsTyped) {
    const f = row.fixtures;
    const matchupKey = `${f.home_team_id}:${f.away_team_id}:${f.competition}`;
    const current = bestFixtureByMatchup.get(matchupKey);
    if (!current || f.created_at > current.createdAt) {
      bestFixtureByMatchup.set(matchupKey, { id: f.id, createdAt: f.created_at });
    }
  }
  const keepFixtureIds = new Set([...bestFixtureByMatchup.values()].map((v) => v.id));

  // A team can have TWO fixtures in the same gameweek window here - Dream
  // Team folds cup ties into whichever gameweek their kickoff falls in
  // (assign_dreamteam_cup_gameweeks.py), unlike FanTeam/Cloud FF (EPL-only
  // game_competitions) or EFL Fantasy (no cup competitions at all), which
  // never hit this. Real user feedback 2026-08-17: with only ONE tile slot
  // per (team, gameweek), Map.set() silently overwrote with whichever row
  // Postgrest happened to return last (no guaranteed order) - sometimes the
  // cup tie, sometimes the league game, arbitrarily. Now keyed to an ARRAY,
  // league-first (mirrors compute_projections.py's CUP_COMPETITIONS
  // primary-fixture fix), so both render as a double pill and the league
  // fixture is always the one shown first/alone in single-pill contexts.
  const tilesByTeamGw = new Map<string, FixtureTile[]>();
  for (const row of gwFixtureRowsTyped) {
    const f = row.fixtures;
    if (!keepFixtureIds.has(f.id)) continue;
    for (const [teamId, oppName, isHome] of [
      [f.home_team_id, f.teams_away.name, true],
      [f.away_team_id, f.teams_home.name, false],
    ] as [number, string, boolean][]) {
      const key = `${teamId}:${row.gameweek}`;
      const { difficulty, source } = difficultyByFixtureTeam.get(`${f.id}:${teamId}`) ?? { difficulty: 0.5, source: "fdr" as const };
      const isCup = CUP_COMPETITIONS.has(f.competition);
      const existing = tilesByTeamGw.get(key) ?? [];
      existing.push({ opponentAbbr: abbreviate(oppName), isHome, difficulty, source, isCup });
      existing.sort((a, b) => Number(a.isCup) - Number(b.isCup));
      tilesByTeamGw.set(key, existing);
    }
  }
  // Plain-object mirror of tilesByTeamGw - a Map can't cross the server/
  // client boundary as a prop, and the board needs this same lookup to
  // resolve fixtures for every pool page it fetches after the first.
  const fixtureTilesRecord: Record<string, FixtureTile[]> = Object.fromEntries(tilesByTeamGw);
  const emptyStats = { goalProjected: 0, assistProjected: 0, bonusProjected: 0 };

  let boardSquad: BoardPlayer[];
  let teamValue: number;
  let bank: number;
  let boardPool: PoolPlayer[];
  let poolTotalCount = 0;
  let teams: string[] = [];
  let isTeamSaved = false;
  let squadTrend: TrendPoint[] = [];
  let pastViewState: "not_locked" | "no_results_yet" | null = null;

  if (isPastView) {
    // Past gameweek - show the squad as it was actually locked in, not
    // today's (possibly since-transferred) live squad_players, plus real
    // actual points where they've been captured (see gameweekHistory.ts -
    // player_gameweek_results is empty for every game pre-season, so this
    // degrades to "not yet played" rather than a blank/broken page). Full
    // pool fetch is fine to keep here rather than a server-driven search -
    // a genuinely rare path (nobody can browse it until a real gameweek
    // finishes) that's scored from real actuals, not projections, and
    // Dream Team's whole pool is well under PostgREST's 1000-row cap
    // anyway (a single request, not the multi-page problem EFL Fantasy had).
    const [lock, { data: poolRaw }] = await Promise.all([
      getSquadGameweekLock(supabase, squadId, viewedGameweek),
      supabase.from("game_player_pool").select("*").eq("game_slug", "dreamteam").returns<PoolRow[]>(),
    ]);
    if (!lock) {
      boardSquad = [];
      teamValue = 0;
      bank = 0;
      boardPool = [];
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

      boardSquad = lock.snapshot.players
        .map((sp) => identities.get(sp.game_player_id))
        .filter((id): id is NonNullable<typeof id> => id != null)
        .map((id) => ({
          game_player_id: id.game_player_id,
          full_name: id.full_name,
          position: id.position as BoardPlayer["position"],
          team_name: id.team_name,
          price: id.price,
          score: actuals.get(id.game_player_id)?.points ?? null,
          isCaptain: id.game_player_id === lock.snapshot.captainGamePlayerId,
          isViceCaptain: id.game_player_id === lock.snapshot.viceCaptainGamePlayerId,
          fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${id.team_id}:${viewedGameweek + i}`) ?? []),
          ...emptyStats,
        }));
      teamValue = boardSquad.reduce((sum, p) => sum + p.price, 0);
      bank = Number(rules.budget) - teamValue;
      const poolRows = poolRaw ?? [];
      boardPool = poolRows
        .filter((p) => !lock.snapshot.players.some((sp) => sp.game_player_id === p.game_player_id))
        .map((p) => ({
          game_player_id: p.game_player_id,
          full_name: p.full_name,
          position: p.position,
          team_name: p.team_name,
          price: Number(p.price),
          score: actuals.get(p.game_player_id)?.points ?? null,
          fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${p.team_id}:${viewedGameweek + i}`) ?? []),
          ...emptyStats,
        }))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      poolTotalCount = boardPool.length;
      teams = Array.from(new Set(poolRows.map((p) => p.team_name))).sort();
    }
  } else {
    // Current planning gameweek, or a future preview - today's live squad,
    // with that specific gameweek's real computed projections. The pool's
    // browse table gets its own scores from search_game_player_pool
    // instead (via DreamTeamBoard's on-demand fetch), never a whole-pool
    // read here.
    const squadPlayers = (squadPlayersRaw ?? []).map((sp) => ({
      game_player_id: sp.game_player_id,
      is_starting: sp.is_starting,
      price: sp.game_players.price,
      player_id: sp.game_players.players.id,
      full_name: sp.game_players.players.full_name,
      position: sp.game_players.position_code,
      team_id: sp.game_players.players.team_id,
      team_name: sp.game_players.players.teams.name,
    }));
    const rotationRiskByPlayerId = await fetchRotationRiskByPlayerIds(
      supabase,
      squadPlayers.map((p) => p.player_id)
    );
    const ffscoutStatusByPlayerId = await fetchFfscoutStatusByPlayerIds(
      supabase,
      squadPlayers.map((p) => p.player_id)
    );
    teamValue = squadPlayers.reduce((sum, p) => sum + Number(p.price), 0);
    bank = Number(rules.budget) - teamValue;

    const scoreByGamePlayerId = new Map<number, number>(scoreRows.map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));
    // Real projected goals/assists/bonus for the "Sort by" dropdown - pulled
    // straight from the same decomposed-scoring inputs compute_projections.py
    // already writes (primary fixture's stat projections + Dream Team's PPM
    // bonus reconciliation), not a second guess at the same numbers.
    const statsByGamePlayerId = new Map<number, { goalProjected: number; assistProjected: number; bonusProjected: number }>(
      scoreRows.map((r) => {
        const primaryStats = r.inputs?.fixtures?.[0]?.stats;
        return [
          r.game_player_id,
          {
            goalProjected: Number(primaryStats?.goal?.projected ?? 0),
            assistProjected: Number(primaryStats?.assist?.projected ?? 0),
            bonusProjected: Number(r.inputs?.reconciliation?.bonus ?? 0),
          },
        ];
      })
    );

    boardSquad = squadPlayers.map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      position: p.position,
      team_name: p.team_name,
      price: Number(p.price),
      score: scoreByGamePlayerId.get(p.game_player_id) ?? null,
      isCaptain: p.game_player_id === squad.captain_game_player_id,
      isViceCaptain: p.game_player_id === squad.vice_captain_game_player_id,
      fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${p.team_id}:${viewedGameweek + i}`) ?? []),
      rotationRisk: rotationRiskByPlayerId.get(p.player_id) ?? null,
      ffscoutStatus: ffscoutStatusByPlayerId.get(p.player_id)?.status ?? null,
      ffscoutStartProbability: ffscoutStatusByPlayerId.get(p.player_id)?.startProbability ?? null,
      ...(statsByGamePlayerId.get(p.game_player_id) ?? emptyStats),
    }));

    // Save Team indicator (real user request 2026-08-18) - only meaningful
    // on the current planning gameweek, the only one a save can target
    // (see dreamteam/actions.ts's saveTeamForGameweek). Dream Team has no
    // bench, so every squad member is is_starting:true/bench_order:null,
    // same shape the save action itself writes.
    if (isPlanningView) {
      const lock = await getSquadGameweekLock(supabase, squadId, planningGameweek);
      isTeamSaved = isSquadSaved(
        {
          players: squadPlayers.map((p) => ({ game_player_id: p.game_player_id, is_starting: true, bench_order: null })),
          captainGamePlayerId: squad.captain_game_player_id,
          viceCaptainGamePlayerId: squad.vice_captain_game_player_id,
          activeBooster: squad.active_booster_gameweek === planningGameweek ? squad.active_booster : null,
        },
        lock?.snapshot ?? null
      );
      // Squad projection trend (real user request 2026-08-18) - "if you
      // kept this exact squad, here's where your points are heading" over
      // the next few gameweeks, same framing as Ask Mary's own
      // PLANNING_LOOKAHEAD_GAMEWEEKS.
      squadTrend = await getSquadProjectionTrend(supabase, squadIds, planningGameweek);
    }

    const [initialPool, teamNames] = await Promise.all([
      searchPool({
        gameSlug: "dreamteam",
        gameweek: viewedGameweek,
        excludeIds: squadIds,
        page: 1,
        pageSize: POOL_PAGE_SIZE,
      }),
      listPoolTeams("dreamteam"),
    ]);
    boardPool = initialPool.rows.map((r) => ({
      game_player_id: r.game_player_id,
      full_name: r.full_name,
      position: r.position as "GK" | "DEF" | "MID" | "FWD",
      team_name: r.team_name,
      price: r.price,
      score: r.hail_mary_score,
      fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${r.team_id}:${viewedGameweek + i}`) ?? []),
      goalProjected: r.goalProjected,
      assistProjected: r.assistProjected,
      bonusProjected: r.bonusProjected,
      ffscoutStatus: r.ffscoutStatus,
      ffscoutStartProbability: r.ffscoutStartProbability,
      rotationRisk: r.rotationRisk,
    }));
    poolTotalCount = initialPool.totalCount;
    teams = teamNames;
  }

  const totalProjectedPoints = boardSquad.reduce((sum, p) => sum + (p.score ?? 0), 0);
  const currentCaptain = boardSquad.find((p) => p.isCaptain);
  const squadSummary = isPlanningView
    ? buildSquadSummary({
        players: boardSquad.map((p) => ({ fullName: p.full_name, position: p.position, price: p.price, score: p.score })),
        totalProjectedPoints,
        teamValue,
        budgetRemaining: bank,
        captain: currentCaptain ? { fullName: currentCaptain.full_name, score: currentCaptain.score ?? 0 } : null,
        // Fixture/health-derived reasoning and the forward-looking transfer
        // plan live only in the full Ask Mary analysis (runAskMaryAnalysis) -
        // deliberately not run on every squad-board page load, since it's a
        // real multi-gameweek search plus prediction-recording pass, not a
        // cheap read. The summary here uses only data this page already has.
        topStrength: null,
        topWeakness: null,
        nextStepTransferCount: null,
        nextStepGameweek: null,
      })
    : [];

  return (
    <DreamTeamBoard
      squadId={squadId}
      squadName={squad.name}
      transfers={squad.free_transfers}
      bank={bank}
      teamValue={teamValue}
      isTeamSaved={isTeamSaved}
      squadTrend={squadTrend}
      planningGameweek={planningGameweek}
      viewedGameweek={viewedGameweek}
      isPlanningView={isPlanningView}
      isPastView={isPastView}
      pastViewState={pastViewState}
      minGameweek={gwInfo.minGameweek}
      maxGameweek={gwInfo.maxGameweek}
      boosters={{
        active: squad.active_booster,
        activeGameweek: squad.active_booster_gameweek,
        goalBonusUsed: squad.goal_bonus_used_gameweek != null,
        twelfthManUsed: squad.twelfth_man_used_gameweek != null,
        maxCaptainUsed: squad.max_captain_used_gameweek != null,
      }}
      substitutesUsed={substitutesUsed ?? 0}
      seasonStarted={gwInfo.seasonStarted}
      squad={boardSquad}
      pool={boardPool}
      poolTotalCount={poolTotalCount}
      teams={teams}
      fixtureTiles={fixtureTilesRecord}
      isPoolServerDriven={!isPastView}
      squadSummary={squadSummary}
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
