import Link from "next/link";
import { notFound } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { findBuyCandidatesForOutgoing, type TransferCandidate } from "@/lib/transferMatching";
import { getTeamColors } from "@/lib/teamColors";
import TransferPlanner from "./TransferPlanner";
import TransferBoard from "./TransferBoard";
import RecentTransfers from "./RecentTransfers";
import FixtureSwingPanel from "./FixtureSwingPanel";

const GAMEWEEK_PREVIEW_COUNT = 5;

type FixtureJoinRow = {
  gameweek: number;
  fixtures: {
    id: number;
    home_team_id: number;
    away_team_id: number;
    home: { name: string };
    away: { name: string };
  } | null;
};

// See rankings/page.tsx for why this is needed - Supabase's .rpc() POSTs
// to a fixed URL regardless of parameters, so Next's fetch Data Cache can
// serve a stale horizon's response for a different horizon's request.
export const dynamic = "force-dynamic";

type SquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  game_players: {
    price: number;
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD"; team_id: number; teams: { name: string } };
  };
};

type PoolPlayer = {
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

type HorizonRow = { game_player_id: number; avg_score: number };

const HORIZONS = [
  { key: "short", label: "Short (1 GW)", gameweeks: 1 },
  { key: "medium", label: "Medium (2 GW avg)", gameweeks: 2 },
  { key: "long", label: "Long (3 GW avg)", gameweeks: 3 },
] as const;

export type Recommendation = {
  outGamePlayerId: number;
  outName: string;
  outTeam: string;
  outPrice: number;
  outScore: number;
  inGamePlayerId: number;
  inName: string;
  inTeam: string;
  inPrice: number;
  inScore: number;
  delta: number;
  position: string;
};

export default async function TransfersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ horizon?: string; gw?: string }>;
}) {
  const { id } = await params;
  const { horizon: horizonParam, gw: gwParam } = await searchParams;
  const squadId = Number(id);
  if (!Number.isInteger(squadId)) notFound();
  const activeHorizon = HORIZONS.find((h) => h.key === horizonParam) ?? HORIZONS[0];

  function pageUrl(overrides: Partial<{ horizon: string; gw: string }>) {
    const params = new URLSearchParams();
    params.set("horizon", overrides.horizon ?? activeHorizon.key);
    params.set("gw", overrides.gw ?? String(viewGameweek));
    return `/squads/${squadId}/transfers?${params.toString()}`;
  }

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: squad } = await supabase
    .from("squads")
    .select(
      "id, name, user_id, game_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek, fantasy_games(slug, display_name)"
    )
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user?.id) notFound();

  const { data: gwRow } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures!inner(kickoff_at)")
    .eq("game_id", squad.game_id)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek", { ascending: true })
    .limit(1)
    .maybeSingle();
  const currentGameweek: number | null = gwRow?.gameweek ?? null;
  const hasCalendar = currentGameweek !== null;

  // "Viewing gameweek" - a separate concept from the recommendation
  // engine's planning horizon below: this drives what the squad's OWN
  // pitch view shows (expected points + next fixture per player, and the
  // big total above the pitch), previewing a specific future gameweek
  // rather than a rolling horizon average from the current one.
  const viewGameweek = gwParam ? Number(gwParam) : (currentGameweek ?? 1);
  const gameweekOptions = currentGameweek != null
    ? Array.from({ length: GAMEWEEK_PREVIEW_COUNT }, (_, i) => currentGameweek + i)
    : [];

  const { seasonStarted, planningGameweek } = await getSeasonTiming(supabase, squad.game_id);

  const wc1Active = squad.wildcard_1_used_gameweek === currentGameweek;
  const wc2Active = squad.wildcard_2_used_gameweek === currentGameweek;
  const wildcardActiveThisWeek = wc1Active || wc2Active;
  const wc1Available =
    currentGameweek !== null && currentGameweek >= 2 && currentGameweek <= 19 && squad.wildcard_1_used_gameweek === null;
  const wc2Available =
    currentGameweek !== null && currentGameweek >= 20 && currentGameweek <= 38 && squad.wildcard_2_used_gameweek === null;

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("budget, max_per_club")
    .eq("game_id", squad.game_id)
    .single();
  if (!rules) notFound();

  const game = squad.fantasy_games as unknown as { slug: string; display_name: string };

  const { data: squadPlayersRaw } = await supabase
    .from("squad_players")
    .select("game_player_id, is_starting, game_players(price, players(full_name, position, team_id, teams(name)))")
    .eq("squad_id", squadId)
    .returns<SquadPlayerRow[]>();

  const squadPlayersBase = (squadPlayersRaw ?? []).map((sp) => ({
    game_player_id: sp.game_player_id,
    full_name: sp.game_players.players.full_name,
    position: sp.game_players.players.position,
    team_id: sp.game_players.players.team_id,
    team_name: sp.game_players.players.teams.name,
    price: Number(sp.game_players.price),
    is_starting: sp.is_starting,
  }));

  const { data: pool } = await supabase
    .from("game_player_pool")
    .select("*")
    .eq("game_slug", game.slug)
    .returns<PoolPlayer[]>();

  // squadPlayersBase comes from squad_players/game_players (not
  // game_player_pool), so it needs its own status merge - query the same
  // view by id instead of duplicating the "latest captured status" lookup.
  const { data: squadStatusRows } = await supabase
    .from("game_player_pool")
    .select("game_player_id, lineup, status")
    .eq("game_slug", game.slug)
    .in("game_player_id", squadPlayersBase.map((p) => p.game_player_id));
  const statusById = new Map((squadStatusRows ?? []).map((r) => [r.game_player_id, r]));
  const squadPlayers = squadPlayersBase.map((p) => ({
    ...p,
    lineup: statusById.get(p.game_player_id)?.lineup ?? null,
    status: statusById.get(p.game_player_id)?.status ?? null,
  }));

  const squadIds = new Set(squadPlayers.map((p) => p.game_player_id));
  const currentTotal = squadPlayers.reduce((sum, p) => sum + p.price, 0);
  const budgetRemaining = Number(rules.budget) - currentTotal;

  const clubCounts = new Map<number, number>();
  squadPlayers.forEach((p) => clubCounts.set(p.team_id, (clubCounts.get(p.team_id) ?? 0) + 1));

  // Score source depends on where we are relative to the season:
  //   - no calendar at all (Dream Team): fall back to the latest single
  //     projection, same as always.
  //   - calendar exists but the season hasn't started: always Gameweek 1
  //     alone - "build the best 11 + bench 4 from the first GW score,"
  //     the horizon toggle doesn't mean anything yet.
  //   - season has started: the selected horizon window starting at
  //     planningGameweek (the next gameweek transfers can still actually
  //     affect - see lib/gameweek.ts), via the explicit-start RPC variant
  //     since the auto-anchoring one would still point at a gameweek
  //     that's already partway through.
  // .returns<T[]>() on an .rpc() chain trips postgrest-js's own "can't
  // cast single object to array" false-positive without a generated
  // Database type - cast the destructured data after await instead.
  let horizonData: HorizonRow[] | null = null;
  if (hasCalendar && !seasonStarted) {
    const { data } = await supabase.rpc("player_score_by_horizon", { p_game_slug: game.slug, p_num_gameweeks: 1 });
    horizonData = data as HorizonRow[] | null;
  } else if (hasCalendar && seasonStarted && planningGameweek !== null) {
    const { data } = await supabase.rpc("player_score_by_horizon_from", {
      p_game_slug: game.slug,
      p_start_gameweek: planningGameweek,
      p_num_gameweeks: activeHorizon.gameweeks,
    });
    horizonData = data as HorizonRow[] | null;
  }
  const horizonAvailable = hasCalendar && horizonData !== null && horizonData.length > 0;

  const scoreById = horizonAvailable
    ? new Map(horizonData!.map((r) => [r.game_player_id, r.avg_score]))
    : new Map((pool ?? []).map((p) => [p.game_player_id, p.hail_mary_score]));

  // Position/budget/club-limit matching lives in lib/transferMatching.ts,
  // shared with the watchlist "Transfer In" flow - this just adapts the
  // page's own data shapes into TransferCandidate and reads the result back.
  const poolCandidatesForMatching: TransferCandidate[] = (pool ?? []).map((p) => ({
    gamePlayerId: p.game_player_id,
    fullName: p.full_name,
    teamId: p.team_id,
    teamName: p.team_name,
    price: Number(p.price),
    score: scoreById.get(p.game_player_id) ?? 0,
    position: p.position,
  }));

  const recommendations: Recommendation[] = [];
  for (const outPlayer of squadPlayers) {
    const outScore = scoreById.get(outPlayer.game_player_id) ?? 0;
    const matches = findBuyCandidatesForOutgoing(
      poolCandidatesForMatching,
      {
        gamePlayerId: outPlayer.game_player_id,
        fullName: outPlayer.full_name,
        teamId: outPlayer.team_id,
        teamName: outPlayer.team_name,
        price: outPlayer.price,
        score: outScore,
        position: outPlayer.position,
      },
      squadIds,
      budgetRemaining,
      clubCounts,
      rules.max_per_club
    );
    const best = matches[0];
    if (best) {
      recommendations.push({
        outGamePlayerId: outPlayer.game_player_id,
        outName: outPlayer.full_name,
        outTeam: outPlayer.team_name,
        outPrice: outPlayer.price,
        outScore,
        inGamePlayerId: best.candidate.gamePlayerId,
        inName: best.candidate.fullName,
        inTeam: best.candidate.teamName,
        inPrice: best.candidate.price,
        inScore: best.candidate.score,
        delta: best.delta,
        position: outPlayer.position,
      });
    }
  }

  recommendations.sort((a, b) => b.delta - a.delta);

  // Per-player score AND next fixture for the specific gameweek being
  // previewed - independent of the horizon-based scoreById above, which
  // still drives the pool/recommendation logic below unchanged.
  let viewScoreById = new Map<number, number>();
  if (hasCalendar) {
    const { data } = await supabase.rpc("player_score_by_horizon_from", {
      p_game_slug: game.slug,
      p_start_gameweek: viewGameweek,
      p_num_gameweeks: 1,
    });
    viewScoreById = new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, r.avg_score]));
  }

  const nextFixtureByTeam = new Map<string, { opponent: string; isHome: boolean }>();
  if (hasCalendar) {
    const { data: viewFixturesRaw } = await supabase
      .from("game_fixture_gameweeks")
      .select(
        "gameweek, fixtures(id, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))"
      )
      .eq("game_id", squad.game_id)
      .eq("gameweek", viewGameweek);
    for (const row of (viewFixturesRaw ?? []) as unknown as FixtureJoinRow[]) {
      const f = row.fixtures;
      if (!f) continue;
      nextFixtureByTeam.set(f.home.name, { opponent: f.away.name, isHome: true });
      nextFixtureByTeam.set(f.away.name, { opponent: f.home.name, isHome: false });
    }
  }

  const squadMembersWithScore = squadPlayers.map((p) => {
    const fx = nextFixtureByTeam.get(p.team_name);
    return {
      ...p,
      score: viewScoreById.get(p.game_player_id) ?? scoreById.get(p.game_player_id) ?? null,
      nextFixture: fx ? { opponentAbbr: getTeamColors(fx.opponent).abbr, isHome: fx.isHome } : null,
    };
  });
  const totalExpectedPoints = squadMembersWithScore
    .filter((p) => p.is_starting)
    .reduce((sum, p) => sum + (p.score ?? 0), 0);
  const poolCandidates = (pool ?? [])
    .filter((p) => !squadIds.has(p.game_player_id))
    .map((p) => ({ ...p, score: scoreById.get(p.game_player_id) ?? null }));
  const clubCountsObj: Record<number, number> = {};
  clubCounts.forEach((count, teamId) => (clubCountsObj[teamId] = count));

  // Pre-season only: recent transfers, undoable since they're free/
  // unlimited right now (see squads/actions.ts's reverseTransfer).
  let recentTransfers: { id: number; outName: string; inName: string }[] = [];
  if (hasCalendar && !seasonStarted) {
    const { data: transferRows } = await supabase
      .from("squad_transfers")
      .select("id, out_game_player_id, in_game_player_id")
      .eq("squad_id", squadId)
      .order("created_at", { ascending: false })
      .limit(10);

    if (transferRows && transferRows.length > 0) {
      const involvedIds = Array.from(new Set(transferRows.flatMap((t) => [t.out_game_player_id, t.in_game_player_id])));
      const { data: namedPlayers } = await supabase
        .from("game_players")
        .select("id, players(full_name)")
        .in("id", involvedIds)
        .returns<{ id: number; players: { full_name: string } }[]>();
      const nameById = new Map((namedPlayers ?? []).map((p) => [p.id, p.players.full_name]));
      recentTransfers = transferRows.map((t) => ({
        id: t.id,
        outName: nameById.get(t.out_game_player_id) ?? "Unknown",
        inName: nameById.get(t.in_game_player_id) ?? "Unknown",
      }));
    }
  }

  const targetLabel =
    hasCalendar && seasonStarted && planningGameweek !== null
      ? `Targeting Gameweek${activeHorizon.gameweeks > 1 ? "s" : ""} ${planningGameweek}${
          activeHorizon.gameweeks > 1 ? ` – ${planningGameweek + activeHorizon.gameweeks - 1}` : ""
        }`
      : null;

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
      <div>
        <h1 className="text-2xl font-semibold text-white">{squad.name}: transfers</h1>
        <p className="mt-1 text-sm text-navy-300">
          {game.display_name} · £{budgetRemaining.toFixed(1)}m in the bank
        </p>

        {!hasCalendar ? (
          <p className="mt-1 text-xs text-amber-400">
            Weekly transfer limits aren&apos;t enforced yet - no gameweek calendar exists for{" "}
            {game.display_name} until the season starts. This shows every improving swap available,
            not just what your remaining transfers this week would allow.
          </p>
        ) : !seasonStarted ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-sky-950 px-3 py-1 font-medium text-sky-400">
              Unlimited transfers (pre-season)
            </span>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-navy-900 px-3 py-1 font-medium text-navy-300">
              GW{currentGameweek} · {squad.free_transfers} free transfer{squad.free_transfers === 1 ? "" : "s"}
            </span>
            {wildcardActiveThisWeek && (
              <span className="rounded-full bg-emerald-950 px-3 py-1 font-medium text-emerald-400">
                Wildcard active this gameweek - transfers are free
              </span>
            )}
          </div>
        )}

        {hasCalendar && !seasonStarted ? (
          <p className="mt-3 text-xs text-navy-400">
            Pre-season - recommendations target Gameweek 1, the first gameweek your squad will actually play.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-navy-400">
              Planning horizon
            </span>
            <div className="flex gap-1 rounded-lg bg-navy-900 p-1">
              {HORIZONS.map((h) => (
                <Link
                  key={h.key}
                  href={pageUrl({ horizon: h.key })}
                  prefetch={false}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                    h.key === activeHorizon.key
                      ? "bg-sky-500 text-navy-950"
                      : "text-navy-300 hover:text-white"
                  }`}
                >
                  {h.label}
                </Link>
              ))}
            </div>
            {targetLabel && <span className="text-xs text-navy-400">{targetLabel}</span>}
            {!horizonAvailable && (
              <span className="text-xs text-amber-400">
                Gameweek calendar not published for {game.display_name} yet - showing latest single projection instead.
              </span>
            )}
          </div>
        )}

        {gameweekOptions.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-navy-400">Viewing gameweek</span>
            <div className="flex flex-wrap gap-1 rounded-lg bg-navy-900 p-1">
              {gameweekOptions.map((gw) => (
                <Link
                  key={gw}
                  href={pageUrl({ gw: String(gw) })}
                  prefetch={false}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                    gw === viewGameweek ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
                  }`}
                >
                  GW{gw}
                </Link>
              ))}
            </div>
          </div>
        )}

        {hasCalendar && (
          <div className="mt-3 rounded-xl border border-navy-700 bg-navy-900 p-4 text-center">
            <p className="text-xs font-medium uppercase tracking-wide text-navy-400">
              Expected Points - GW{viewGameweek}
            </p>
            <p className="mt-1 text-4xl font-bold text-sky-400">{totalExpectedPoints.toFixed(1)}</p>
          </div>
        )}

        <div className="mt-6">
          <TransferBoard
            squadId={squadId}
            squadMembers={squadMembersWithScore}
            pool={poolCandidates}
            budgetRemaining={budgetRemaining}
            maxPerClub={rules.max_per_club}
            clubCounts={clubCountsObj}
            currentGameweek={currentGameweek}
            seasonStarted={seasonStarted}
            freeTransfers={squad.free_transfers}
            wildcardActiveThisWeek={wildcardActiveThisWeek}
            wc1Available={wc1Available}
            wc2Available={wc2Available}
          />
        </div>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-navy-400">
          Recommended swaps
        </h2>
        <div className="mt-3">
          <TransferPlanner
            squadId={squadId}
            recommendations={recommendations}
            currentGameweek={currentGameweek}
            seasonStarted={seasonStarted}
            freeTransfers={squad.free_transfers}
            wildcardActiveThisWeek={wildcardActiveThisWeek}
            wc1Available={wc1Available}
            wc2Available={wc2Available}
          />
        </div>

        {hasCalendar && !seasonStarted && <RecentTransfers squadId={squadId} transfers={recentTransfers} />}
      </div>

      <FixtureSwingPanel
        gameId={squad.game_id}
        gameSlug={game.slug}
        planningGameweek={planningGameweek}
        squadPlayers={squadPlayers.map((p) => ({ game_player_id: p.game_player_id, team_name: p.team_name }))}
      />
      </main>
    </div>
  );
}
