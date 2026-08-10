import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getGameweekInfo, getProjectionsForPlayerIds, type GameweekProjectionRow } from "@/lib/gameweek";
import { getSquadGameweekLock, getActualPoints, resolvePlayerIdentities } from "@/lib/gameweekHistory";
import { fetchRotationRiskByPlayerIds } from "@/lib/rotationRisk";
import { searchPool, listPoolTeams } from "@/lib/poolSearch";
import { buildSquadSummary } from "@/lib/squadSummary";
import CloudFFBoard, { type BoardPlayer, type PoolPlayer, type FixtureTile, POOL_PAGE_SIZE } from "./CloudFFBoard";

export const dynamic = "force-dynamic";

type SquadRow = { id: number; name: string };

type SquadPlayerRow = {
  game_player_id: number;
  game_players: {
    price: number;
    // Cloud FF's OWN classification, not the shared players.position which
    // can genuinely disagree with what this game calls a player (2026-08-08 fix).
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
  ownership_pct: number | null;
};

type FormationRow = { code: string; gk_count: number; def_count: number; mid_count: number; fwd_count: number };

// Shape of compute_projections.py's decomposed-scoring `inputs` blob -
// only the fields the "Sort by" dropdown needs, not the full structure.
type ProjectionInputs = {
  fixtures?: { stats?: { goal?: { projected?: number }; assist?: { projected?: number } } }[];
  reconciliation?: { bonus?: number };
};

export default async function CloudFFPage({ searchParams }: { searchParams: Promise<{ gameweek?: string }> }) {
  const { gameweek: gameweekParam } = await searchParams;
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", "cloudff").maybeSingle();

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
          <h1 className="mt-6 text-xl font-semibold text-white">Cloud FF</h1>
          <p className="mt-2 text-sm text-navy-300">No squad yet.</p>
        </main>
      </div>
    );
  }

  const squadId = squad.id;

  const [{ data: rulesRow }, { data: squadPlayersRaw }, gwInfo, { data: formationsRaw }] = await Promise.all([
    supabase.from("game_squad_rules").select("budget").eq("game_id", game.id).single(),
    supabase
      .from("squad_players")
      .select("game_player_id, game_players(price, position_code, players(id, full_name, team_id, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squadId)
      .returns<SquadPlayerRow[]>(),
    getGameweekInfo(supabase, game.id),
    // Cloud FF uses named formations despite having no bench (every squad
    // player counts as "starting") - formation is derived from the squad's
    // live position counts below, never user-picked.
    supabase.from("game_formations").select("code, gk_count, def_count, mid_count, fwd_count").eq("game_id", game.id).returns<FormationRow[]>(),
  ]);

  const rules = rulesRow ?? { budget: 100 };
  const planningGameweek = gwInfo.planningGameweek ?? 1;
  const formations = formationsRaw ?? [];
  const requestedGameweek = Number(gameweekParam);
  const viewedGameweek = Number.isInteger(requestedGameweek)
    ? Math.min(Math.max(requestedGameweek, gwInfo.minGameweek), gwInfo.maxGameweek)
    : planningGameweek;
  const isPlanningView = viewedGameweek === planningGameweek;
  const isPastView = viewedGameweek < planningGameweek;
  const squadIds = (squadPlayersRaw ?? []).map((sp) => sp.game_player_id);

  const [{ data: gwFixtureRows }, { data: difficultyRows }, scoreRows] = await Promise.all([
    supabase
      .from("game_fixture_gameweeks")
      .select("gameweek, fixtures(id, home_team_id, away_team_id, teams_home:teams!fixtures_home_team_id_fkey(name), teams_away:teams!fixtures_away_team_id_fkey(name))")
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
    fixtures: { id: number; home_team_id: number; away_team_id: number; teams_home: { name: string }; teams_away: { name: string } };
  };
  const tilesByTeamGw = new Map<string, FixtureTile>();
  for (const row of (gwFixtureRows ?? []) as unknown as GwFixtureRow[]) {
    const f = row.fixtures;
    for (const [teamId, oppName, isHome] of [
      [f.home_team_id, f.teams_away.name, true],
      [f.away_team_id, f.teams_home.name, false],
    ] as [number, string, boolean][]) {
      const key = `${teamId}:${row.gameweek}`;
      const { difficulty, source } = difficultyByFixtureTeam.get(`${f.id}:${teamId}`) ?? { difficulty: 0.5, source: "fdr" as const };
      tilesByTeamGw.set(key, { opponentAbbr: abbreviate(oppName), isHome, difficulty, source });
    }
  }
  // Plain-object mirror of tilesByTeamGw - see DreamTeamBoard.tsx's page
  // for why this crosses the server/client boundary as a prop instead of
  // being recomputed per pool row.
  const fixtureTilesRecord: Record<string, FixtureTile> = Object.fromEntries(tilesByTeamGw);
  const emptyStats = { goalProjected: 0, assistProjected: 0, bonusProjected: 0 };

  let boardSquad: BoardPlayer[];
  let teamValue: number;
  let bank: number;
  let boardPool: PoolPlayer[];
  let poolTotalCount = 0;
  let teams: string[] = [];
  let pastViewState: "not_locked" | "no_results_yet" | null = null;
  let formationCode: string | null;

  if (isPastView) {
    // Full pool fetch is fine to keep here rather than a server-driven
    // search - see DreamTeamBoard.tsx's page for why (rare path, scored
    // from real actuals, and Cloud FF's pool is well under PostgREST's
    // 1000-row cap anyway).
    const [lock, { data: poolRaw }] = await Promise.all([
      getSquadGameweekLock(supabase, squadId, viewedGameweek),
      supabase.from("game_player_pool").select("*").eq("game_slug", "cloudff").returns<PoolRow[]>(),
    ]);
    if (!lock) {
      boardSquad = [];
      teamValue = 0;
      bank = 0;
      boardPool = [];
      pastViewState = "not_locked";
      formationCode = null;
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
          fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${id.team_id}:${viewedGameweek + i}`) ?? null),
          ...emptyStats,
        }));
      teamValue = boardSquad.reduce((sum, p) => sum + p.price, 0);
      bank = Number(rules.budget) - teamValue;
      const lockedIds = new Set(lock.snapshot.players.map((p) => p.game_player_id));
      const poolRows = poolRaw ?? [];
      boardPool = poolRows
        .filter((p) => !lockedIds.has(p.game_player_id))
        .map((p) => ({
          game_player_id: p.game_player_id,
          full_name: p.full_name,
          position: p.position,
          team_name: p.team_name,
          price: Number(p.price),
          score: actuals.get(p.game_player_id)?.points ?? null,
          fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${p.team_id}:${viewedGameweek + i}`) ?? null),
          ...emptyStats,
        }))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      poolTotalCount = boardPool.length;
      teams = Array.from(new Set(poolRows.map((p) => p.team_name))).sort();

      const startingCounts = { GK: 0, DEF: 0, MID: 0, FWD: 0 } as Record<string, number>;
      for (const p of boardSquad) startingCounts[p.position] = (startingCounts[p.position] ?? 0) + 1;
      formationCode =
        formations.find(
          (f) => f.gk_count === startingCounts.GK && f.def_count === startingCounts.DEF && f.mid_count === startingCounts.MID && f.fwd_count === startingCounts.FWD
        )?.code ?? null;
    }
  } else {
    const squadPlayers = (squadPlayersRaw ?? []).map((sp) => ({
      game_player_id: sp.game_player_id,
      price: sp.game_players.price,
      player_id: sp.game_players.players.id,
      full_name: sp.game_players.players.full_name,
      position: sp.game_players.position_code,
      team_id: sp.game_players.players.team_id,
      team_name: sp.game_players.players.teams.name,
    }));
    teamValue = squadPlayers.reduce((sum, p) => sum + Number(p.price), 0);
    bank = Number(rules.budget) - teamValue;
    const rotationRiskByPlayerId = await fetchRotationRiskByPlayerIds(
      supabase,
      squadPlayers.map((p) => p.player_id),
      gwInfo.seasonStarted
    );

    const formationCounts = { GK: 0, DEF: 0, MID: 0, FWD: 0 } as Record<string, number>;
    for (const p of squadPlayers) formationCounts[p.position] = (formationCounts[p.position] ?? 0) + 1;
    formationCode =
      formations.find(
        (f) => f.gk_count === formationCounts.GK && f.def_count === formationCounts.DEF && f.mid_count === formationCounts.MID && f.fwd_count === formationCounts.FWD
      )?.code ?? null;

    const scoreByGamePlayerId = new Map<number, number>(scoreRows.map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));
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
      fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${p.team_id}:${viewedGameweek + i}`) ?? null),
      rotationRisk: rotationRiskByPlayerId.get(p.player_id) ?? null,
      ...(statsByGamePlayerId.get(p.game_player_id) ?? emptyStats),
    }));

    const [initialPool, teamNames] = await Promise.all([
      searchPool({
        gameSlug: "cloudff",
        gameweek: viewedGameweek,
        excludeIds: squadIds,
        page: 1,
        pageSize: POOL_PAGE_SIZE,
      }),
      listPoolTeams("cloudff"),
    ]);
    boardPool = initialPool.rows.map((r) => ({
      game_player_id: r.game_player_id,
      full_name: r.full_name,
      position: r.position as "GK" | "DEF" | "MID" | "FWD",
      team_name: r.team_name,
      price: r.price,
      score: r.hail_mary_score,
      fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${r.team_id}:${viewedGameweek + i}`) ?? null),
      goalProjected: r.goalProjected,
      assistProjected: r.assistProjected,
      bonusProjected: r.bonusProjected,
      ownershipPct: r.ownershipPct,
    }));
    poolTotalCount = initialPool.totalCount;
    teams = teamNames;
  }

  // No bench and no squad-level captain (Cloud FF's captain is picked per
  // real match-day, not once for the whole squad - see matchDayCaptains.ts)
  // - flat sum, no captain sentence.
  const totalProjectedPoints = boardSquad.reduce((sum, p) => sum + (p.score ?? 0), 0);
  const squadSummary = isPlanningView
    ? buildSquadSummary({
        players: boardSquad.map((p) => ({ fullName: p.full_name, position: p.position, price: p.price, score: p.score })),
        totalProjectedPoints,
        teamValue,
        budgetRemaining: bank,
        captain: null,
        // Fixture/health-derived reasoning and the forward-looking transfer
        // plan live only in the full Ask Mary analysis (runAskMaryAnalysis) -
        // deliberately not run on every squad-board page load, same reasoning
        // as dreamteam/page.tsx.
        topStrength: null,
        topWeakness: null,
        nextStepTransferCount: null,
        nextStepGameweek: null,
      })
    : [];

  return (
    <CloudFFBoard
      squadId={squadId}
      squadName={squad.name}
      bank={bank}
      teamValue={teamValue}
      planningGameweek={planningGameweek}
      viewedGameweek={viewedGameweek}
      isPlanningView={isPlanningView}
      isPastView={isPastView}
      pastViewState={pastViewState}
      minGameweek={gwInfo.minGameweek}
      maxGameweek={gwInfo.maxGameweek}
      formationCode={formationCode}
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
