import type { createAuthServerClient } from "./supabaseServerClient";
import { getSeasonTiming } from "./gameweek";
import { findLegalReplacementsForOutgoing, pruneDominatedCandidates, type TransferCandidate } from "./transferMatching";
import { fetchRotationRiskByPlayerIds, buildContestedGamePlayerPairs, buildHighRiskGamePlayerIds } from "./rotationRisk";
import { suggestBestXI, type Formation } from "./squadOptimizer";
import { computeAutoSubAwareTotal, type AutoSubPlayer } from "./benchAutoSub";
import { type FixtureDifficultyRow } from "./fixtureRuns";
import { deriveTeamFixtureRatings } from "./fixtureSwing";
import { LINEUP_SECURITY_SCORES, INJURY_AVAILABILITY_SCORES, DEFAULT_SECURITY_SCORE } from "./playerStatus";
import { buildFormByGamePlayerId, type FormStatus } from "./hailMaryForm";
import { transferCost, isWildcardActive, accrueFreeTransfers } from "./transferEconomy";
import { scoreMoveCandidates, STRATEGY_WEIGHTS, type Strategy, type MoveCandidateInput, type MoveScore, type MoveReason } from "./recommendationScoring";
import { assessSquadHealth, type SquadHealthPlayer, type SquadHealthReport } from "./squadHealth";
import { toPredictionRow, type PredictionRecord } from "./predictionArchive";

// FanTeam only, for now - see the plan this was built against. Deliberately
// its own file rather than a branch inside dreamteamAskMaryEngine.ts (see
// the old frontend's askMaryEngine.ts for what that anti-pattern looks
// like at scale - isCloudFF/isDreamTeam shadow functions threaded through
// every call site). Cloud FF gets its own fanteamAskMaryEngine.ts-shaped
// file when its turn comes, not a branch added here.
//
// Unlike Dream Team, FanTeam has a real bench/formation system - every
// squad member does NOT automatically count, only the optimal starting XI
// (plus real auto-substitution for anyone who doesn't feature) does. See
// optimalXITotal below.
type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

// How many gameweeks ahead the sequential plan looks - GW1/GW2/GW3
// relative to whatever `planningGameweek` currently resolves to, not
// fixed calendar gameweeks (see buildGameweekPlan).
const GAMEWEEK_PLAN_LENGTH = 3;

// A single gameweek step can recommend more than one transfer (e.g. using
// several banked free transfers at once) - this is a generous safety
// bound on the search loop, not a real business rule. The real limit is
// "does the next transfer still clear its own cost," which the search's
// own netGain <= 0 stop condition already enforces.
const MAX_TRANSFERS_PER_STEP = 8;

// Front-to-back build order (2026-08-10 user call) - see
// dreamteamAskMaryEngine.ts's constant of the same name for the full
// reasoning. Lower = built first.
const BUILD_PRIORITY: Record<"GK" | "DEF" | "MID" | "FWD", number> = { FWD: 0, MID: 1, DEF: 2, GK: 3 };

// How many gameweeks a transfer candidate is judged over, starting at
// whichever step is being decided - see dreamteamAskMaryEngine.ts's
// constant of the same name for the full reasoning (a real reported
// failure mode: picking whoever's the single best score THIS week alone
// routinely loads a squad with one-week fixture spikes, leaving no
// budget to react to a different team's good run starting next week).
// Deliberately separate from scoreMapForStep (still 1 gameweek, used
// only for the number shown as "projected points this gameweek").
const PLANNING_LOOKAHEAD_GAMEWEEKS = 2;

/** One leg of a transfer recommendation - a single sell/buy pair. */
export type BundleTransfer = {
  outGamePlayerId: number;
  outName: string;
  outTeam: string;
  outPrice: number;
  inGamePlayerId: number;
  inName: string;
  inTeam: string;
  inPrice: number;
  inFormStatus?: FormStatus | null;
  position: string;
  pointsGain: number; // raw projected points over this gameweek, before this leg's cost
  costPoints: number; // 0 or -4 - see transferEconomy.ts
  risk: MoveScore["risk"];
  confidence: number;
  overall: number;
  reasons: MoveReason[];
  warnings: MoveReason[];
  alternatives?: BundleTransfer[];
  pairedLegIndex?: number;
};

/**
 * What Mary recommends for one specific upcoming gameweek - zero to
 * MAX_TRANSFERS_PER_STEP transfers, always jointly legal. Steps are
 * sequential - GW2's working squad/budget/free-transfer count is
 * whatever GW1's step left behind, not independently recomputed from
 * today's actual squad.
 */
export type GameweekPlanStep = {
  gameweek: number;
  offset: 1 | 2 | 3;
  transfers: BundleTransfer[];
  hold: boolean; // true when transfers.length === 0
  freeTransfersAvailable: number | "unlimited";
  freeTransfersAfter: number | "unlimited";
  budgetRemainingAfter: number;
  // The optimal STARTING XI's projected points for this gameweek, after
  // this step - not a flat sum of all 15 squad players (see
  // optimalXITotal).
  resultingSquadExpectedPoints: number;
  writeup: string;
};

type PoolRow = {
  game_player_id: number;
  player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  price: number;
  hail_mary_score: number | null;
  // The 1-10 Hail Mary Rating (migration 0135) - real column on
  // game_player_pool, same coalesce(current-gameweek, latest) fallback as
  // hail_mary_score above. Threaded into every TransferCandidate built
  // from this row, same source hail_mary_score already uses.
  hail_mary_rating: number | null;
  lineup: string | null;
  status: string | null;
  form: number | null;
  formStatus?: FormStatus | null;
};

type SquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  game_players: {
    price: number;
    // FanTeam's OWN classification, not the shared players.position which
    // can genuinely disagree with what this game calls a player (2026-08-08 fix).
    position_code: "GK" | "DEF" | "MID" | "FWD";
    players: { full_name: string; team_id: number; teams: { name: string } };
  };
};

type RawFixtureJoin = {
  gameweek: number;
  fixtures: {
    id: number;
    home_team_id: number;
    away_team_id: number;
    home: { name: string };
    away: { name: string };
  } | null;
};

type HorizonRow = { game_player_id: number; avg_score: number };

type WorkingSquadPlayer = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  price: number;
};

type CaptaincyPick = {
  game_player_id: number;
  full_name: string;
  team_name: string;
  score: number;
  // The 1-10 Hail Mary Rating (migration 0135), same real
  // game_player_pool source as score above - not yet displayed anywhere
  // (that's a separate follow-up), just threaded through alongside score
  // for when it is.
  rating: number | null;
  lineup: string | null;
};

export type AskMaryAnalysis = {
  squadPlayers: {
    game_player_id: number;
    full_name: string;
    position: "GK" | "DEF" | "MID" | "FWD";
    team_id: number;
    team_name: string;
    price: number;
    is_starting: boolean;
    lineup: string | null;
    status: string | null;
    form: number | null;
  }[];
  rules: { budget: number; max_per_club: number | null; squad_size: number; starting_size: number };
  budgetRemaining: number;
  hasCalendar: boolean;
  seasonStarted: boolean;
  planningGameweek: number | null;
  gameweekPlan: GameweekPlanStep[];
  bestCaptain: CaptaincyPick | null;
  viceCaptain: CaptaincyPick | null;
  health: SquadHealthReport;
};

/**
 * The FanTeam Ask Mary pipeline for one squad: fetches its players/pool/
 * fixtures/formations, builds a sequential gameweek-by-gameweek transfer
 * plan (see buildGameweekPlan) - each step jointly budget/position/
 * club-limit legal by construction - plus a Captain & Vice-Captain pick
 * and squad health, then archives all of it as immutable predictions
 * (Mary Performance Lab).
 *
 * Returns null if the squad's composition is currently invalid (wrong
 * player count) - the caller decides how to surface that.
 */
export async function runAskMaryAnalysis(
  supabase: Supabase,
  squad: {
    id: number;
    name: string;
    free_transfers: number;
    wildcard_1_used_gameweek?: number | null;
    wildcard_2_used_gameweek?: number | null;
  },
  game: { id: number; display_name: string; slug: string },
  activeStrategy: Strategy,
  recordPredictionsFn?: (records: PredictionRecord[]) => Promise<{ error?: string } | { recorded: number }>
): Promise<AskMaryAnalysis | null> {
  // Captain/vice-captain is picked fresh every gameweek - always the
  // next gameweek only, same as every other game's Ask Mary.
  const captainHorizonGameweeks = 1;

  // Every query below reads only the input params (game.id, game.slug, or
  // squad.id) - none of them depend on another query's result, so
  // they're fetched together instead of one await at a time.
  const nowIso = new Date().toISOString();
  const [
    { data: rulesRow },
    { data: formationsRaw },
    { data: squadPlayersRaw },
    { data: poolRaw },
    { data: formRows },
    { data: gwRow },
    { data: fixturesRaw },
    { data: difficultyRaw },
    seasonTiming,
  ] = await Promise.all([
    supabase.from("game_squad_rules").select("budget, max_per_club, squad_size, starting_size").eq("game_id", game.id).single(),
    // Needed to know which players in a hypothetical squad would actually
    // START (and therefore actually score) - see optimalXITotal below.
    supabase.from("game_formations").select("code, gk_count, def_count, mid_count, fwd_count").eq("game_id", game.id).order("code"),
    supabase
      .from("squad_players")
      .select("game_player_id, is_starting, game_players(price, position_code, players(full_name, team_id, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squad.id)
      .returns<SquadPlayerRow[]>(),
    supabase.from("game_player_pool").select("*").eq("game_slug", game.slug).returns<PoolRow[]>(),
    supabase.from("player_gameweek_predictions").select("game_player_id, gameweek, points_difference").eq("game_id", game.id).not("points_difference", "is", null),
    supabase
      .from("game_fixture_gameweeks")
      .select("gameweek, fixtures!inner(kickoff_at)")
      .eq("game_id", game.id)
      .gte("fixtures.kickoff_at", nowIso)
      .order("gameweek", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("game_fixture_gameweeks")
      .select("gameweek, fixtures(id, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))")
      .eq("game_id", game.id)
      .gte("fixtures.kickoff_at", nowIso)
      .order("gameweek"),
    supabase
      .from("team_fixture_difficulty")
      .select("fixture_id, team_id, attack_score, clean_sheet_score")
      .eq("game_id", game.id)
      .returns<{ fixture_id: number; team_id: number; attack_score: number; clean_sheet_score: number }[]>(),
    getSeasonTiming(supabase, game.id),
  ]);

  if (!rulesRow) return null;
  const rules = rulesRow;

  const formations: Formation[] = (formationsRaw ?? []).map((f) => ({
    code: f.code,
    gk_count: f.gk_count,
    def_count: f.def_count,
    mid_count: f.mid_count,
    fwd_count: f.fwd_count,
  }));

  const formByGamePlayerId = buildFormByGamePlayerId(formRows ?? []);
  const pool: PoolRow[] = (poolRaw ?? []).map((p) => ({ ...p, formStatus: formByGamePlayerId.get(p.game_player_id)?.status ?? null }));
  const poolByGamePlayerId = new Map(pool.map((p) => [p.game_player_id, p]));

  // Rotation risk (migration 0111/0112) - real Premier League data, in
  // scope for FanTeam (see feedback_data_source_scope_correlation for why
  // EFL Fantasy never gets this), but ONLY pre-season - see
  // fetchRotationRiskByPlayerIds's docstring. contestedPairs maps a
  // game_player_id to the OTHER game_player_id it has a real rotation
  // battle with; highRiskGamePlayerIds is the stricter standalone check -
  // a player genuinely unlikely to start is never a fresh buy.
  const riskByPlayerId = await fetchRotationRiskByPlayerIds(supabase, pool.map((p) => p.player_id));
  const contestedPairs = buildContestedGamePlayerPairs(
    pool.map((p) => ({ game_player_id: p.game_player_id, player_id: p.player_id })),
    riskByPlayerId
  );
  const highRiskGamePlayerIds = buildHighRiskGamePlayerIds(
    pool.map((p) => ({ game_player_id: p.game_player_id, player_id: p.player_id })),
    riskByPlayerId
  );

  const squadPlayers = (squadPlayersRaw ?? []).map((sp) => {
    const poolRow = poolByGamePlayerId.get(sp.game_player_id);
    return {
      game_player_id: sp.game_player_id,
      full_name: sp.game_players.players.full_name,
      position: sp.game_players.position_code,
      team_id: sp.game_players.players.team_id,
      team_name: sp.game_players.players.teams.name,
      price: Number(sp.game_players.price),
      is_starting: sp.is_starting,
      lineup: poolRow?.lineup ?? null,
      status: poolRow?.status ?? null,
      form: poolRow?.form != null ? Number(poolRow.form) : null,
    };
  });

  if (squadPlayers.length !== rules.squad_size) return null;

  const budgetRemaining = Number(rules.budget) - squadPlayers.reduce((sum, p) => sum + p.price, 0);
  const clubCounts = new Map<number, number>();
  squadPlayers.forEach((p) => clubCounts.set(p.team_id, (clubCounts.get(p.team_id) ?? 0) + 1));
  const squadIds = new Set(squadPlayers.map((p) => p.game_player_id));

  const currentGameweek: number | null = gwRow?.gameweek ?? null;
  const hasCalendar = currentGameweek !== null;
  const { seasonStarted, planningGameweek } = seasonTiming;

  const freeTransfersBanked = seasonStarted ? squad.free_transfers : Infinity;

  async function getStepScoreMap(gameweek: number): Promise<Map<number, number>> {
    if (!hasCalendar) return new Map();
    const { data } = await supabase.rpc("player_score_by_horizon_from", { p_game_slug: game.slug, p_start_gameweek: gameweek, p_num_gameweeks: 1 });
    return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
  }

  /** Same shape as getStepScoreMap, but averaged over PLANNING_LOOKAHEAD_GAMEWEEKS starting at `gameweek` - see that constant's comment. */
  async function getStepPlanningScoreMap(gameweek: number): Promise<Map<number, number>> {
    if (!hasCalendar) return new Map();
    const { data } = await supabase.rpc("player_score_by_horizon_from", {
      p_game_slug: game.slug,
      p_start_gameweek: gameweek,
      p_num_gameweeks: PLANNING_LOOKAHEAD_GAMEWEEKS,
    });
    return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
  }

  async function getHorizonMap(gameweeks: number): Promise<Map<number, number>> {
    if (hasCalendar && !seasonStarted) {
      const { data } = await supabase.rpc("player_score_by_horizon", { p_game_slug: game.slug, p_num_gameweeks: gameweeks });
      return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
    }
    if (hasCalendar && seasonStarted && planningGameweek !== null) {
      const { data } = await supabase.rpc("player_score_by_horizon_from", { p_game_slug: game.slug, p_start_gameweek: planningGameweek, p_num_gameweeks: gameweeks });
      return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
    }
    return new Map();
  }

  const stepGameweeks = planningGameweek != null ? [0, 1, 2].map((offset) => planningGameweek + offset) : [];
  const [stepScoreMaps, stepPlanningScoreMaps, captainScoreMap] = await Promise.all([
    Promise.all(stepGameweeks.map((gw) => getStepScoreMap(gw))),
    Promise.all(stepGameweeks.map((gw) => getStepPlanningScoreMap(gw))),
    getHorizonMap(captainHorizonGameweeks),
  ]);

  function avgFor(map: Map<number, number>, gamePlayerId: number): number {
    if (map.size > 0) return map.get(gamePlayerId) ?? 0;
    const hms = poolByGamePlayerId.get(gamePlayerId)?.hail_mary_score;
    return hms != null ? Number(hms) : 0;
  }

  // Same real-world meaning as compute_projections.py's status_multiplier
  // (lineup likelihood x injury/suspension availability). Defaults to 1
  // (nailed on) when no live status exists yet.
  function survivalProbabilityFor(gamePlayerId: number): number {
    const row = poolByGamePlayerId.get(gamePlayerId);
    const lineupScore = LINEUP_SECURITY_SCORES[row?.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE;
    const injuryScore = INJURY_AVAILABILITY_SCORES[row?.status ?? ""] ?? DEFAULT_SECURITY_SCORE;
    return lineupScore * injuryScore;
  }

  /**
   * The realized total for one hypothetical squad state at one
   * gameweek's scores: only the OPTIMAL STARTING XI's points actually
   * count (see suggestBestXI, which picks the best-legal formation and
   * its top scorers per position) - bench value is credited only through
   * real auto-substitution (see computeAutoSubAwareTotal), never
   * assumed. Non-starters are ranked by their own score, highest first -
   * Mary doesn't manage a persisted bench order for her own hypothetical
   * squads.
   */
  function optimalXITotal(squad: WorkingSquadPlayer[], scoreMapForStep: Map<number, number>): number {
    // rating: null throughout - avgFor is a multi-gameweek averaged
    // hypothetical, not one real gameweek's rating, so suggestBestXI's
    // rating-primary sort correctly falls back to plain score ranking
    // here (never a real rating to compare, honestly represented as
    // such rather than reusing a stale single-gameweek value).
    const withScores = squad.map((p) => ({
      game_player_id: p.game_player_id,
      position: p.position,
      score: avgFor(scoreMapForStep, p.game_player_id),
      rating: null,
    }));
    const best = suggestBestXI(withScores, formations);
    if (!best) return withScores.reduce((sum, p) => sum + p.score, 0);

    const toAutoSubPlayer = (p: (typeof withScores)[number]): AutoSubPlayer => ({
      gamePlayerId: p.game_player_id,
      position: p.position,
      score: p.score,
      survivalProbability: survivalProbabilityFor(p.game_player_id),
    });

    const startingSet = new Set(best.startingGamePlayerIds);
    const starters = withScores.filter((p) => startingSet.has(p.game_player_id)).map(toAutoSubPlayer);
    const benchAll = withScores.filter((p) => !startingSet.has(p.game_player_id)).map(toAutoSubPlayer);
    const reserveGK = benchAll.find((p) => p.position === "GK") ?? null;
    const outfieldBench = benchAll.filter((p) => p.position !== "GK").sort((a, b) => b.score - a.score);

    return computeAutoSubAwareTotal(starters, reserveGK, outfieldBench, formations);
  }

  function toWorkingSquadPlayer(cand: TransferCandidate): WorkingSquadPlayer {
    return { game_player_id: cand.gamePlayerId, full_name: cand.fullName, position: cand.position, team_id: cand.teamId, team_name: cand.teamName, price: cand.price };
  }

  const difficultyByFixtureTeam = new Map((difficultyRaw ?? []).map((d) => [`${d.fixture_id}:${d.team_id}`, d]));
  const fixtureRows: FixtureDifficultyRow[] = [];
  for (const row of (fixturesRaw ?? []) as unknown as RawFixtureJoin[]) {
    const f = row.fixtures;
    if (!f) continue;
    for (const [teamId, teamName] of [
      [f.home_team_id, f.home.name],
      [f.away_team_id, f.away.name],
    ] as const) {
      const diff = difficultyByFixtureTeam.get(`${f.id}:${teamId}`);
      fixtureRows.push({ teamName, gameweek: row.gameweek, attackScore: diff ? Number(diff.attack_score) : null, cleanSheetScore: diff ? Number(diff.clean_sheet_score) : null });
    }
  }
  const ratings = deriveTeamFixtureRatings(fixtureRows);
  const ratingByTeam = new Map(ratings.map((r) => [r.teamName, r]));

  type SearchState = { workingSquad: WorkingSquadPlayer[]; workingSquadIds: Set<number>; workingBudget: number; workingClubCounts: Map<number, number>; freeRemaining: number };
  type SlotMove = { input: MoveCandidateInput; outPlayer: WorkingSquadPlayer; inCandidate: TransferCandidate };

  function buildLegInput(outPlayer: WorkingSquadPlayer, inCand: TransferCandidate, outScore: number, realizedPointsGain?: number): SlotMove {
    const inPoolRow = poolByGamePlayerId.get(inCand.gamePlayerId);
    const outPoolRow = poolByGamePlayerId.get(outPlayer.game_player_id);
    const outTeamRating = ratingByTeam.get(outPlayer.team_name);
    const inTeamRating = ratingByTeam.get(inCand.teamName);
    return {
      outPlayer,
      inCandidate: inCand,
      input: {
        outGamePlayerId: outPlayer.game_player_id,
        inGamePlayerId: inCand.gamePlayerId,
        outName: outPlayer.full_name,
        inName: inCand.fullName,
        outTeam: outPlayer.team_name,
        inTeam: inCand.teamName,
        position: outPlayer.position,
        expectedPointsGain: realizedPointsGain ?? inCand.score - outScore,
        hailMaryScoreDiff: (inPoolRow?.hail_mary_score != null ? Number(inPoolRow.hail_mary_score) : 0) - (outPoolRow?.hail_mary_score != null ? Number(outPoolRow.hail_mary_score) : 0),
        ratingGain:
          inPoolRow?.hail_mary_rating != null && outPoolRow?.hail_mary_rating != null
            ? inPoolRow.hail_mary_rating - outPoolRow.hail_mary_rating
            : null,
        incomingRating: inPoolRow?.hail_mary_rating ?? null,
        outgoingRating: outPoolRow?.hail_mary_rating ?? null,
        fixtureSwingDiff: (inTeamRating?.swingValue ?? 0) - (outTeamRating?.swingValue ?? 0),
        priceDelta: inCand.price - outPlayer.price,
        incomingMinutesSecurity: LINEUP_SECURITY_SCORES[inPoolRow?.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE,
        outgoingMinutesSecurity: LINEUP_SECURITY_SCORES[outPoolRow?.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE,
        incomingInjuryAvailability: INJURY_AVAILABILITY_SCORES[inPoolRow?.status ?? ""] ?? DEFAULT_SECURITY_SCORE,
        incomingForm: inPoolRow?.form != null ? Number(inPoolRow.form) : null,
        outgoingForm: outPoolRow?.form != null ? Number(outPoolRow.form) : null,
        incomingIsConfirmedStarter: inPoolRow?.lineup === "confirmed_starting",
        hasFixtureData: !!outTeamRating && !!inTeamRating,
        hasStatusData: inPoolRow?.lineup != null && outPoolRow?.lineup != null,
      },
    };
  }

  /**
   * Budget-pooled 2-leg search - see dreamteamAskMaryEngine.ts for the
   * full reasoning (a player who's already the best in their position
   * can never be flagged for sale by the single-slot search alone, even
   * when selling them funds a bigger combined upgrade elsewhere).
   */
  function findBestPairBundle(
    state: SearchState,
    scoreMapForStep: Map<number, number>,
    wildcardActive: boolean,
    soldIds: Set<number>,
    boughtIds: Set<number>,
    currentXITotal: number
  ): { legA: SlotMove; legB: SlotMove; costA: number; costB: number; netGain: number } | null {
    const { workingSquad, workingSquadIds, workingBudget, workingClubCounts, freeRemaining } = state;
    const sellable = workingSquad.filter((p) => !boughtIds.has(p.game_player_id));
    const maxPerClub = rules.max_per_club;

    const shortlistByPosition = new Map<string, TransferCandidate[]>();
    for (const position of ["GK", "DEF", "MID", "FWD"]) {
      const shortlist = (pool ?? [])
        .filter(
          (p) =>
            p.position === position &&
            !workingSquadIds.has(p.game_player_id) &&
            !soldIds.has(p.game_player_id) &&
            !boughtIds.has(p.game_player_id) &&
            !highRiskGamePlayerIds.has(p.game_player_id)
        )
        .map((p) => ({ gamePlayerId: p.game_player_id, fullName: p.full_name, teamId: p.team_id, teamName: p.team_name, price: Number(p.price), score: avgFor(scoreMapForStep, p.game_player_id), rating: p.hail_mary_rating, position: p.position }));
      // Pareto-prune before capping to 15 - see transferMatching.ts's
      // pruneDominatedCandidates. Without this, several near-identical
      // low scorers could fill the whole top-15 at inflated prices,
      // crowding out the one genuinely cheap option among them.
      const pruned = pruneDominatedCandidates(shortlist).sort((a, b) => b.score - a.score).slice(0, 15);
      shortlistByPosition.set(position, pruned);
    }

    let best: { outA: WorkingSquadPlayer; outB: WorkingSquadPlayer; inA: TransferCandidate; inB: TransferCandidate; netGain: number; costA: number; costB: number; gainA: number; gainB: number } | null = null;

    for (let i = 0; i < sellable.length; i++) {
      for (let j = i + 1; j < sellable.length; j++) {
        const outA = sellable[i];
        const outB = sellable[j];
        const freedBudget = workingBudget + outA.price + outB.price;
        const candA = shortlistByPosition.get(outA.position) ?? [];
        const candB = shortlistByPosition.get(outB.position) ?? [];
        const remainingSquadIds = new Set([...workingSquadIds].filter((id) => id !== outA.game_player_id && id !== outB.game_player_id));

        let bestCombo: { inA: TransferCandidate; inB: TransferCandidate; combinedScore: number } | null = null;
        for (const inA of candA) {
          for (const inB of candB) {
            if (inA.gamePlayerId === inB.gamePlayerId) continue;
            if (inA.price + inB.price > freedBudget) continue;
            const contenderOfA = contestedPairs.get(inA.gamePlayerId);
            if (contenderOfA != null && (contenderOfA === inB.gamePlayerId || remainingSquadIds.has(contenderOfA))) continue;
            const contenderOfB = contestedPairs.get(inB.gamePlayerId);
            if (contenderOfB != null && remainingSquadIds.has(contenderOfB)) continue;
            if (maxPerClub) {
              const delta = new Map<number, number>();
              delta.set(outA.team_id, (delta.get(outA.team_id) ?? 0) - 1);
              delta.set(outB.team_id, (delta.get(outB.team_id) ?? 0) - 1);
              delta.set(inA.teamId, (delta.get(inA.teamId) ?? 0) + 1);
              delta.set(inB.teamId, (delta.get(inB.teamId) ?? 0) + 1);
              let overLimit = false;
              for (const [teamId, d] of delta) {
                if ((workingClubCounts.get(teamId) ?? 0) + d > maxPerClub) {
                  overLimit = true;
                  break;
                }
              }
              if (overLimit) continue;
            }
            const combinedScore = inA.score + inB.score;
            if (!bestCombo || combinedScore > bestCombo.combinedScore) bestCombo = { inA, inB, combinedScore };
          }
        }
        if (!bestCombo) continue;

        const costA = transferCost(freeRemaining, wildcardActive);
        const freeAfterA = costA === 0 && !wildcardActive ? freeRemaining - 1 : freeRemaining;
        const costB = transferCost(freeAfterA, wildcardActive);

        const squadAfterA = workingSquad.filter((p) => p.game_player_id !== outA.game_player_id).concat(toWorkingSquadPlayer(bestCombo.inA));
        const xiTotalAfterA = optimalXITotal(squadAfterA, scoreMapForStep);
        const squadAfterBoth = squadAfterA.filter((p) => p.game_player_id !== outB.game_player_id).concat(toWorkingSquadPlayer(bestCombo.inB));
        const xiTotalAfterBoth = optimalXITotal(squadAfterBoth, scoreMapForStep);
        const gainA = xiTotalAfterA - currentXITotal;
        const gainB = xiTotalAfterBoth - xiTotalAfterA;
        // Combined gain across both legs is the bar, not each leg alone
        // (2026-08-10 user call: a slightly negative leg is fine when the
        // other leg's upgrade outweighs it - that's "most projected
        // points," not a bug). What WAS a real bug is candidate selection
        // upstream picking a worse-value candidate at a higher price for
        // one of the legs - see the Pareto-dominance pruning in
        // transferMatching.ts's findLegalReplacementsForOutgoing and the
        // shortlist construction above, which fixes that directly.
        const netGain = gainA + gainB + costA + costB;
        if (netGain <= 0) continue;

        if (!best || netGain > best.netGain) {
          best = { outA, outB, inA: bestCombo.inA, inB: bestCombo.inB, netGain, costA, costB, gainA, gainB };
        }
      }
    }

    if (!best) return null;
    const outScoreA = avgFor(scoreMapForStep, best.outA.game_player_id);
    const outScoreB = avgFor(scoreMapForStep, best.outB.game_player_id);
    return { legA: buildLegInput(best.outA, best.inA, outScoreA, best.gainA), legB: buildLegInput(best.outB, best.inB, outScoreB, best.gainB), costA: best.costA, costB: best.costB, netGain: best.netGain };
  }

  /**
   * Greedy incremental search for one gameweek step - see
   * dreamteamAskMaryEngine.ts for the full reasoning. Each round compares
   * the single best legal transfer against the best budget-pooled pair,
   * takes whichever has the higher realized net gain, applies it
   * hypothetically, and re-searches - stopping once neither option
   * clears cost (or MAX_TRANSFERS_PER_STEP is reached).
   */
  function searchBestMoves(state: SearchState, scoreMapForStep: Map<number, number>, wildcardActive: boolean, soldIds: Set<number>, boughtIds: Set<number>): { transfers: BundleTransfer[] } & SearchState {
    let { workingSquad, workingSquadIds, workingBudget, workingClubCounts, freeRemaining } = state;
    const transfers: BundleTransfer[] = [];

    function toLeg(move: SlotMove, score: MoveScore, costPoints: number): BundleTransfer {
      return {
        outGamePlayerId: move.input.outGamePlayerId,
        outName: move.input.outName,
        outTeam: move.input.outTeam,
        outPrice: move.outPlayer.price,
        inGamePlayerId: move.input.inGamePlayerId,
        inName: move.input.inName,
        inTeam: move.input.inTeam,
        inPrice: move.inCandidate.price,
        inFormStatus: move.inCandidate.formStatus ?? null,
        position: move.input.position,
        pointsGain: Math.round(move.input.expectedPointsGain * 10) / 10,
        costPoints,
        risk: score.risk,
        confidence: score.confidence,
        overall: score.overall,
        reasons: score.reasons,
        warnings: score.warnings,
      };
    }

    function applyLeg(move: SlotMove, consumesFree: boolean) {
      workingBudget -= move.input.priceDelta;
      workingClubCounts.set(move.inCandidate.teamId, (workingClubCounts.get(move.inCandidate.teamId) ?? 0) + 1);
      workingClubCounts.set(move.outPlayer.team_id, (workingClubCounts.get(move.outPlayer.team_id) ?? 0) - 1);
      workingSquad = workingSquad.filter((p) => p.game_player_id !== move.outPlayer.game_player_id).concat(toWorkingSquadPlayer(move.inCandidate));
      workingSquadIds = new Set(workingSquad.map((p) => p.game_player_id));
      soldIds.add(move.outPlayer.game_player_id);
      boughtIds.add(move.inCandidate.gamePlayerId);
      if (consumesFree) freeRemaining -= 1;
    }

    for (let slot = 0; slot < MAX_TRANSFERS_PER_STEP; slot++) {
      const poolCandidates: TransferCandidate[] = (pool ?? [])
        .filter((p) => !soldIds.has(p.game_player_id))
        .map((p) => ({ gamePlayerId: p.game_player_id, fullName: p.full_name, teamId: p.team_id, teamName: p.team_name, price: Number(p.price), score: avgFor(scoreMapForStep, p.game_player_id), rating: p.hail_mary_rating, position: p.position, formStatus: p.formStatus }));

      const currentXITotal = optimalXITotal(workingSquad, scoreMapForStep);

      const slotMoves: SlotMove[] = [];
      for (const outPlayer of workingSquad) {
        if (boughtIds.has(outPlayer.game_player_id)) continue;
        const outScore = avgFor(scoreMapForStep, outPlayer.game_player_id);
        const legalCandidates = findLegalReplacementsForOutgoing(
          poolCandidates,
          {
            gamePlayerId: outPlayer.game_player_id,
            fullName: outPlayer.full_name,
            teamId: outPlayer.team_id,
            teamName: outPlayer.team_name,
            price: outPlayer.price,
            score: outScore,
            rating: poolByGamePlayerId.get(outPlayer.game_player_id)?.hail_mary_rating ?? null,
            position: outPlayer.position,
          },
          workingSquadIds,
          workingBudget,
          workingClubCounts,
          rules.max_per_club,
          contestedPairs,
          highRiskGamePlayerIds
        );
        let bestCandidate: TransferCandidate | null = null;
        let bestGain = 0;
        for (const match of legalCandidates.slice(0, 20)) {
          const hypotheticalSquad = workingSquad.filter((p) => p.game_player_id !== outPlayer.game_player_id).concat(toWorkingSquadPlayer(match.candidate));
          const gain = optimalXITotal(hypotheticalSquad, scoreMapForStep) - currentXITotal;
          if (gain > bestGain) {
            bestGain = gain;
            bestCandidate = match.candidate;
          }
        }
        if (!bestCandidate) continue;
        slotMoves.push(buildLegInput(outPlayer, bestCandidate, outScore, bestGain));
      }

      let bestSingleIdx = -1;
      for (let i = 0; i < slotMoves.length; i++) {
        if (bestSingleIdx === -1 || slotMoves[i].input.expectedPointsGain > slotMoves[bestSingleIdx].input.expectedPointsGain) bestSingleIdx = i;
      }
      // Front-to-back build order (2026-08-10 user call) - see
      // dreamteamAskMaryEngine.ts's equivalent block for the full
      // reasoning.
      if (bestSingleIdx !== -1) {
        const bestGain = slotMoves[bestSingleIdx].input.expectedPointsGain;
        const frontTolerance = Math.max(0.3, bestGain * 0.1);
        for (let i = 0; i < slotMoves.length; i++) {
          if (i === bestSingleIdx) continue;
          const gain = slotMoves[i].input.expectedPointsGain;
          if (bestGain - gain <= frontTolerance && BUILD_PRIORITY[slotMoves[i].input.position] < BUILD_PRIORITY[slotMoves[bestSingleIdx].input.position]) {
            bestSingleIdx = i;
          }
        }
      }
      const singleCost = transferCost(freeRemaining, wildcardActive);
      const singleNetGain = bestSingleIdx !== -1 ? slotMoves[bestSingleIdx].input.expectedPointsGain + singleCost : -Infinity;

      const pairResult = findBestPairBundle({ workingSquad, workingSquadIds, workingBudget, workingClubCounts, freeRemaining }, scoreMapForStep, wildcardActive, soldIds, boughtIds, currentXITotal);
      const pairNetGain = pairResult ? pairResult.netGain : -Infinity;

      if (bestSingleIdx === -1 && !pairResult) break;

      if (pairResult && pairNetGain > singleNetGain) {
        const pairScores = scoreMoveCandidates([pairResult.legA.input, pairResult.legB.input], activeStrategy);
        const legA = toLeg(pairResult.legA, pairScores[0], pairResult.costA);
        const legB = toLeg(pairResult.legB, pairScores[1], pairResult.costB);
        const idxA = transfers.length;
        const idxB = idxA + 1;
        legA.pairedLegIndex = idxB;
        legB.pairedLegIndex = idxA;
        transfers.push(legA, legB);
        applyLeg(pairResult.legA, pairResult.costA === 0 && !wildcardActive);
        applyLeg(pairResult.legB, pairResult.costB === 0 && !wildcardActive);
        continue;
      }

      if (bestSingleIdx === -1 || singleNetGain <= 0) break;

      const scores = scoreMoveCandidates(
        slotMoves.map((m) => m.input),
        activeStrategy
      );
      const chosen = slotMoves[bestSingleIdx];
      const chosenScore = scores[bestSingleIdx];

      let runnerUpIdx = -1;
      for (let i = 0; i < slotMoves.length; i++) {
        if (i === bestSingleIdx) continue;
        const gap = chosen.input.expectedPointsGain - slotMoves[i].input.expectedPointsGain;
        const tolerance = Math.max(0.3, chosen.input.expectedPointsGain * 0.1);
        if (gap <= tolerance && (runnerUpIdx === -1 || slotMoves[i].input.expectedPointsGain > slotMoves[runnerUpIdx].input.expectedPointsGain)) {
          runnerUpIdx = i;
        }
      }

      const leg = toLeg(chosen, chosenScore, singleCost);
      if (runnerUpIdx !== -1) {
        leg.alternatives = [toLeg(slotMoves[runnerUpIdx], scores[runnerUpIdx], singleCost)];
      }
      transfers.push(leg);
      applyLeg(chosen, singleCost === 0 && !wildcardActive);
    }

    return { transfers, workingSquad, workingSquadIds, workingBudget, workingClubCounts, freeRemaining };
  }

  function describeStep(step: { seasonStarted: boolean; transfers: BundleTransfer[]; gameweek: number; freeAfter: number | "unlimited" }): string {
    const { transfers, gameweek, freeAfter } = step;
    if (!step.seasonStarted) {
      if (transfers.length === 0) return "Hold - nothing beats what you already have here.";
      const names = transfers.map((t) => `${t.outName} → ${t.inName}`).join(", ");
      return transfers.length === 1
        ? `Make this move now - transfers are free and unlimited before the season starts: ${names}.`
        : `Make these ${transfers.length} moves now - transfers are free and unlimited before the season starts: ${names}.`;
    }
    if (transfers.length === 0) {
      return `Hold this gameweek - banking your free transfer means you'll have ${freeAfter} available before GW${gameweek + 1}.`;
    }
    const hitCount = transfers.filter((t) => t.costPoints < 0).length;
    const names = transfers.map((t) => `${t.outName} → ${t.inName}`).join(", ");
    if (hitCount === 0) {
      return transfers.length === 1 ? `Make this transfer using a free transfer: ${names}.` : `Use ${transfers.length} free transfers this gameweek: ${names}.`;
    }
    return `Make ${transfers.length} transfer${transfers.length > 1 ? "s" : ""} (${hitCount} at -4 each, still worth it): ${names}.`;
  }

  type StepBranch = { step: GameweekPlanStep; state: SearchState; soldIds: Set<number>; boughtIds: Set<number> };

  /**
   * Computes ONE gameweek step from a given incoming state, in up to two
   * flavours: "greedy" and (only when a real move was available and it
   * isn't the pre-season unlimited-transfers step) "forcedHold" - see
   * dreamteamAskMaryEngine.ts for the full reasoning.
   */
  function computeStepBranches(offset: number, incomingState: SearchState, incomingSoldIds: Set<number>, incomingBoughtIds: Set<number>): { greedy: StepBranch; forcedHold: StepBranch | null } {
    const isPreSeasonStep = !seasonStarted && offset === 1;

    let state = incomingState;
    if (offset > 1) {
      if (!seasonStarted && offset === 2) {
        state = { ...state, freeRemaining: 1 };
      } else {
        state = { ...state, freeRemaining: accrueFreeTransfers(state.freeRemaining) };
      }
    }
    const freeBefore = state.freeRemaining;
    const gameweek = planningGameweek! + offset - 1;
    const wildcardActiveHere = isWildcardActive(gameweek, squad.wildcard_1_used_gameweek ?? null, squad.wildcard_2_used_gameweek ?? null);
    const scoreMapForStep = stepScoreMaps[offset - 1] ?? new Map();
    // Which transfer gets made is decided on the wider PLANNING_LOOKAHEAD_
    // GAMEWEEKS-week view - scoreMapForStep stays 1-week and is only used
    // below for the number actually displayed as this step's points.
    const planningScoreMap = stepPlanningScoreMaps[offset - 1] ?? new Map();

    function buildStep(result: { transfers: BundleTransfer[] } & SearchState): GameweekPlanStep {
      const resultingSquadExpectedPoints = optimalXITotal(result.workingSquad, scoreMapForStep);
      const freeAfterPreview = isPreSeasonStep ? 1 : accrueFreeTransfers(result.freeRemaining);
      const writeup = describeStep({ seasonStarted: !isPreSeasonStep, transfers: result.transfers, gameweek, freeAfter: freeAfterPreview });
      return {
        gameweek,
        offset: offset as 1 | 2 | 3,
        transfers: result.transfers,
        hold: result.transfers.length === 0,
        freeTransfersAvailable: isPreSeasonStep ? "unlimited" : freeBefore,
        freeTransfersAfter: freeAfterPreview,
        budgetRemainingAfter: result.workingBudget,
        resultingSquadExpectedPoints: Math.round(resultingSquadExpectedPoints * 10) / 10,
        writeup,
      };
    }

    const greedySoldIds = new Set(incomingSoldIds);
    const greedyBoughtIds = new Set(incomingBoughtIds);
    const greedyResult = searchBestMoves(state, planningScoreMap, wildcardActiveHere, greedySoldIds, greedyBoughtIds);
    const greedyStep = buildStep(greedyResult);
    const greedyState: SearchState = { workingSquad: greedyResult.workingSquad, workingSquadIds: greedyResult.workingSquadIds, workingBudget: greedyResult.workingBudget, workingClubCounts: greedyResult.workingClubCounts, freeRemaining: greedyResult.freeRemaining };
    const greedy: StepBranch = { step: greedyStep, state: greedyState, soldIds: greedySoldIds, boughtIds: greedyBoughtIds };

    if (isPreSeasonStep || greedyStep.transfers.length === 0) {
      return { greedy, forcedHold: null };
    }

    const holdSoldIds = new Set(incomingSoldIds);
    const holdBoughtIds = new Set(incomingBoughtIds);
    const holdStep = buildStep({ transfers: [], ...state });
    const n = greedyStep.transfers.length;
    holdStep.writeup = `Hold this gameweek instead of using ${n === 1 ? "a transfer" : `${n} transfers`} now - banking pays off more over the next couple of gameweeks than spending it here.`;
    const forcedHold: StepBranch = { step: holdStep, state, soldIds: holdSoldIds, boughtIds: holdBoughtIds };

    return { greedy, forcedHold };
  }

  /**
   * Full-horizon path search - see dreamteamAskMaryEngine.ts for the
   * full reasoning (a bounded tree search, ≤2^3=8 paths for
   * GAMEWEEK_PLAN_LENGTH=3).
   */
  function enumeratePlanPaths(offset: number, state: SearchState, soldIds: Set<number>, boughtIds: Set<number>): { steps: GameweekPlanStep[]; totalScore: number }[] {
    if (offset > GAMEWEEK_PLAN_LENGTH) return [{ steps: [], totalScore: 0 }];

    const { greedy, forcedHold } = computeStepBranches(offset, state, soldIds, boughtIds);
    const branches = forcedHold ? [greedy, forcedHold] : [greedy];

    const paths: { steps: GameweekPlanStep[]; totalScore: number }[] = [];
    for (const branch of branches) {
      const stepCost = branch.step.transfers.reduce((sum, t) => sum + t.costPoints, 0);
      const stepScore = branch.step.resultingSquadExpectedPoints + stepCost;
      const rest = enumeratePlanPaths(offset + 1, branch.state, branch.soldIds, branch.boughtIds);
      for (const r of rest) {
        paths.push({ steps: [branch.step, ...r.steps], totalScore: stepScore + r.totalScore });
      }
    }
    return paths;
  }

  function buildGameweekPlan(): GameweekPlanStep[] {
    if (planningGameweek == null) return [];

    const initialState: SearchState = {
      workingSquad: squadPlayers.map((p) => ({ game_player_id: p.game_player_id, full_name: p.full_name, position: p.position, team_id: p.team_id, team_name: p.team_name, price: p.price })),
      workingSquadIds: new Set(squadPlayers.map((p) => p.game_player_id)),
      workingBudget: budgetRemaining,
      workingClubCounts: new Map(clubCounts),
      freeRemaining: freeTransfersBanked,
    };

    const paths = enumeratePlanPaths(1, initialState, new Set(), new Set());
    if (paths.length === 0) return [];
    let best = paths[0];
    for (const p of paths) {
      if (p.totalScore > best.totalScore) best = p;
    }
    return best.steps;
  }

  const gameweekPlan = buildGameweekPlan();

  const positionAverages: Record<string, number> = {};
  for (const pos of ["GK", "DEF", "MID", "FWD"]) {
    const vals = (pool ?? []).filter((p) => p.position === pos && p.hail_mary_score != null).map((p) => Number(p.hail_mary_score));
    positionAverages[pos] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  const healthPlayers: SquadHealthPlayer[] = squadPlayers.map((p) => ({
    gamePlayerId: p.game_player_id,
    fullName: p.full_name,
    position: p.position,
    teamName: p.team_name,
    price: p.price,
    score: poolByGamePlayerId.get(p.game_player_id)?.hail_mary_score != null ? Number(poolByGamePlayerId.get(p.game_player_id)!.hail_mary_score) : null,
    lineup: p.lineup,
    status: p.status,
    isStarting: p.is_starting,
  }));
  // 5-GW horizon window for fixture-swing awareness - matches the page's
  // own default lookahead.
  const health = assessSquadHealth(healthPlayers, positionAverages, rules.max_per_club, ratingByTeam, 5);

  // Captain & Vice-Captain - picked fresh every gameweek, must be in the
  // starting XI (real FanTeam rule, enforced by setFanteamCaptain too).
  function avgForCaptain(gamePlayerId: number): number {
    return avgFor(captainScoreMap, gamePlayerId);
  }
  const captaincyPool: CaptaincyPick[] = squadPlayers
    .filter((p) => p.is_starting)
    .map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      team_name: p.team_name,
      lineup: p.lineup,
      score: avgForCaptain(p.game_player_id),
      rating: poolByGamePlayerId.get(p.game_player_id)?.hail_mary_rating ?? null,
    }))
    .sort((a, b) => b.score - a.score);
  const bestCaptain = captaincyPool[0] ?? null;
  const viceCaptain = captaincyPool[1] ?? null;

  // Mary Performance Lab - archive this analysis as a batch of immutable
  // predictions - see dreamteamAskMaryEngine.ts for the full reasoning on
  // shape/grouping. recordPredictionsFn is injected rather than imported
  // directly.
  if (planningGameweek != null && recordPredictionsFn) {
    const { data: latestProjection } = await supabase.from("projections").select("algorithm_version_id, season").eq("game_player_id", squadPlayers[0].game_player_id).order("id", { ascending: false }).limit(1).maybeSingle();

    const baseContext = {
      squadId: squad.id,
      gameId: game.id,
      season: latestProjection?.season ?? "unknown",
      algorithmVersionId: latestProjection?.algorithm_version_id ?? null,
      recommendationWeights: STRATEGY_WEIGHTS[activeStrategy],
      strategy: activeStrategy,
      transferLimit: null,
      budgetRemainingBefore: budgetRemaining,
      freeTransfersBefore: squad.free_transfers,
    };

    const predictionRecords: PredictionRecord[] = [];

    for (const step of gameweekPlan) {
      const sharedContext = { ...baseContext, gameweek: step.gameweek, planningHorizon: step.offset };

      if (step.hold) {
        predictionRecords.push({
          ...sharedContext,
          kind: "hold",
          recommendationType: "gw_plan",
          rank: null,
          outGamePlayerId: null,
          inGamePlayerId: null,
          outPrice: null,
          inPrice: null,
          transferCost: null,
          captainGamePlayerId: null,
          viceCaptainGamePlayerId: null,
          expectedPointsBefore: null,
          expectedPointsAfter: null,
          expectedGain: null,
          hailMaryScoreDiff: null,
          fixtureSwingDiff: null,
          maryMoveScore: null,
          confidence: null,
          risk: null,
          reasons: [{ code: "hold", text: step.writeup }],
          warnings: [],
        });
      } else {
        step.transfers.forEach((t, i) => {
          predictionRecords.push({
            ...sharedContext,
            kind: "transfer",
            recommendationType: "gw_plan",
            rank: i + 1,
            outGamePlayerId: t.outGamePlayerId,
            inGamePlayerId: t.inGamePlayerId,
            outPrice: t.outPrice,
            inPrice: t.inPrice,
            transferCost: t.inPrice - t.outPrice,
            captainGamePlayerId: null,
            viceCaptainGamePlayerId: null,
            expectedPointsBefore: null,
            expectedPointsAfter: null,
            expectedGain: t.pointsGain + t.costPoints,
            hailMaryScoreDiff: null,
            fixtureSwingDiff: null,
            maryMoveScore: t.overall,
            confidence: t.confidence,
            risk: t.risk,
            reasons: t.reasons,
            warnings: t.warnings,
          });
        });
      }
    }

    if (bestCaptain && viceCaptain) {
      predictionRecords.push({
        ...baseContext,
        gameweek: planningGameweek,
        planningHorizon: captainHorizonGameweeks,
        kind: "captain",
        recommendationType: "best_captain",
        rank: null,
        outGamePlayerId: null,
        inGamePlayerId: null,
        outPrice: null,
        inPrice: null,
        transferCost: null,
        captainGamePlayerId: bestCaptain.game_player_id,
        viceCaptainGamePlayerId: viceCaptain.game_player_id,
        expectedPointsBefore: null,
        expectedPointsAfter: null,
        expectedGain: null,
        hailMaryScoreDiff: null,
        fixtureSwingDiff: null,
        maryMoveScore: null,
        confidence: null,
        risk: null,
        reasons: [{ code: "top_scorer", text: `${bestCaptain.full_name} is the highest-projected starter over this horizon.` }],
        warnings: [],
      });
    }

    if (predictionRecords.length > 0) {
      await recordPredictionsFn(predictionRecords).catch(() => ({}));
    }
  }

  return {
    squadPlayers,
    rules,
    budgetRemaining,
    hasCalendar,
    seasonStarted,
    planningGameweek,
    gameweekPlan,
    bestCaptain,
    viceCaptain,
    health,
  };
}

export { toPredictionRow };
