import type { createAuthServerClient } from "./supabaseServerClient";
import { getSeasonTiming } from "./gameweek";
import { findLegalReplacementsForOutgoing, type TransferCandidate } from "./transferMatching";
import { type FixtureDifficultyRow } from "./fixtureRuns";
import { deriveTeamFixtureRatings } from "./fixtureSwing";
import { LINEUP_SECURITY_SCORES, INJURY_AVAILABILITY_SCORES, DEFAULT_SECURITY_SCORE } from "./playerStatus";
import { buildFormByGamePlayerId, type FormStatus } from "./hailMaryForm";
import { getClubPickCounts, CLUB_CAP } from "./eflClubCapCheck";
import { scoreMoveCandidates, STRATEGY_WEIGHTS, type Strategy, type MoveCandidateInput, type MoveScore, type MoveReason } from "./recommendationScoring";
import { assessSquadHealth, type SquadHealthPlayer, type SquadHealthReport } from "./squadHealth";
import { toPredictionRow, type PredictionRecord } from "./predictionArchive";

// EFL Fantasy only, for now - its own dedicated file per this app's
// per-game independent identity rule, not a branch on Cloud FF's.
//
// EFL Fantasy's real rules (traced from migrations 0087-0091 and live
// fantasy.efl.com state): 9 fixed picks, no bench (1 GK/2 DEF/2 MID/2
// FWD + 2 CLUB), NO budget at all, and no per-gameweek captain concept -
// captaincy only ever exists via the Max Captain booster (retroactive,
// twice/season). That absence of a budget is the key simplification over
// cloudffAskMaryEngine.ts: with nothing to pool, the 2-leg
// findBestPairBundle search that file needs has no reason to exist here -
// a plain greedy single-slot search is already globally optimal. Club
// picks are a completely separate pool from players (no shared budget to
// compete over), so they get their own recommendation pass rather than
// being interleaved into the player search loop.
type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

const GAMEWEEK_PLAN_LENGTH = 3;
const MAX_PLAYER_TRANSFERS_PER_STEP = 7; // one per non-CLUB squad slot, at most

/** One leg of a player transfer recommendation - a single sell/buy pair. */
export type BundleTransfer = {
  outGamePlayerId: number;
  outName: string;
  outTeam: string;
  inGamePlayerId: number;
  inName: string;
  inTeam: string;
  inFormStatus?: FormStatus | null;
  position: "GK" | "DEF" | "MID" | "FWD";
  pointsGain: number;
  risk: MoveScore["risk"];
  confidence: number;
  overall: number;
  reasons: MoveReason[];
  warnings: MoveReason[];
  alternatives?: BundleTransfer[];
};

export type GameweekPlanStep = {
  gameweek: number;
  offset: 1 | 2 | 3;
  transfers: BundleTransfer[];
  hold: boolean;
  resultingSquadExpectedPoints: number;
  writeup: string;
};

/** One leg of a club-pick swap - simpler than a player leg, no position/injury/lineup dimensions apply to a club. */
export type ClubTransferRec = {
  outGamePlayerId: number;
  outClubName: string;
  inGamePlayerId: number;
  inClubName: string;
  pointsGain: number;
  reasoning: string;
};

export type ClubRecommendation = {
  gameweek: number;
  transfers: ClubTransferRec[];
  hold: boolean;
  writeup: string;
};

export type MaxCaptainAdvice = {
  usesRemaining: number;
  best: { game_player_id: number; full_name: string; team_name: string; score: number } | null;
  gain: number;
  reasoning: string;
};

type PoolRow = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD" | "CLUB";
  team_id: number;
  team_name: string;
  hail_mary_score: number | null;
  lineup: string | null;
  status: string | null;
  form: number | null;
  formStatus?: FormStatus | null;
};

type SquadPlayerRow = {
  game_player_id: number;
  game_players: {
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD" | "CLUB"; team_id: number; teams: { name: string } };
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
};

type SquadPlayerOut = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  lineup: string | null;
  status: string | null;
  form: number | null;
};

type SquadClubOut = { game_player_id: number; club_name: string; team_id: number };

export type AskMaryAnalysis = {
  squadPlayers: SquadPlayerOut[];
  squadClubs: SquadClubOut[];
  hasCalendar: boolean;
  seasonStarted: boolean;
  planningGameweek: number | null;
  gameweekPlan: GameweekPlanStep[];
  clubRecommendation: ClubRecommendation | null;
  maxCaptainAdvice: MaxCaptainAdvice | null;
  oneClubUsedGameweek: number | null;
  health: SquadHealthReport;
};

/**
 * The EFL Fantasy Ask Mary pipeline for one squad: fetches its players/
 * clubs/pool/fixtures, builds a sequential 3-gameweek player transfer plan
 * (see buildGameweekPlan - every transfer free by construction, no budget
 * to track), a single current-gameweek club-pick recommendation (see
 * buildClubRecommendation), Max Captain hedge advice, and squad health,
 * then archives the actionable parts as immutable predictions (Mary
 * Performance Lab).
 */
export async function runAskMaryAnalysis(
  supabase: Supabase,
  squad: { id: number; name: string },
  game: { id: number; display_name: string; slug: string },
  activeStrategy: Strategy,
  recordPredictionsFn?: (records: PredictionRecord[]) => Promise<{ error?: string } | { recorded: number }>
): Promise<AskMaryAnalysis | null> {
  const nowIso = new Date().toISOString();
  const [{ data: squadRow }, { data: squadPlayersRaw }, { data: poolRaw }, { data: formRows }, { data: gwRow }, { data: fixturesRaw }, { data: difficultyRaw }, seasonTiming] =
    await Promise.all([
      supabase
        .from("squads")
        .select("efl_max_captain_used_gameweek_1, efl_max_captain_used_gameweek_2, efl_one_club_used_gameweek")
        .eq("id", squad.id)
        .single(),
      supabase
        .from("squad_players")
        .select("game_player_id, game_players(players(full_name, position, team_id, teams!players_team_id_fkey(name)))")
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

  const formByGamePlayerId = buildFormByGamePlayerId(formRows ?? []);
  const pool: PoolRow[] = (poolRaw ?? []).map((p) => ({ ...p, formStatus: formByGamePlayerId.get(p.game_player_id)?.status ?? null }));
  const poolByGamePlayerId = new Map(pool.map((p) => [p.game_player_id, p]));
  const playerPool = pool.filter((p): p is PoolRow & { position: "GK" | "DEF" | "MID" | "FWD" } => p.position !== "CLUB");
  const clubPool = pool.filter((p) => p.position === "CLUB");

  const allSquadPicks = (squadPlayersRaw ?? []).map((sp) => {
    const poolRow = poolByGamePlayerId.get(sp.game_player_id);
    return {
      game_player_id: sp.game_player_id,
      full_name: sp.game_players.players.full_name,
      position: sp.game_players.players.position,
      team_id: sp.game_players.players.team_id,
      team_name: sp.game_players.players.teams.name,
      lineup: poolRow?.lineup ?? null,
      status: poolRow?.status ?? null,
      form: poolRow?.form != null ? Number(poolRow.form) : null,
    };
  });
  const squadPlayers: SquadPlayerOut[] = allSquadPicks.filter((p): p is SquadPlayerOut & { position: "GK" | "DEF" | "MID" | "FWD" } => p.position !== "CLUB");
  const squadClubs: SquadClubOut[] = allSquadPicks.filter((p) => p.position === "CLUB").map((c) => ({ game_player_id: c.game_player_id, club_name: c.full_name, team_id: c.team_id }));

  // EFL Fantasy's squad shape is fixed, not formation-driven (migration
  // 0089) - 7 non-CLUB picks + 2 CLUB picks, always. A squad short of
  // either isn't ready for analysis yet.
  if (squadPlayers.length !== 7 || squadClubs.length !== 2) return null;

  const squadPlayerIds = new Set(squadPlayers.map((p) => p.game_player_id));
  const squadClubIds = new Set(squadClubs.map((c) => c.game_player_id));

  const currentGameweek: number | null = gwRow?.gameweek ?? null;
  const hasCalendar = currentGameweek !== null;
  const { seasonStarted, planningGameweek } = seasonTiming;

  async function getStepScoreMap(gameweek: number): Promise<Map<number, number>> {
    if (!hasCalendar) return new Map();
    const { data } = await supabase.rpc("player_score_by_horizon_from", { p_game_slug: game.slug, p_start_gameweek: gameweek, p_num_gameweeks: 1 });
    return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
  }

  const stepGameweeks = planningGameweek != null ? [0, 1, 2].map((offset) => planningGameweek + offset) : [];
  const stepScoreMaps = await Promise.all(stepGameweeks.map((gw) => getStepScoreMap(gw)));

  function avgFor(map: Map<number, number>, gamePlayerId: number): number {
    if (map.size > 0) return map.get(gamePlayerId) ?? 0;
    const hms = poolByGamePlayerId.get(gamePlayerId)?.hail_mary_score;
    return hms != null ? Number(hms) : 0;
  }

  // No bench, no CLUB picks in this sum - a flat total over the 7 player
  // slots only (same reasoning as dreamteamAskMaryEngine.ts's
  // optimalXITotal). CLUB picks are scored/optimized entirely separately
  // below since they're not part of this squad's "starting XI" concept.
  function playersTotal(list: WorkingSquadPlayer[], scoreMapForStep: Map<number, number>): number {
    return list.reduce((sum, p) => sum + avgFor(scoreMapForStep, p.game_player_id), 0);
  }

  function toWorkingSquadPlayer(cand: TransferCandidate): WorkingSquadPlayer {
    return { game_player_id: cand.gamePlayerId, full_name: cand.fullName, position: cand.position, team_id: cand.teamId, team_name: cand.teamName };
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
        priceDelta: 0, // no budget in this game at all
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
   * Greedy incremental search for one gameweek step's player transfers.
   * No pair-bundle search (see this file's top docstring - nothing to
   * pool without a budget) and no cost/club-limit bookkeeping (EFL
   * Fantasy has neither for individual players - see migration 0089's
   * max_per_club=null).
   */
  function searchPlayerMoves(workingSquadIn: WorkingSquadPlayer[], scoreMapForStep: Map<number, number>, soldIds: Set<number>, boughtIds: Set<number>): { transfers: BundleTransfer[]; workingSquad: WorkingSquadPlayer[] } {
    let workingSquad = workingSquadIn;
    let workingSquadIds = new Set(workingSquad.map((p) => p.game_player_id));
    const transfers: BundleTransfer[] = [];

    function toLeg(move: SlotMove, score: MoveScore): BundleTransfer {
      return {
        outGamePlayerId: move.input.outGamePlayerId,
        outName: move.input.outName,
        outTeam: move.input.outTeam,
        inGamePlayerId: move.input.inGamePlayerId,
        inName: move.input.inName,
        inTeam: move.input.inTeam,
        inFormStatus: move.inCandidate.formStatus ?? null,
        position: move.input.position,
        pointsGain: Math.round(move.input.expectedPointsGain * 10) / 10,
        risk: score.risk,
        confidence: score.confidence,
        overall: score.overall,
        reasons: score.reasons,
        warnings: score.warnings,
      };
    }

    function applyLeg(move: SlotMove) {
      workingSquad = workingSquad.filter((p) => p.game_player_id !== move.outPlayer.game_player_id).concat(toWorkingSquadPlayer(move.inCandidate));
      workingSquadIds = new Set(workingSquad.map((p) => p.game_player_id));
      soldIds.add(move.outPlayer.game_player_id);
      boughtIds.add(move.inCandidate.gamePlayerId);
    }

    for (let slot = 0; slot < MAX_PLAYER_TRANSFERS_PER_STEP; slot++) {
      const poolCandidates: TransferCandidate[] = playerPool
        .filter((p) => !soldIds.has(p.game_player_id))
        .map((p) => ({ gamePlayerId: p.game_player_id, fullName: p.full_name, teamId: p.team_id, teamName: p.team_name, price: 0, score: avgFor(scoreMapForStep, p.game_player_id), position: p.position, formStatus: p.formStatus }));

      const currentTotal = playersTotal(workingSquad, scoreMapForStep);

      const slotMoves: SlotMove[] = [];
      for (const outPlayer of workingSquad) {
        if (boughtIds.has(outPlayer.game_player_id)) continue;
        const outScore = avgFor(scoreMapForStep, outPlayer.game_player_id);
        const legalCandidates = findLegalReplacementsForOutgoing(
          poolCandidates,
          { gamePlayerId: outPlayer.game_player_id, fullName: outPlayer.full_name, teamId: outPlayer.team_id, teamName: outPlayer.team_name, price: 0, score: outScore, position: outPlayer.position },
          workingSquadIds,
          Number.POSITIVE_INFINITY, // no budget - every candidate is "affordable"
          new Map(),
          null
        );
        let bestCandidate: TransferCandidate | null = null;
        let bestGain = 0;
        for (const match of legalCandidates.slice(0, 20)) {
          const hypotheticalSquad = workingSquad.filter((p) => p.game_player_id !== outPlayer.game_player_id).concat(toWorkingSquadPlayer(match.candidate));
          const gain = playersTotal(hypotheticalSquad, scoreMapForStep) - currentTotal;
          if (gain > bestGain) {
            bestGain = gain;
            bestCandidate = match.candidate;
          }
        }
        if (!bestCandidate) continue;
        slotMoves.push(buildLegInput(outPlayer, bestCandidate, outScore, bestGain));
      }

      let bestIdx = -1;
      for (let i = 0; i < slotMoves.length; i++) {
        if (bestIdx === -1 || slotMoves[i].input.expectedPointsGain > slotMoves[bestIdx].input.expectedPointsGain) bestIdx = i;
      }
      if (bestIdx === -1 || slotMoves[bestIdx].input.expectedPointsGain <= 0) break;

      const scores = scoreMoveCandidates(
        slotMoves.map((m) => m.input),
        activeStrategy
      );
      const chosen = slotMoves[bestIdx];
      const chosenScore = scores[bestIdx];

      let runnerUpIdx = -1;
      for (let i = 0; i < slotMoves.length; i++) {
        if (i === bestIdx) continue;
        const gap = chosen.input.expectedPointsGain - slotMoves[i].input.expectedPointsGain;
        const tolerance = Math.max(0.3, chosen.input.expectedPointsGain * 0.1);
        if (gap <= tolerance && (runnerUpIdx === -1 || slotMoves[i].input.expectedPointsGain > slotMoves[runnerUpIdx].input.expectedPointsGain)) {
          runnerUpIdx = i;
        }
      }

      const leg = toLeg(chosen, chosenScore);
      if (runnerUpIdx !== -1) leg.alternatives = [toLeg(slotMoves[runnerUpIdx], scores[runnerUpIdx])];
      transfers.push(leg);
      applyLeg(chosen);
    }

    return { transfers, workingSquad };
  }

  function describeStep(transfers: BundleTransfer[]): string {
    if (transfers.length === 0) return "Hold - nothing beats what you already have here.";
    const names = transfers.map((t) => `${t.outName} → ${t.inName}`).join(", ");
    return transfers.length === 1 ? `Make this transfer - EFL Fantasy transfers are always free: ${names}.` : `Make these ${transfers.length} transfers - EFL Fantasy transfers are always free: ${names}.`;
  }

  type StepBranch = { step: GameweekPlanStep; workingSquad: WorkingSquadPlayer[]; soldIds: Set<number>; boughtIds: Set<number> };

  function computeStep(offset: number, incomingSquad: WorkingSquadPlayer[], incomingSoldIds: Set<number>, incomingBoughtIds: Set<number>): StepBranch {
    const gameweek = planningGameweek! + offset - 1;
    const scoreMapForStep = stepScoreMaps[offset - 1] ?? new Map();

    const soldIds = new Set(incomingSoldIds);
    const boughtIds = new Set(incomingBoughtIds);
    const result = searchPlayerMoves(incomingSquad, scoreMapForStep, soldIds, boughtIds);
    const resultingSquadExpectedPoints = playersTotal(result.workingSquad, scoreMapForStep);
    const step: GameweekPlanStep = {
      gameweek,
      offset: offset as 1 | 2 | 3,
      transfers: result.transfers,
      hold: result.transfers.length === 0,
      resultingSquadExpectedPoints: Math.round(resultingSquadExpectedPoints * 10) / 10,
      writeup: describeStep(result.transfers),
    };
    return { step, workingSquad: result.workingSquad, soldIds, boughtIds };
  }

  function buildGameweekPlan(): GameweekPlanStep[] {
    if (planningGameweek == null) return [];

    let workingSquad: WorkingSquadPlayer[] = squadPlayers.map((p) => ({ game_player_id: p.game_player_id, full_name: p.full_name, position: p.position, team_id: p.team_id, team_name: p.team_name }));
    let soldIds = new Set<number>();
    let boughtIds = new Set<number>();
    const steps: GameweekPlanStep[] = [];

    for (let offset = 1; offset <= GAMEWEEK_PLAN_LENGTH; offset++) {
      const branch = computeStep(offset, workingSquad, soldIds, boughtIds);
      steps.push(branch.step);
      workingSquad = branch.workingSquad;
      soldIds = branch.soldIds;
      boughtIds = branch.boughtIds;
    }
    return steps;
  }

  const gameweekPlan = buildGameweekPlan();

  /**
   * A club pick is interchangeable with any other club (no position, no
   * budget) - the only legality rule is the real season-long cap-of-5
   * (eflClubCapCheck.ts). Single current-gameweek recommendation, not a
   * 3-step forward plan - deliberately simpler first pass (see this
   * repo's EFL Fantasy build plan), since a club held across gameweeks
   * doesn't accrue anything a per-step plan would need to reason about.
   */
  async function buildClubRecommendation(): Promise<ClubRecommendation | null> {
    if (planningGameweek == null) return null;
    const scoreMap = stepScoreMaps[0] ?? new Map();
    const pickCounts = await getClubPickCounts(supabase, squad.id);

    const transfers: ClubTransferRec[] = [];
    const usedIncoming = new Set<number>();
    for (const outClub of squadClubs) {
      const outScore = avgFor(scoreMap, outClub.game_player_id);
      let best: PoolRow | null = null;
      let bestScore = outScore;
      for (const cand of clubPool) {
        if (squadClubIds.has(cand.game_player_id) || usedIncoming.has(cand.game_player_id)) continue;
        if ((pickCounts.get(cand.game_player_id) ?? 0) >= CLUB_CAP) continue;
        const s = avgFor(scoreMap, cand.game_player_id);
        if (s > bestScore) {
          bestScore = s;
          best = cand;
        }
      }
      if (!best) continue;
      usedIncoming.add(best.game_player_id);
      const gain = bestScore - outScore;
      transfers.push({
        outGamePlayerId: outClub.game_player_id,
        outClubName: outClub.club_name,
        inGamePlayerId: best.game_player_id,
        inClubName: best.full_name,
        pointsGain: Math.round(gain * 10) / 10,
        reasoning: `${best.full_name} is projected +${gain.toFixed(1)} pts over ${outClub.club_name} this gameweek.`,
      });
    }

    return {
      gameweek: planningGameweek,
      transfers,
      hold: transfers.length === 0,
      writeup: transfers.length === 0 ? "Hold - your current 2 clubs are still the best pick available." : transfers.map((t) => `${t.outClubName} → ${t.inClubName}`).join(", "),
    };
  }

  const clubRecommendation = await buildClubRecommendation();

  /**
   * Max Captain (migration 0091): highest-scoring squad player
   * automatically becomes captain, retroactively, for that gameweek -
   * twice/season. Unlike Dream Team's version of this booster
   * (boosterAdvice.ts's evaluateMaxCaptain), EFL Fantasy has no regular
   * captain to hedge against at all (confirmed live - no "Set as
   * captain" UI exists on the real site outside this booster), so this
   * is a genuine expected-value calculation, not a hedge: without the
   * booster, no player's points are ever doubled, so using it on your
   * best-projected starter adds that player's own projected score again.
   * Restricted to the 7 player picks - captaincy over a whole CLUB pick
   * isn't part of the real mechanic.
   */
  function buildMaxCaptainAdvice(): MaxCaptainAdvice | null {
    if (planningGameweek == null) return null;
    const scoreMap = stepScoreMaps[0] ?? new Map();
    const ranked = squadPlayers
      .map((p) => ({ game_player_id: p.game_player_id, full_name: p.full_name, team_name: p.team_name, score: avgFor(scoreMap, p.game_player_id) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0] ?? null;
    const usesRemaining = 2 - [squadRow?.efl_max_captain_used_gameweek_1, squadRow?.efl_max_captain_used_gameweek_2].filter((v) => v != null).length;
    if (!best) return { usesRemaining, best: null, gain: 0, reasoning: "Not enough players to assess Max Captain." };
    const gain = Math.round(best.score * 10) / 10;
    return {
      usesRemaining,
      best,
      gain,
      reasoning: `${best.full_name} projects ${best.score.toFixed(1)} pts this gameweek - using Max Captain would add that again on top if they end up your actual top scorer (only a real gain when triggered, not applied automatically).`,
    };
  }

  const maxCaptainAdvice = buildMaxCaptainAdvice();

  const positionAverages: Record<string, number> = {};
  for (const pos of ["GK", "DEF", "MID", "FWD"]) {
    const vals = playerPool.filter((p) => p.position === pos && p.hail_mary_score != null).map((p) => Number(p.hail_mary_score));
    positionAverages[pos] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  const healthPlayers: SquadHealthPlayer[] = squadPlayers.map((p) => ({
    gamePlayerId: p.game_player_id,
    fullName: p.full_name,
    position: p.position,
    teamName: p.team_name,
    price: 0, // no price system - see the hasPrice=false argument below
    score: poolByGamePlayerId.get(p.game_player_id)?.hail_mary_score != null ? Number(poolByGamePlayerId.get(p.game_player_id)!.hail_mary_score) : null,
    lineup: p.lineup,
    status: p.status,
    isStarting: true, // no bench in this game - every pick always "starts"
  }));
  const health = assessSquadHealth(healthPlayers, positionAverages, null, ratingByTeam, GAMEWEEK_PLAN_LENGTH, false);

  // Mary Performance Lab - archive the actionable parts of this analysis
  // (player transfers/holds, club-pick swaps) as immutable predictions -
  // see cloudffAskMaryEngine.ts for the full reasoning on shape/grouping.
  // Max Captain advice isn't archived: it's advisory only, nothing in the
  // DB tracks whether/when it was actually triggered, so there's nothing
  // honest to grade it against later.
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
      budgetRemainingBefore: null,
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
            outPrice: null,
            inPrice: null,
            transferCost: 0,
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

    if (clubRecommendation) {
      const sharedContext = { ...baseContext, gameweek: clubRecommendation.gameweek, planningHorizon: 1 };
      if (clubRecommendation.hold) {
        predictionRecords.push({
          ...sharedContext,
          kind: "hold",
          recommendationType: "club_pick",
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
          reasons: [{ code: "hold", text: clubRecommendation.writeup }],
          warnings: [],
        });
      } else {
        clubRecommendation.transfers.forEach((t, i) => {
          predictionRecords.push({
            ...sharedContext,
            kind: "transfer",
            recommendationType: "club_pick",
            rank: i + 1,
            outGamePlayerId: t.outGamePlayerId,
            inGamePlayerId: t.inGamePlayerId,
            outPrice: null,
            inPrice: null,
            transferCost: 0,
            captainGamePlayerId: null,
            viceCaptainGamePlayerId: null,
            expectedPointsBefore: null,
            expectedPointsAfter: null,
            expectedGain: t.pointsGain,
            hailMaryScoreDiff: null,
            fixtureSwingDiff: null,
            maryMoveScore: null,
            confidence: null,
            risk: null,
            reasons: [{ code: "club_pick", text: t.reasoning }],
            warnings: [],
          });
        });
      }
    }

    if (predictionRecords.length > 0) {
      await recordPredictionsFn(predictionRecords).catch(() => ({}));
    }
  }

  return {
    squadPlayers,
    squadClubs,
    hasCalendar,
    seasonStarted,
    planningGameweek,
    gameweekPlan,
    clubRecommendation,
    maxCaptainAdvice,
    oneClubUsedGameweek: squadRow?.efl_one_club_used_gameweek ?? null,
    health,
  };
}

export { toPredictionRow };
