import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { suggestBestXI } from "@/lib/squadOptimizer";
import GameSecondaryNav from "@/app/GameSecondaryNav";
import LineupBuilder from "./LineupBuilder";
import CaptainPicker from "./CaptainPicker";
import TransferBoard from "./TransferBoard";
import MaryRecommendationsPanel from "./MaryRecommendationsPanel";
import FixtureSwingPanel from "./FixtureSwingPanel";
import RecentTransfers from "./RecentTransfers";

// Squad state (transfers, lineup, wildcard/free-transfer counts) all
// change from server actions elsewhere - same "never serve a stale
// cached response" reasoning as every other data-driven page here.
export const dynamic = "force-dynamic";

type SquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  game_players: {
    price: number;
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD"; team_id: number; teams: { id: number; name: string } };
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

/**
 * The one page per squad - what used to be 3 separate routes
 * (lineup/transfers/captain) merged into one, reachable by clicking the
 * squad's name from the games hub or squad list. Branches on `hasBench`
 * (same flag lib/squadStatus.ts already computes) since NFL FanTeam has
 * no bench/lineup/captain concept at all - it gets the pool-browsing
 * TransferBoard alone, soccer games get the full LineupBuilder board plus
 * Captain and Mary's Recommendations underneath it.
 */
export default async function SquadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const squadId = Number(id);
  if (!Number.isInteger(squadId)) notFound();

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: squad } = await supabase
    .from("squads")
    .select(
      "id, name, user_id, game_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek, captain_game_player_id, vice_captain_game_player_id, fantasy_games(id, slug, display_name)"
    )
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user?.id) notFound();

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("*")
    .eq("game_id", squad.game_id)
    .single();
  if (!rules) notFound();

  const game = squad.fantasy_games as unknown as { id: number; slug: string; display_name: string };
  const hasBench = rules.squad_size > rules.starting_size;

  const { data: formations } = hasBench
    ? await supabase
        .from("game_formations")
        .select("code, gk_count, def_count, mid_count, fwd_count")
        .eq("game_id", squad.game_id)
        .order("code")
    : { data: null };

  const { data: squadPlayersRaw } = await supabase
    .from("squad_players")
    .select("game_player_id, is_starting, game_players(price, players(full_name, position, team_id, teams(id, name)))")
    .eq("squad_id", squadId)
    .returns<SquadPlayerRow[]>();

  const { data: pool } = await supabase
    .from("game_player_pool")
    .select("game_player_id, full_name, position, team_id, team_name, price, hail_mary_score, lineup, status")
    .eq("game_slug", game.slug)
    .returns<PoolRow[]>();
  const poolByGamePlayerId = new Map((pool ?? []).map((p) => [p.game_player_id, p]));

  // 1-gameweek expected-points score for every player in this game - the
  // same metric used consistently for squad players AND pool candidates
  // (see the lineup-page scoring-mismatch bug fixed earlier this session).
  const { data: horizonData } = await supabase.rpc("player_score_by_horizon", {
    p_game_slug: game.slug,
    p_num_gameweeks: 1,
  });
  const scoreByGamePlayerId = new Map(
    ((horizonData ?? []) as { game_player_id: number; avg_score: number }[]).map((r) => [r.game_player_id, Number(r.avg_score)])
  );

  const players = (squadPlayersRaw ?? []).map((sp) => ({
    game_player_id: sp.game_player_id,
    full_name: sp.game_players.players.full_name,
    position: sp.game_players.players.position,
    team_id: sp.game_players.players.teams.id,
    team_name: sp.game_players.players.teams.name,
    price: Number(sp.game_players.price),
    is_starting: sp.is_starting,
    score: scoreByGamePlayerId.get(sp.game_player_id) ?? null,
    lineup: poolByGamePlayerId.get(sp.game_player_id)?.lineup ?? null,
    status: poolByGamePlayerId.get(sp.game_player_id)?.status ?? null,
  }));

  const budgetRemaining = Number(rules.budget) - players.reduce((sum, p) => sum + p.price, 0);
  const clubCounts = new Map<number, number>();
  players.forEach((p) => clubCounts.set(p.team_id, (clubCounts.get(p.team_id) ?? 0) + 1));

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
  const { seasonStarted } = await getSeasonTiming(supabase, squad.game_id);

  const wc1Active = squad.wildcard_1_used_gameweek === currentGameweek;
  const wc2Active = squad.wildcard_2_used_gameweek === currentGameweek;
  const wildcardActiveThisWeek = wc1Active || wc2Active;
  const wc1Available = currentGameweek !== null && currentGameweek >= 2 && currentGameweek <= 19 && squad.wildcard_1_used_gameweek === null;
  const wc2Available = currentGameweek !== null && currentGameweek >= 20 && currentGameweek <= 38 && squad.wildcard_2_used_gameweek === null;

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

  const header = (
    <div>
      <div className="mb-4">
        <GameSecondaryNav gameSlug={game.slug} gameDisplayName={game.display_name} />
      </div>
      <h1 className="text-2xl font-semibold text-white">{squad.name}</h1>
      <p className="mt-1 text-sm text-navy-300">
        {game.display_name} · £{budgetRemaining.toFixed(1)}m in the bank
        {hasCalendar && seasonStarted && ` · GW${currentGameweek} · ${squad.free_transfers} free transfer${squad.free_transfers === 1 ? "" : "s"}`}
        {hasCalendar && !seasonStarted && " · Unlimited transfers (pre-season)"}
        {wildcardActiveThisWeek && " · Wildcard active this gameweek"}
      </p>
    </div>
  );

  if (!hasBench) {
    // NFL FanTeam today: no bench/lineup/captain concept, no live
    // calendar yet - the pool-browsing board plus recent-transfers undo
    // is the whole page.
    const squadMembersForBoard = players.map((p) => ({ ...p, nextFixture: null }));
    const poolCandidates = (pool ?? [])
      .filter((p) => !players.some((sp) => sp.game_player_id === p.game_player_id))
      .map((p) => ({ ...p, score: scoreByGamePlayerId.get(p.game_player_id) ?? null }));
    const clubCountsObj: Record<number, number> = {};
    clubCounts.forEach((count, teamId) => (clubCountsObj[teamId] = count));

    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-6xl">
          {header}
          <div className="mt-6">
            <TransferBoard
              squadId={squadId}
              squadMembers={squadMembersForBoard}
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
              isNfl
            />
          </div>
          {hasCalendar && !seasonStarted && <RecentTransfers squadId={squadId} transfers={recentTransfers} />}
        </main>
      </div>
    );
  }

  const suggestion =
    horizonData && horizonData.length > 0
      ? suggestBestXI(
          players.map((p) => ({ game_player_id: p.game_player_id, position: p.position, score: p.score ?? 0 })),
          formations ?? []
        )
      : null;

  const { data: starterRows } = await supabase
    .from("squad_players")
    .select("game_player_id, game_players(price, players(full_name, position, teams(name)))")
    .eq("squad_id", squadId)
    .eq("is_starting", true)
    .returns<
      { game_player_id: number; game_players: { price: number; players: { full_name: string; position: string; teams: { name: string } } } }[]
    >();
  const starters = (starterRows ?? [])
    .map((sp) => ({
      game_player_id: sp.game_player_id,
      full_name: sp.game_players.players.full_name,
      position: sp.game_players.players.position,
      team_name: sp.game_players.players.teams.name,
      hail_mary_score: poolByGamePlayerId.get(sp.game_player_id)?.hail_mary_score ?? 0,
    }))
    .sort((a, b) => b.hail_mary_score - a.hail_mary_score);

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
        <div>
          {header}

          <div className="mt-6">
            <LineupBuilder
              squadId={squad.id}
              gameId={game.id}
              startingSize={rules.starting_size}
              formations={formations ?? []}
              players={players}
              suggestion={suggestion}
              pool={(pool ?? []).map((p) => ({
                gamePlayerId: p.game_player_id,
                fullName: p.full_name,
                teamId: p.team_id,
                teamName: p.team_name,
                price: Number(p.price),
                score: scoreByGamePlayerId.get(p.game_player_id) ?? 0,
                position: p.position,
              }))}
              budget={Number(rules.budget)}
              maxPerClub={rules.max_per_club ?? null}
            />
          </div>

          <div className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Captain</h2>
            <div className="mt-2">
              <CaptainPicker
                squadId={squad.id}
                starters={starters}
                currentCaptainId={squad.captain_game_player_id}
                currentViceCaptainId={squad.vice_captain_game_player_id}
              />
            </div>
          </div>

          {game.slug === "fanteam" && (
            <div className="mt-10">
              <MaryRecommendationsPanel
                squad={{
                  id: squad.id,
                  name: squad.name,
                  free_transfers: squad.free_transfers,
                  wildcard_1_used_gameweek: squad.wildcard_1_used_gameweek,
                  wildcard_2_used_gameweek: squad.wildcard_2_used_gameweek,
                  game_id: squad.game_id,
                }}
              />
            </div>
          )}

          {hasCalendar && !seasonStarted && <RecentTransfers squadId={squadId} transfers={recentTransfers} />}
        </div>

        {game.slug === "fanteam" && (
          <FixtureSwingPanel
            gameId={squad.game_id}
            gameSlug={game.slug}
            planningGameweek={currentGameweek}
            squadPlayers={players.map((p) => ({ game_player_id: p.game_player_id, team_name: p.team_name }))}
          />
        )}
      </main>
    </div>
  );
}
