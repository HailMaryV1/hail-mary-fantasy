import type { createAuthServerClient } from "./supabaseServerClient";
import { getSeasonTiming } from "./gameweek";
import { findLegalReplacementsForOutgoing, pruneDominatedCandidates, type TransferCandidate } from "./transferMatching";
import { fetchRotationRiskByPlayerIds, buildContestedGamePlayerPairs, buildHighRiskGamePlayerIds } from "./rotationRisk";
import { type FixtureDifficultyRow } from "./fixtureRuns";
import { deriveTeamFixtureRatings } from "./fixtureSwing";
import { LINEUP_SECURITY_SCORES, INJURY_AVAILABILITY_SCORES, DEFAULT_SECURITY_SCORE } from "./playerStatus";
import { buildFormByGamePlayerId, type FormStatus } from "./hailMaryForm";
import { getMatchDaysForSquad, resolveAutoPick, countUncoveredMatchDays } from "./matchDayCaptains";
import { scoreMoveCandidates, STRATEGY_WEIGHTS, type Strategy, type MoveCandidateInput, type MoveScore, type MoveReason } from "./recommendationScoring";
import { assessSquadHealth, type SquadHealthPlayer, type SquadHealthReport } from "./squadHealth";
import { toPredictionRow, type PredictionRecord } from "./predictionArchive";

// Cloud FF only, for now - see the plan this was built against. Its own
// dedicated file rather than a branch on Dream Team's/FanTeam's, per this
// app's per-game independent identity rule.
//
// Cloud FF's real rules (traced from cloudff/actions.ts and live DB
// state, not assumed): no bench at all (squad_size = starting_size = 11,
// every squad member always counts - flat-sum optimalXITotal, same
// simplification as Dream Team, NOT FanTeam's formation/bench search),
// transfers always free with no club limit and no schema support yet for
// the real 50/season+Overhaul model (so this engine doesn't invent one -
// transferCost is hardcoded to 0, no free-transfer bookkeeping, no
// wildcard), and captaincy is picked per real calendar match-day, not
// per gameweek - the one mechanic none of the other games have.
type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

const GAMEWEEK_PLAN_LENGTH = 3;
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
  pointsGain: number;
  costPoints: number; // always 0 - Cloud FF transfers are always free
  risk: MoveScore["risk"];
  confidence: number;
  overall: number;
  reasons: MoveReason[];
  warnings: MoveReason[];
  alternatives?: BundleTransfer[];
  pairedLegIndex?: number;
};

export type GameweekPlanStep = {
  gameweek: number;
  offset: 1 | 2 | 3;
  transfers: BundleTransfer[];
  hold: boolean;
  freeTransfersAvailable: "unlimited";
  freeTransfersAfter: "unlimited";
  budgetRemainingAfter: number;
  resultingSquadExpectedPoints: number;
  writeup: string;
};

/** One real calendar match-day's captain recommendation. */
export type MatchDayCaptainPick = {
  matchDate: string;
  gameweek: number;
  captain: { game_player_id: number; full_name: string; team_name: string; score: number } | null;
  vice: { game_player_id: number; full_name: string; team_name: string; score: number } | null;
  autoPicked: boolean;
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
    // Cloud FF's OWN classification, not the shared players.position which
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
  captainsByMatchDay: MatchDayCaptainPick[];
  health: SquadHealthReport;
};

/**
 * The Cloud FF Ask Mary pipeline for one squad: fetches its players/pool/
 * fixtures, builds a sequential gameweek-by-gameweek transfer plan (see
 * buildGameweekPlan, every transfer free by construction) plus a real
 * per-match-day captain recommendation and squad health, then archives
 * all of it as immutable predictions (Mary Performance Lab).
 */
export async function runAskMaryAnalysis(
  supabase: Supabase,
  squad: { id: number; name: string },
  game: { id: number; display_name: string; slug: string },
  activeStrategy: Strategy,
  recordPredictionsFn?: (records: PredictionRecord[]) => Promise<{ error?: string } | { recorded: number }>
): Promise<AskMaryAnalysis | null> {
  const nowIso = new Date().toISOString();
  const [{ data: rulesRow }, { data: squadPlayersRaw }, { data: poolRaw }, { data: formRows }, { data: gwRow }, { data: fixturesRaw }, { data: difficultyRaw }, seasonTiming] =
    await Promise.all([
      supabase.from("game_squad_rules").select("budget, max_per_club, squad_size, starting_size").eq("game_id", game.id).single(),
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

  const formByGamePlayerId = buildFormByGamePlayerId(formRows ?? []);
  const pool: PoolRow[] = (poolRaw ?? []).map((p) => ({ ...p, formStatus: formByGamePlayerId.get(p.game_player_id)?.status ?? null }));
  const poolByGamePlayerId = new Map(pool.map((p) => [p.game_player_id, p]));

  // Rotation risk (migration 0111/0112) - real Premier League data, in
  // scope for Cloud FF (see feedback_data_source_scope_correlation for why
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
  const squadIds = new Set(squadPlayers.map((p) => p.game_player_id));

  const currentGameweek: number | null = gwRow?.gameweek ?? null;
  const hasCalendar = currentGameweek !== null;
  const { seasonStarted, planningGameweek } = seasonTiming;

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

  const stepGameweeks = planningGameweek != null ? [0, 1, 2].map((offset) => planningGameweek + offset) : [];
  const [stepScoreMaps, stepPlanningScoreMaps] = await Promise.all([
    Promise.all(stepGameweeks.map((gw) => getStepScoreMap(gw))),
    Promise.all(stepGameweeks.map((gw) => getStepPlanningScoreMap(gw))),
  ]);

  function avgFor(map: Map<number, number>, gamePlayerId: number): number {
    if (map.size > 0) return map.get(gamePlayerId) ?? 0;
    const hms = poolByGamePlayerId.get(gamePlayerId)?.hail_mary_score;
    return hms != null ? Number(hms) : 0;
  }

  // No bench - every squad member always starts and always counts, so
  // this is a flat sum (same reasoning as dreamteamAskMaryEngine.ts's
  // optimalXITotal, not FanTeam's formation/bench-aware search).
  function optimalXITotal(squad: WorkingSquadPlayer[], scoreMapForStep: Map<number, number>): number {
    return squad.reduce((sum, p) => sum + avgFor(scoreMapForStep, p.game_player_id), 0);
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

  type SearchState = { workingSquad: WorkingSquadPlayer[]; workingSquadIds: Set<number>; workingBudget: number };
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
   * full reasoning. No club-limit check (Cloud FF has none) and no
   * transfer cost (always free) - every pair that raises the realized
   * total at all is worth it, so netGain is just gainA + gainB.
   */
  function findBestPairBundle(state: SearchState, scoreMapForStep: Map<number, number>, soldIds: Set<number>, boughtIds: Set<number>, currentXITotal: number): { legA: SlotMove; legB: SlotMove; netGain: number } | null {
    const { workingSquad, workingSquadIds, workingBudget } = state;
    const sellable = workingSquad.filter((p) => !boughtIds.has(p.game_player_id));

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
        .map((p) => ({ gamePlayerId: p.game_player_id, fullName: p.full_name, teamId: p.team_id, teamName: p.team_name, price: Number(p.price), score: avgFor(scoreMapForStep, p.game_player_id), position: p.position }));
      // Pareto-prune before capping to 15 - see transferMatching.ts's
      // pruneDominatedCandidates. Without this, several near-identical
      // low scorers could fill the whole top-15 at inflated prices,
      // crowding out the one genuinely cheap option among them.
      const pruned = pruneDominatedCandidates(shortlist).sort((a, b) => b.score - a.score).slice(0, 15);
      shortlistByPosition.set(position, pruned);
    }

    let best: { outA: WorkingSquadPlayer; outB: WorkingSquadPlayer; inA: TransferCandidate; inB: TransferCandidate; netGain: number; gainA: number; gainB: number } | null = null;

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
            const combinedScore = inA.score + inB.score;
            if (!bestCombo || combinedScore > bestCombo.combinedScore) bestCombo = { inA, inB, combinedScore };
          }
        }
        if (!bestCombo) continue;

        const squadAfterA = workingSquad.filter((p) => p.game_player_id !== outA.game_player_id).concat(toWorkingSquadPlayer(bestCombo.inA));
        const xiTotalAfterA = optimalXITotal(squadAfterA, scoreMapForStep);
        const squadAfterBoth = squadAfterA.filter((p) => p.game_player_id !== outB.game_player_id).concat(toWorkingSquadPlayer(bestCombo.inB));
        const xiTotalAfterBoth = optimalXITotal(squadAfterBoth, scoreMapForStep);
        const gainA = xiTotalAfterA - currentXITotal;
        const gainB = xiTotalAfterBoth - xiTotalAfterA;
        // Combined gain across both legs is the bar, not each leg alone -
        // see dreamteamAskMaryEngine.ts's findBestPairBundle for the full
        // reasoning (2026-08-10 user call).
        const netGain = gainA + gainB;
        if (netGain <= 0) continue;

        if (!best || netGain > best.netGain) {
          best = { outA, outB, inA: bestCombo.inA, inB: bestCombo.inB, netGain, gainA, gainB };
        }
      }
    }

    if (!best) return null;
    const outScoreA = avgFor(scoreMapForStep, best.outA.game_player_id);
    const outScoreB = avgFor(scoreMapForStep, best.outB.game_player_id);
    return { legA: buildLegInput(best.outA, best.inA, outScoreA, best.gainA), legB: buildLegInput(best.outB, best.inB, outScoreB, best.gainB), netGain: best.netGain };
  }

  /**
   * Greedy incremental search for one gameweek step - see
   * dreamteamAskMaryEngine.ts for the full reasoning. No cost/club-limit
   * bookkeeping here at all (Cloud FF has neither).
   */
  function searchBestMoves(state: SearchState, scoreMapForStep: Map<number, number>, soldIds: Set<number>, boughtIds: Set<number>): { transfers: BundleTransfer[] } & SearchState {
    let { workingSquad, workingSquadIds, workingBudget } = state;
    const transfers: BundleTransfer[] = [];

    function toLeg(move: SlotMove, score: MoveScore): BundleTransfer {
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
        costPoints: 0,
        risk: score.risk,
        confidence: score.confidence,
        overall: score.overall,
        reasons: score.reasons,
        warnings: score.warnings,
      };
    }

    function applyLeg(move: SlotMove) {
      workingBudget -= move.input.priceDelta;
      workingSquad = workingSquad.filter((p) => p.game_player_id !== move.outPlayer.game_player_id).concat(toWorkingSquadPlayer(move.inCandidate));
      workingSquadIds = new Set(workingSquad.map((p) => p.game_player_id));
      soldIds.add(move.outPlayer.game_player_id);
      boughtIds.add(move.inCandidate.gamePlayerId);
    }

    for (let slot = 0; slot < MAX_TRANSFERS_PER_STEP; slot++) {
      const poolCandidates: TransferCandidate[] = (pool ?? [])
        .filter((p) => !soldIds.has(p.game_player_id))
        .map((p) => ({ gamePlayerId: p.game_player_id, fullName: p.full_name, teamId: p.team_id, teamName: p.team_name, price: Number(p.price), score: avgFor(scoreMapForStep, p.game_player_id), position: p.position, formStatus: p.formStatus }));

      const currentXITotal = optimalXITotal(workingSquad, scoreMapForStep);

      const slotMoves: SlotMove[] = [];
      for (const outPlayer of workingSquad) {
        if (boughtIds.has(outPlayer.game_player_id)) continue;
        const outScore = avgFor(scoreMapForStep, outPlayer.game_player_id);
        const legalCandidates = findLegalReplacementsForOutgoing(
          poolCandidates,
          { gamePlayerId: outPlayer.game_player_id, fullName: outPlayer.full_name, teamId: outPlayer.team_id, teamName: outPlayer.team_name, price: outPlayer.price, score: outScore, position: outPlayer.position },
          workingSquadIds,
          workingBudget,
          new Map(), // no club-limit map needed - max_per_club is null for Cloud FF
          null,
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
      const singleNetGain = bestSingleIdx !== -1 ? slotMoves[bestSingleIdx].input.expectedPointsGain : -Infinity;

      const pairResult = findBestPairBundle({ workingSquad, workingSquadIds, workingBudget }, scoreMapForStep, soldIds, boughtIds, currentXITotal);
      const pairNetGain = pairResult ? pairResult.netGain : -Infinity;

      if (bestSingleIdx === -1 && !pairResult) break;

      if (pairResult && pairNetGain > singleNetGain) {
        const pairScores = scoreMoveCandidates([pairResult.legA.input, pairResult.legB.input], activeStrategy);
        const legA = toLeg(pairResult.legA, pairScores[0]);
        const legB = toLeg(pairResult.legB, pairScores[1]);
        const idxA = transfers.length;
        const idxB = idxA + 1;
        legA.pairedLegIndex = idxB;
        legB.pairedLegIndex = idxA;
        transfers.push(legA, legB);
        applyLeg(pairResult.legA);
        applyLeg(pairResult.legB);
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

      const leg = toLeg(chosen, chosenScore);
      if (runnerUpIdx !== -1) {
        leg.alternatives = [toLeg(slotMoves[runnerUpIdx], scores[runnerUpIdx])];
      }
      transfers.push(leg);
      applyLeg(chosen);
    }

    return { transfers, workingSquad, workingSquadIds, workingBudget };
  }

  function describeStep(transfers: BundleTransfer[]): string {
    if (transfers.length === 0) return "Hold - nothing beats what you already have here.";
    const names = transfers.map((t) => `${t.outName} → ${t.inName}`).join(", ");
    return transfers.length === 1 ? `Make this transfer - Cloud FF transfers are free: ${names}.` : `Make these ${transfers.length} transfers - Cloud FF transfers are free: ${names}.`;
  }

  type StepBranch = { step: GameweekPlanStep; state: SearchState; soldIds: Set<number>; boughtIds: Set<number> };

  /**
   * Computes ONE gameweek step. Unlike the other games, there's no
   * "forcedHold" branch to explore here - with transfers always free and
   * no free-transfer supply to bank, there's never a reason to withhold
   * a move that clears its own cost (>0 realized gain) in favour of a
   * later gameweek. Greedy IS optimal per step for Cloud FF.
   */
  function computeStep(offset: number, incomingState: SearchState, incomingSoldIds: Set<number>, incomingBoughtIds: Set<number>): StepBranch {
    const gameweek = planningGameweek! + offset - 1;
    const scoreMapForStep = stepScoreMaps[offset - 1] ?? new Map();
    // Which transfer gets made is decided on the wider PLANNING_LOOKAHEAD_
    // GAMEWEEKS-week view - scoreMapForStep stays 1-week and is only used
    // below for the number actually displayed as this step's points.
    const planningScoreMap = stepPlanningScoreMaps[offset - 1] ?? new Map();

    const soldIds = new Set(incomingSoldIds);
    const boughtIds = new Set(incomingBoughtIds);
    const result = searchBestMoves(incomingState, planningScoreMap, soldIds, boughtIds);
    const resultingSquadExpectedPoints = optimalXITotal(result.workingSquad, scoreMapForStep);
    const step: GameweekPlanStep = {
      gameweek,
      offset: offset as 1 | 2 | 3,
      transfers: result.transfers,
      hold: result.transfers.length === 0,
      freeTransfersAvailable: "unlimited",
      freeTransfersAfter: "unlimited",
      budgetRemainingAfter: result.workingBudget,
      resultingSquadExpectedPoints: Math.round(resultingSquadExpectedPoints * 10) / 10,
      writeup: describeStep(result.transfers),
    };
    const state: SearchState = { workingSquad: result.workingSquad, workingSquadIds: result.workingSquadIds, workingBudget: result.workingBudget };
    return { step, state, soldIds, boughtIds };
  }

  function buildGameweekPlan(): GameweekPlanStep[] {
    if (planningGameweek == null) return [];

    let state: SearchState = {
      workingSquad: squadPlayers.map((p) => ({ game_player_id: p.game_player_id, full_name: p.full_name, position: p.position, team_id: p.team_id, team_name: p.team_name, price: p.price })),
      workingSquadIds: new Set(squadPlayers.map((p) => p.game_player_id)),
      workingBudget: budgetRemaining,
    };
    let soldIds = new Set<number>();
    let boughtIds = new Set<number>();
    const steps: GameweekPlanStep[] = [];

    for (let offset = 1; offset <= GAMEWEEK_PLAN_LENGTH; offset++) {
      const branch = computeStep(offset, state, soldIds, boughtIds);
      steps.push(branch.step);
      state = branch.state;
      soldIds = branch.soldIds;
      boughtIds = branch.boughtIds;
    }
    return steps;
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
  const health = assessSquadHealth(healthPlayers, positionAverages, rules.max_per_club, ratingByTeam, 5);

  // Cloud FF's real captain rule - one per real calendar match-day, not
  // per gameweek. Reuses the exact same eligibility query the real
  // setMatchDayCaptain action and the Captains page use, so this
  // recommendation can never disagree with what's actually pickable.
  let captainsByMatchDay: MatchDayCaptainPick[] = [];
  if (planningGameweek !== null) {
    const matchDays = await getMatchDaysForSquad(supabase, game.id, squad.id, planningGameweek, planningGameweek + GAMEWEEK_PLAN_LENGTH - 1);

    // Real user request 2026-08-18: "I would want Mary to ensure i have a
    // captain for every single gameday." Mary now genuinely auto-fills
    // every day that HAS an eligible player (see matchDayCaptains.ts's
    // ensureAutoPicks) - the one thing left worth flagging as a squad
    // weakness is a day with zero eligible players at all, which no
    // captain logic can fix, only a transfer can.
    const uncoveredMatchDayCount = countUncoveredMatchDays(matchDays);
    if (uncoveredMatchDayCount > 0) {
      health.weaknesses = [
        `${uncoveredMatchDayCount} upcoming match-day${uncoveredMatchDayCount === 1 ? "" : "s"} with no squad player fixture - no captain possible those days without a transfer.`,
        ...health.weaknesses,
      ].slice(0, 5);
    }

    const captainScoreMap = stepScoreMaps[0] ?? new Map();
    captainsByMatchDay = matchDays.map((day) => {
      const auto = resolveAutoPick(day);
      const ranked = day.eligiblePlayers.map((p) => ({ game_player_id: p.gamePlayerId, full_name: p.fullName, team_name: p.teamName, score: avgFor(captainScoreMap, p.gamePlayerId) })).sort((a, b) => b.score - a.score);
      const captain = auto ? { game_player_id: auto.captain.gamePlayerId, full_name: auto.captain.fullName, team_name: auto.captain.teamName, score: avgFor(captainScoreMap, auto.captain.gamePlayerId) } : (ranked[0] ?? null);
      return {
        matchDate: day.matchDate,
        gameweek: day.gameweek,
        captain,
        vice: auto ? null : (ranked[1] ?? null),
        autoPicked: auto !== null,
      };
    });
  }

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
      freeTransfersBefore: null,
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
            expectedGain: t.pointsGain,
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

    // Cloud FF's real captain rule - one prediction row per real
    // match-day with a real captain, not a single gameweek-level
    // "best_captain" row (that concept doesn't apply here). Real
    // match-days can share the same gameweek, so distinct `rank` values
    // (index + 1) keep them from colliding under the predictions_dedup_key
    // unique index (migration 0041) - same mechanism a multi-leg
    // transfer bundle already uses.
    captainsByMatchDay.forEach((day, index) => {
      if (!day.captain) return;
      predictionRecords.push({
        ...baseContext,
        gameweek: day.gameweek,
        planningHorizon: 1,
        kind: "captain",
        recommendationType: "match_day_captain",
        rank: index + 1,
        outGamePlayerId: null,
        inGamePlayerId: null,
        outPrice: null,
        inPrice: null,
        transferCost: null,
        captainGamePlayerId: day.captain.game_player_id,
        viceCaptainGamePlayerId: day.vice?.game_player_id ?? null,
        expectedPointsBefore: null,
        expectedPointsAfter: null,
        expectedGain: null,
        hailMaryScoreDiff: null,
        fixtureSwingDiff: null,
        maryMoveScore: null,
        confidence: null,
        risk: null,
        reasons: [
          {
            code: day.autoPicked ? "auto_pick" : "top_scorer",
            text: day.autoPicked ? `${day.captain.full_name} is the only squad player with a fixture on ${day.matchDate}.` : `${day.captain.full_name} is the highest-projected squad player with a fixture on ${day.matchDate}.`,
          },
        ],
        warnings: [],
      });
    });

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
    captainsByMatchDay,
    health,
  };
}

export { toPredictionRow };
