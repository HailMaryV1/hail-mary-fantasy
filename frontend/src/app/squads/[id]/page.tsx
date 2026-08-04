import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { suggestBestXI } from "@/lib/squadOptimizer";
import { TEAM_COLORS } from "@/lib/teamColors";
import { LINEUP_SECURITY_SCORES, INJURY_AVAILABILITY_SCORES, DEFAULT_SECURITY_SCORE } from "@/lib/playerStatus";
import { computeAutoSubAwareTotal, type AutoSubPlayer } from "@/lib/benchAutoSub";
import { buildFormByGamePlayerId } from "@/lib/hailMaryForm";
import { runAskMaryAnalysis } from "@/lib/askMaryEngine";
import type { Strategy } from "@/lib/recommendationScoring";
import GameSecondaryNav from "@/app/GameSecondaryNav";
import LineupBuilder, { type GameweekSnapshot } from "./LineupBuilder";
import CaptainPicker from "./CaptainPicker";
import TransferBoard from "./TransferBoard";
import MaryRecommendationsPanel from "./MaryRecommendationsPanel";
import FixtureSwingPanel from "./FixtureSwingPanel";
import RecentTransfers from "./RecentTransfers";
import ProviderSyncStatus from "./ProviderSyncStatus";

// EPL season length - same 38 used throughout the scoring pipeline
// (compute_projections.py's season_games weight, wildcard windows below).
const SEASON_GAMEWEEKS = 38;

// Squad state (transfers, lineup, wildcard/free-transfer counts) all
// change from server actions elsewhere - same "never serve a stale
// cached response" reasoning as every other data-driven page here.
export const dynamic = "force-dynamic";

type SquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  bench_order: number | null;
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
      "id, name, user_id, game_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek, captain_game_player_id, vice_captain_game_player_id, preferred_strategy, preferred_captain_horizon, fantasy_games(id, slug, display_name)"
    )
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user?.id) notFound();

  // Auto Import My Squad (migration 0071) - a squad either has exactly
  // one provider link or none at all (unique(squad_id)), so this is
  // always a single-row lookup, never a list.
  const { data: providerLink } = await supabase
    .from("provider_squad_links")
    .select("provider, last_synced_at, last_sync_status, last_sync_error, last_change_summary, sync_requested_at")
    .eq("squad_id", squadId)
    .maybeSingle();

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

  const { data: squadPlayersRaw, error: squadPlayersError } = await supabase
    .from("squad_players")
    // players!teams needs disambiguating - migration 0057 gave `players`
    // a second FK to `teams` (pending_team_id, for the live-import
    // debounce), so PostgREST can no longer infer which one this embed
    // means and silently 400s without the explicit constraint name.
    .select(
      "game_player_id, is_starting, bench_order, game_players(price, players(full_name, position, team_id, teams!players_team_id_fkey(id, name)))"
    )
    .eq("squad_id", squadId)
    .returns<SquadPlayerRow[]>();
  if (squadPlayersError) console.error("squad_players fetch failed:", squadPlayersError);

  const { data: pool } = await supabase
    .from("game_player_pool")
    .select("game_player_id, full_name, position, team_id, team_name, price, hail_mary_score, lineup, status")
    .eq("game_slug", game.slug)
    .returns<PoolRow[]>();
  const poolByGamePlayerId = new Map((pool ?? []).map((p) => [p.game_player_id, p]));

  // Hail Mary Form badge - every player in this game's frozen prediction
  // archive (migration 0044), same "fetch once, merge everywhere" shape
  // as lineup/status above. Covers squad members' pitch chips AND pool
  // candidates' rows (LineupBuilder's swap picker, TransferBoard) from
  // one query.
  const { data: formRows } = await supabase
    .from("player_gameweek_predictions")
    .select("game_player_id, gameweek, points_difference")
    .eq("game_id", squad.game_id)
    .not("points_difference", "is", null); // completed gameweeks only - also keeps this well under PostgREST's default row cap across a full season
  const formByGamePlayerId = buildFormByGamePlayerId(formRows ?? []);

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
    bench_order: sp.bench_order,
    score: scoreByGamePlayerId.get(sp.game_player_id) ?? null,
    lineup: poolByGamePlayerId.get(sp.game_player_id)?.lineup ?? null,
    status: poolByGamePlayerId.get(sp.game_player_id)?.status ?? null,
    formStatus: formByGamePlayerId.get(sp.game_player_id)?.status ?? null,
    is_captain: sp.game_player_id === squad.captain_game_player_id,
    is_vice_captain: sp.game_player_id === squad.vice_captain_game_player_id,
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

  // Full-season fixture/expected-points/actual-points data for every
  // squad player, one snapshot per gameweek - fetched once, in full, so
  // flicking between gameweeks in the pitch view is instant client-side
  // with no extra round trips. Only meaningful for bench games with a
  // real published calendar (FanTeam today) - Dream Team has no live
  // gameweek data yet, NFL doesn't use this pitch view at all.
  let gameweekData: Record<number, GameweekSnapshot> = {};
  if (hasBench && hasCalendar) {
    const gamePlayerIds = players.map((p) => p.game_player_id);

    const { data: fixtureRows } = await supabase
      .from("game_fixture_gameweeks")
      .select("gameweek, fixtures(home_team_id, away_team_id)")
      .eq("game_id", squad.game_id)
      .returns<{ gameweek: number; fixtures: { home_team_id: number; away_team_id: number } | null }[]>();

    const { data: teamRows } = await supabase.from("teams").select("id, name").returns<{ id: number; name: string }[]>();
    const teamNameById = new Map((teamRows ?? []).map((t) => [t.id, t.name]));

    const { data: projRows } = await supabase
      .from("projections")
      .select("game_player_id, gameweek, hail_mary_score, created_at")
      .in("game_player_id", gamePlayerIds)
      .order("created_at", { ascending: false })
      .returns<{ game_player_id: number; gameweek: number | null; hail_mary_score: number; created_at: string }[]>();
    // "Latest wins" per (game_player_id, gameweek) - same dedup rule as
    // player_score_by_horizon_from (migration 0025). Rows are ordered
    // created_at desc above, so the first occurrence kept per key is the
    // most recent one.
    const scoreByPlayerGw = new Map<string, number>();
    for (const r of projRows ?? []) {
      if (r.gameweek == null) continue; // period-mode row, not relevant here
      const key = `${r.game_player_id}:${r.gameweek}`;
      if (!scoreByPlayerGw.has(key)) scoreByPlayerGw.set(key, Number(r.hail_mary_score));
    }

    const { data: actualRows } = await supabase
      .from("player_gameweek_results")
      .select("game_player_id, gameweek, actual_points")
      .eq("game_id", squad.game_id)
      .in("game_player_id", gamePlayerIds)
      .returns<{ game_player_id: number; gameweek: number; actual_points: number | null }[]>();
    const actualByPlayerGw = new Map(
      (actualRows ?? []).map((r) => [`${r.game_player_id}:${r.gameweek}`, r.actual_points != null ? Number(r.actual_points) : null])
    );
    const gameweeksWithActuals = new Set((actualRows ?? []).map((r) => r.gameweek));

    // Opponent (name, not yet abbreviated) per (team_id, gameweek) -
    // covers both fixture sides from the one query, one lookup per side.
    const opponentByTeamGw = new Map<string, { opponentName: string; isHome: boolean }>();
    for (const row of fixtureRows ?? []) {
      const f = row.fixtures;
      if (!f) continue;
      const homeName = teamNameById.get(f.home_team_id) ?? "?";
      const awayName = teamNameById.get(f.away_team_id) ?? "?";
      opponentByTeamGw.set(`${f.home_team_id}:${row.gameweek}`, { opponentName: awayName, isHome: true });
      opponentByTeamGw.set(`${f.away_team_id}:${row.gameweek}`, { opponentName: homeName, isHome: false });
    }

    // The real, currently-saved starting XI + bench auto-sub order -
    // "Expected points" per gameweek should reflect what THIS squad
    // (with its actual lineup) would realistically score, not a flat sum
    // of all 15 players (bench points don't count - see
    // lib/benchAutoSub.ts) and not some hypothetical re-optimized XI.
    const startingSet = new Set(players.filter((p) => p.is_starting).map((p) => p.game_player_id));
    const benchPlayers = players.filter((p) => !startingSet.has(p.game_player_id));
    const reserveGKId = benchPlayers.find((p) => p.position === "GK")?.game_player_id ?? null;
    const outfieldBenchIdsInOrder = benchPlayers
      .filter((p) => p.position !== "GK")
      .slice()
      .sort((a, b) => (a.bench_order ?? 99) - (b.bench_order ?? 99))
      .map((p) => p.game_player_id);
    function survivalProbabilityFor(p: { lineup: string | null; status: string | null }): number {
      return (LINEUP_SECURITY_SCORES[p.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE) * (INJURY_AVAILABILITY_SCORES[p.status ?? ""] ?? DEFAULT_SECURITY_SCORE);
    }

    for (let gw = 1; gw <= SEASON_GAMEWEEKS; gw++) {
      const gwPlayers: GameweekSnapshot["players"] = {};
      for (const p of players) {
        const opp = opponentByTeamGw.get(`${p.team_id}:${gw}`);
        const fixture = opp
          ? { opponentAbbr: TEAM_COLORS[opp.opponentName]?.abbr ?? opp.opponentName.slice(0, 3).toUpperCase(), isHome: opp.isHome }
          : null;
        const expectedPoints = scoreByPlayerGw.get(`${p.game_player_id}:${gw}`) ?? null;
        const actualPoints = actualByPlayerGw.get(`${p.game_player_id}:${gw}`) ?? null;
        gwPlayers[p.game_player_id] = { fixture, expectedPoints, actualPoints };
      }

      // Real lineup/status is only meaningful for the currently-editable
      // gameweek - FanTeam's live feed doesn't expose it for any other
      // one, so every other gameweek defaults to "nailed on" (1), which
      // correctly collapses the auto-sub math to a plain starters-only sum.
      const toAutoSubPlayer = (p: (typeof players)[number]): AutoSubPlayer => ({
        gamePlayerId: p.game_player_id,
        position: p.position,
        score: gwPlayers[p.game_player_id].expectedPoints ?? 0,
        survivalProbability: gw === currentGameweek ? survivalProbabilityFor(p) : 1,
      });
      const starters = players.filter((p) => startingSet.has(p.game_player_id)).map(toAutoSubPlayer);
      const reserveGK = reserveGKId != null ? toAutoSubPlayer(players.find((p) => p.game_player_id === reserveGKId)!) : null;
      const outfieldBench = outfieldBenchIdsInOrder.map((id) => toAutoSubPlayer(players.find((p) => p.game_player_id === id)!));
      const squadExpected = computeAutoSubAwareTotal(starters, reserveGK, outfieldBench, formations ?? []);

      // Starters only, same principle as squadExpected - but NOT yet
      // auto-sub-aware itself (unlike squadExpected's probability-blended
      // version): once player_gameweek_results has real actual_minutes,
      // a starter who genuinely didn't play should be swapped for
      // whichever bench player really was subbed in, which is knowable
      // fact by then, not a probability estimate. No real actuals exist
      // yet to build or verify that against - a follow-up once GW1 completes.
      const squadActual = gameweeksWithActuals.has(gw)
        ? starters.reduce((sum, p) => sum + (gwPlayers[p.gamePlayerId].actualPoints ?? 0), 0)
        : null;
      gameweekData[gw] = {
        gameweek: gw,
        players: gwPlayers,
        squadExpected: Math.round(squadExpected * 10) / 10,
        squadActual: squadActual != null ? Math.round(squadActual * 10) / 10 : null,
      };
    }
  }

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
      {providerLink && (
        <div className="mt-3">
          <ProviderSyncStatus
            squadId={squadId}
            provider={providerLink.provider}
            lastSyncedAt={providerLink.last_synced_at}
            lastSyncStatus={providerLink.last_sync_status}
            lastSyncError={providerLink.last_sync_error}
            lastChangeSummary={providerLink.last_change_summary}
            syncRequested={providerLink.sync_requested_at != null}
          />
        </div>
      )}
    </div>
  );

  if (!hasBench) {
    // NFL FanTeam: no bench/lineup/captain concept, no live calendar yet -
    // the pool-browsing board plus recent-transfers undo is the whole
    // page. Cloud FF also has no bench, but it DOES have a real captain
    // concept ("captains score double") - see the manual CaptainPicker
    // added below, same reasoning as the Dream Team one further down this
    // file (no provider-supplied captain field to sync from - confirmed
    // against the real Cloud FF API response - so manual selection is the
    // only honest option).
    const squadMembersForBoard = players.map((p) => ({ ...p, nextFixture: null }));
    const poolCandidates = (pool ?? [])
      .filter((p) => !players.some((sp) => sp.game_player_id === p.game_player_id))
      .map((p) => ({ ...p, score: scoreByGamePlayerId.get(p.game_player_id) ?? null, formStatus: formByGamePlayerId.get(p.game_player_id)?.status ?? null }));
    const clubCountsObj: Record<number, number> = {};
    clubCounts.forEach((count, teamId) => (clubCountsObj[teamId] = count));
    const cloudFFStarters = players
      .map((p) => ({
        game_player_id: p.game_player_id,
        full_name: p.full_name,
        position: p.position,
        team_name: p.team_name,
        hail_mary_score: p.score ?? 0,
      }))
      .sort((a, b) => b.hail_mary_score - a.hail_mary_score);

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
              isNfl={game.slug === "nfl-fanteam"}
            />
          </div>
          {game.slug === "cloudff" && (
            <div className="mt-10">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Captain</h2>
              <div className="mt-2">
                <CaptainPicker
                  squadId={squad.id}
                  starters={cloudFFStarters}
                  currentCaptainId={squad.captain_game_player_id}
                  currentViceCaptainId={squad.vice_captain_game_player_id}
                  recommendedCaptain={null}
                  recommendedVice={null}
                />
              </div>
            </div>
          )}
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
    .select("game_player_id, game_players(price, players(full_name, position, teams!players_team_id_fkey(name)))")
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

  // Computed exactly once here (not a second time inside
  // MaryRecommendationsPanel, which used to re-run this same engine call
  // independently) - both CaptainPicker's "Recommended" banner and
  // MaryRecommendationsPanel below read off this ONE result, so they can
  // no longer disagree with each other the way CaptainPicker's own
  // starters[0]/[1] guess used to vs. Ask Mary's real captain pick.
  // Strategy is no longer user-selectable - always "balanced". Captain
  // horizon is no longer user-selectable either - runAskMaryAnalysis
  // always scores next-gameweek-only now.
  const analysis =
    game.slug === "fanteam"
      ? await runAskMaryAnalysis(
          supabase,
          {
            id: squad.id,
            name: squad.name,
            free_transfers: squad.free_transfers,
            wildcard_1_used_gameweek: squad.wildcard_1_used_gameweek,
            wildcard_2_used_gameweek: squad.wildcard_2_used_gameweek,
          },
          { id: game.id, display_name: game.display_name, slug: game.slug },
          "balanced" as Strategy
        )
      : null;

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
        <div>
          {header}

          <div className="mt-6">
            <LineupBuilder
              squadId={squad.id}
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
                formStatus: formByGamePlayerId.get(p.game_player_id)?.status ?? null,
              }))}
              budget={Number(rules.budget)}
              maxPerClub={rules.max_per_club ?? null}
              gameweekData={hasCalendar ? gameweekData : undefined}
              initialGameweek={currentGameweek}
              seasonGameweeks={SEASON_GAMEWEEKS}
            />
          </div>

          {/* FanTeam squads get their captain/vice-captain straight from
              the real FanTeam entry (see apply_squad's is_captain/
              is_vice_captain detection) - shown as C/VC pills directly
              on the pitch chips above, not a separate editable picker,
              since FanTeam is the source of truth and any change made
              here would just be overwritten by the next sync anyway.
              Dream Team/Cloud FF have no real captain sync yet, so they
              still need manual selection. */}
          {providerLink?.provider !== "fanteam_scoutgg" && (
            <div className="mt-10">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Captain</h2>
              <div className="mt-2">
                <CaptainPicker
                  squadId={squad.id}
                  starters={starters}
                  currentCaptainId={squad.captain_game_player_id}
                  currentViceCaptainId={squad.vice_captain_game_player_id}
                  recommendedCaptain={analysis?.bestCaptain ? { game_player_id: analysis.bestCaptain.game_player_id, full_name: analysis.bestCaptain.full_name } : null}
                  recommendedVice={analysis?.viceCaptain ? { game_player_id: analysis.viceCaptain.game_player_id, full_name: analysis.viceCaptain.full_name } : null}
                />
              </div>
            </div>
          )}

          {game.slug === "fanteam" && (
            <div className="mt-10">
              <MaryRecommendationsPanel squadId={squad.id} gameSlug={game.slug} analysis={analysis} />
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
