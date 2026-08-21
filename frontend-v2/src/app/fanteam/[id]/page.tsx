import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getGameweekInfo, getProjectionsForPlayerIds, type GameweekProjectionRow } from "@/lib/gameweek";
import { getSquadGameweekLock, getActualPoints, resolvePlayerIdentities, isSquadSaved } from "@/lib/gameweekHistory";
import { fetchRotationRiskByPlayerIds } from "@/lib/rotationRisk";
import { fetchFfscoutStatusByPlayerIds } from "@/lib/ffscoutStatus";
import { searchPool, listPoolTeams } from "@/lib/poolSearch";
import { getProjectionFreshness } from "@/lib/projectionFreshness";
import { buildSquadSummary } from "@/lib/squadSummary";
import FanTeamBoard, { type BoardPlayer, type PoolPlayer, type FixtureTile, POOL_PAGE_SIZE } from "./FanTeamBoard";

export const dynamic = "force-dynamic";

type SquadRow = {
  id: number;
  name: string;
  user_id: string;
  game_id: number;
  free_transfers: number;
  wildcard_1_used_gameweek: number | null;
  wildcard_2_used_gameweek: number | null;
  captain_game_player_id: number | null;
  vice_captain_game_player_id: number | null;
  fantasy_games: { slug: string } | { slug: string }[];
};

type FanteamSquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  bench_order: number | null;
  game_players: {
    price: number;
    // FanTeam's OWN classification, not the shared players.position which
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
  lineup: string | null;
  status: string | null;
};

// Shape of compute_projections.py's decomposed-scoring `inputs` blob -
// only the fields the "Sort by" dropdown needs, not the full structure.
type ProjectionInputs = {
  fixtures?: { stats?: { goal?: { projected?: number }; assist?: { projected?: number } } }[];
  reconciliation?: { bonus?: number };
};

export default async function FanTeamSquadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ gameweek?: string }>;
}) {
  const { id } = await params;
  const { gameweek: gameweekParam } = await searchParams;
  const squadId = Number(id);

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: squad } = await supabase
    .from("squads")
    .select(
      "id, name, user_id, game_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek, captain_game_player_id, vice_captain_game_player_id, fantasy_games(slug)"
    )
    .eq("id", squadId)
    .single<SquadRow>();
  if (!squad || squad.user_id !== user.id) notFound();

  const game = Array.isArray(squad.fantasy_games) ? squad.fantasy_games[0] : squad.fantasy_games;
  if (!game || game.slug !== "fanteam") notFound();

  const [{ data: rulesRow }, { data: squadPlayersRaw }, gwInfo, { data: formationsRaw }, { data: linkRow }] = await Promise.all([
    supabase.from("game_squad_rules").select("budget, max_per_club").eq("game_id", squad.game_id).single(),
    supabase
      .from("squad_players")
      .select(
        "game_player_id, is_starting, bench_order, game_players(price, position_code, players(id, full_name, team_id, teams!players_team_id_fkey(name)))"
      )
      .eq("squad_id", squadId)
      .returns<FanteamSquadPlayerRow[]>(),
    getGameweekInfo(supabase, squad.game_id),
    supabase
      .from("game_formations")
      .select("code, gk_count, def_count, mid_count, fwd_count")
      .eq("game_id", squad.game_id)
      .returns<{ code: string; gk_count: number; def_count: number; mid_count: number; fwd_count: number }[]>(),
    supabase.from("provider_squad_links").select("sync_enabled").eq("squad_id", squadId).maybeSingle(),
  ]);

  const rules = rulesRow ?? { budget: 100, max_per_club: 3 };
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
      .eq("game_id", squad.game_id)
      .gte("gameweek", viewedGameweek)
      .lte("gameweek", viewedGameweek + 5),
    supabase.from("team_fixture_difficulty").select("fixture_id, team_id, attack_score, source").eq("game_id", squad.game_id),
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
  let rawCaptainId = squad.captain_game_player_id;
  let rawViceCaptainId = squad.vice_captain_game_player_id;
  let isTeamSaved = false;

  if (isPastView) {
    // Full pool fetch is fine to keep here rather than a server-driven
    // search - see DreamTeamBoard.tsx's page for why (rare path, scored
    // from real actuals, and FanTeam's pool is well under PostgREST's
    // 1000-row cap anyway).
    const [lock, { data: poolRaw }] = await Promise.all([
      getSquadGameweekLock(supabase, squadId, viewedGameweek),
      supabase.from("game_player_pool").select("*").eq("game_slug", "fanteam").returns<PoolRow[]>(),
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
        getActualPoints(supabase, squad.game_id, viewedGameweek),
      ]);
      const hasAnyResult = lock.snapshot.players.some((p) => actuals.get(p.game_player_id)?.points != null);
      pastViewState = hasAnyResult ? null : "no_results_yet";
      rawCaptainId = lock.snapshot.captainGamePlayerId;
      rawViceCaptainId = lock.snapshot.viceCaptainGamePlayerId;

      boardSquad = lock.snapshot.players
        .map((sp) => ({ sp, id: identities.get(sp.game_player_id) }))
        .filter((r): r is { sp: (typeof lock.snapshot.players)[number]; id: NonNullable<ReturnType<typeof identities.get>> } => r.id != null)
        .map(({ sp, id }) => ({
          game_player_id: id.game_player_id,
          full_name: id.full_name,
          position: id.position as BoardPlayer["position"],
          team_name: id.team_name,
          team_id: id.team_id,
          price: id.price,
          score: actuals.get(id.game_player_id)?.points ?? null,
          isCaptain: id.game_player_id === lock.snapshot.captainGamePlayerId,
          isViceCaptain: id.game_player_id === lock.snapshot.viceCaptainGamePlayerId,
          isStarting: sp.is_starting,
          benchOrder: sp.bench_order,
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
          team_id: p.team_id,
          price: Number(p.price),
          score: actuals.get(p.game_player_id)?.points ?? null,
          fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${p.team_id}:${viewedGameweek + i}`) ?? null),
          ...emptyStats,
        }))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      poolTotalCount = boardPool.length;
      teams = Array.from(new Set(poolRows.map((p) => p.team_name))).sort();
    }
  } else {
    const squadPlayers = (squadPlayersRaw ?? []).map((sp) => ({
      game_player_id: sp.game_player_id,
      is_starting: sp.is_starting,
      bench_order: sp.bench_order,
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
      squadPlayers.map((p) => p.player_id)
    );
    const ffscoutStatusByPlayerId = await fetchFfscoutStatusByPlayerIds(
      supabase,
      squadPlayers.map((p) => p.player_id)
    );

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
      team_id: p.team_id,
      price: Number(p.price),
      score: scoreByGamePlayerId.get(p.game_player_id) ?? null,
      isCaptain: p.game_player_id === squad.captain_game_player_id,
      isViceCaptain: p.game_player_id === squad.vice_captain_game_player_id,
      isStarting: p.is_starting,
      benchOrder: p.bench_order,
      fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${p.team_id}:${viewedGameweek + i}`) ?? null),
      rotationRisk: rotationRiskByPlayerId.get(p.player_id) ?? null,
      ffscoutStatus: ffscoutStatusByPlayerId.get(p.player_id)?.status ?? null,
      ffscoutStartProbability: ffscoutStatusByPlayerId.get(p.player_id)?.startProbability ?? null,
      ffscoutDetail: ffscoutStatusByPlayerId.get(p.player_id)?.detail ?? null,
      ffscoutExpectedReturnDate: ffscoutStatusByPlayerId.get(p.player_id)?.expectedReturnDate ?? null,
      ...(statsByGamePlayerId.get(p.game_player_id) ?? emptyStats),
    }));

    // Save Team indicator (real user request 2026-08-18) - only meaningful
    // on the current planning gameweek, the only one a save can target
    // (see fanteam/actions.ts's saveTeamForGameweek).
    if (isPlanningView) {
      const lock = await getSquadGameweekLock(supabase, squadId, planningGameweek);
      isTeamSaved = isSquadSaved(
        {
          players: squadPlayers.map((p) => ({ game_player_id: p.game_player_id, is_starting: p.is_starting, bench_order: p.bench_order })),
          captainGamePlayerId: squad.captain_game_player_id,
          viceCaptainGamePlayerId: squad.vice_captain_game_player_id,
          activeBooster: null,
        },
        lock?.snapshot ?? null
      );
    }

    const [initialPool, teamNames] = await Promise.all([
      searchPool({
        gameSlug: "fanteam",
        gameweek: viewedGameweek,
        excludeIds: squadIds,
        page: 1,
        pageSize: POOL_PAGE_SIZE,
      }),
      listPoolTeams("fanteam"),
    ]);
    boardPool = initialPool.rows.map((r) => ({
      game_player_id: r.game_player_id,
      full_name: r.full_name,
      position: r.position as "GK" | "DEF" | "MID" | "FWD",
      team_name: r.team_name,
      team_id: r.team_id,
      price: r.price,
      score: r.hail_mary_score,
      fixtures: Array.from({ length: 6 }, (_, i) => tilesByTeamGw.get(`${r.team_id}:${viewedGameweek + i}`) ?? null),
      goalProjected: r.goalProjected,
      assistProjected: r.assistProjected,
      bonusProjected: r.bonusProjected,
      ffscoutStatus: r.ffscoutStatus,
      ffscoutStartProbability: r.ffscoutStartProbability,
      ffscoutDetail: r.ffscoutDetail,
      ffscoutExpectedReturnDate: r.ffscoutExpectedReturnDate,
      rotationRisk: r.rotationRisk,
    }));
    poolTotalCount = initialPool.totalCount;
    teams = teamNames;
  }

  // Starting XI only (captain doubled), matching FanTeamBoard.tsx's own
  // client-side projectedPoints formula exactly - a bench player's score
  // isn't part of what this squad is actually projected to return.
  const totalProjectedPoints = boardSquad
    .filter((p) => p.isStarting)
    .reduce((sum, p) => sum + (p.score ?? 0) * (p.isCaptain ? 2 : 1), 0);
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
        // deliberately not run on every squad-board page load, same reasoning
        // as dreamteam/page.tsx.
        topStrength: null,
        topWeakness: null,
        nextStepTransferCount: null,
        nextStepGameweek: null,
      })
    : [];

  const startingCounts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of boardSquad) if (p.isStarting) startingCounts[p.position as "GK" | "DEF" | "MID" | "FWD"] += 1;
  const currentFormationCode =
    formations.find(
      (f) => f.gk_count === startingCounts.GK && f.def_count === startingCounts.DEF && f.mid_count === startingCounts.MID && f.fwd_count === startingCounts.FWD
    )?.code ?? null;

  // Real user request 2026-08-21 - see lib/projectionFreshness.ts.
  const projectionsUpdatedAt = await getProjectionFreshness(supabase, "fanteam");

  return (
    <FanTeamBoard
      squadId={squadId}
      squadName={squad.name}
      transfers={squad.free_transfers}
      bank={bank}
      teamValue={teamValue}
      isTeamSaved={isTeamSaved}
      planningGameweek={planningGameweek}
      viewedGameweek={viewedGameweek}
      isPlanningView={isPlanningView}
      isPastView={isPastView}
      pastViewState={pastViewState}
      minGameweek={gwInfo.minGameweek}
      maxGameweek={gwInfo.maxGameweek}
      wildcard1UsedGameweek={squad.wildcard_1_used_gameweek}
      wildcard2UsedGameweek={squad.wildcard_2_used_gameweek}
      maxPerClub={Number(rules.max_per_club ?? 3)}
      seasonStarted={gwInfo.seasonStarted}
      formations={formations}
      currentFormationCode={currentFormationCode}
      isProviderSynced={linkRow?.sync_enabled ?? false}
      rawCaptainId={rawCaptainId}
      rawViceCaptainId={rawViceCaptainId}
      squad={boardSquad}
      pool={boardPool}
      poolTotalCount={poolTotalCount}
      teams={teams}
      fixtureTiles={fixtureTilesRecord}
      isPoolServerDriven={!isPastView}
      squadSummary={squadSummary}
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
