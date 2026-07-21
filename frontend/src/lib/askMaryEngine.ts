import type { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { findBuyCandidatesForOutgoing, type TransferCandidate } from "@/lib/transferMatching";
import { type FixtureDifficultyRow } from "@/lib/fixtureRuns";
import { deriveTeamFixtureRatings, type TeamFixtureRating } from "@/lib/fixtureSwing";
import { LINEUP_SECURITY_SCORES, INJURY_AVAILABILITY_SCORES, DEFAULT_SECURITY_SCORE } from "@/lib/playerStatus";
import { transferCost, isWildcardActive, accrueFreeTransfers } from "@/lib/transferEconomy";
import {
  scoreMoveCandidates,
  STRATEGY_WEIGHTS,
  type Strategy,
  type MoveCandidateInput,
  type MoveScore,
  type MoveReason,
} from "@/lib/recommendationScoring";
import { assessSquadHealth, type SquadHealthPlayer, type SquadHealthReport } from "@/lib/squadHealth";
import { toPredictionRow, type PredictionRecord } from "@/lib/predictionArchive";

// This module is server-only (imported only from Server Components,
// server actions, and the background analysis job) - the real
// auth-aware Supabase client type, not a loose structural stand-in.
type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

// Only used for the Captain & Vice-Captain horizon selector now - the
// transfer plan itself is a sequential per-gameweek walk (see
// GAMEWEEK_PLAN_LENGTH below), not one of these fixed windows.
export const CAPTAIN_HORIZONS = [
  { key: "1", label: "Next Gameweek", gameweeks: 1 },
  { key: "3", label: "Next 3 Gameweeks", gameweeks: 3 },
  { key: "5", label: "Next 5 Gameweeks", gameweeks: 5 },
] as const;

export type CaptainHorizon = (typeof CAPTAIN_HORIZONS)[number];

// How many gameweeks ahead the sequential plan looks - GW1/GW2/GW3
// relative to whatever `planningGameweek` currently resolves to, not
// fixed calendar gameweeks (see buildGameweekPlan).
const GAMEWEEK_PLAN_LENGTH = 3;

// A single gameweek step can recommend more than one transfer (e.g. using
// 2 banked free transfers at once) - this is a generous safety bound on
// the search loop, not a real business rule. The real limit is "does the
// next transfer still clear its own cost," which the search's own
// netGain <= 0 stop condition already enforces.
const MAX_TRANSFERS_PER_STEP = 8;

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
  position: string;
  pointsGain: number; // raw projected points over this gameweek, before this leg's cost
  costPoints: number; // 0 or -4 - see lib/transferEconomy.ts
  risk: MoveScore["risk"];
  confidence: number;
  overall: number;
  reasons: MoveReason[];
  warnings: MoveReason[];
  // A near-equally-strong runner-up for this same slot, if one exists -
  // "these two are about as good as each other" rather than silently
  // picking one.
  alternatives?: BundleTransfer[];
};

/**
 * What Mary recommends for one specific upcoming gameweek - zero to
 * MAX_TRANSFERS_PER_STEP transfers, always jointly legal (each leg
 * validated against the cumulative state left by the legs before it, via
 * the same findBuyCandidatesForOutgoing budget/position/club-limit filter
 * every other transfer surface in this app already uses), so an illegal
 * recommendation can never be produced. Steps are sequential - GW2's
 * working squad/budget/free-transfer count is whatever GW1's step left
 * behind, not independently recomputed from today's actual squad.
 */
export type GameweekPlanStep = {
  gameweek: number;
  offset: 1 | 2 | 3;
  transfers: BundleTransfer[];
  hold: boolean; // true when transfers.length === 0
  freeTransfersAvailable: number | "unlimited"; // available going into this step, after this gameweek's grant lands
  freeTransfersAfter: number | "unlimited"; // left over after this step's transfers, carried into the next step
  budgetRemainingAfter: number;
  resultingSquadExpectedPoints: number; // whole squad's projected points for this specific gameweek, after this step
  writeup: string; // plain-English summary of what this step recommends and why
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
  form: number | null;
};

type SquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  game_players: {
    price: number;
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD"; team_id: number; teams: { name: string } };
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

type CaptaincyPick = { game_player_id: number; full_name: string; team_name: string; score: number; lineup: string | null };

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
  captainHorizonGameweeks: number;
  bestCaptain: CaptaincyPick | null;
  viceCaptain: CaptaincyPick | null;
  health: SquadHealthReport;
  monitorList: {
    gamePlayerId: number;
    fullName: string;
    teamName: string;
    position: string;
    price: number;
    hailMaryScore: number | null;
    startsInGameweek: number | null;
  }[];
};

/**
 * The whole Ask Mary pipeline for one squad: fetches its players/pool/
 * fixtures, builds a sequential gameweek-by-gameweek transfer plan (see
 * buildGameweekPlan) - each step jointly budget/position/club-limit legal
 * by construction, never just individually legal - plus a single
 * horizon-aware Captain & Vice-Captain pick, squad health, and
 * players-to-monitor, then archives all of it as immutable predictions
 * (Mary Performance Lab). Used by both the Ask Mary page itself and the
 * background refresh that keeps every squad's predictions current
 * (performance-lab/page.tsx) - one engine, not two copies.
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
  fanteamGame: { id: number; display_name: string },
  activeStrategy: Strategy,
  captainHorizonGameweeks: number,
  recordPredictionsFn?: (records: PredictionRecord[]) => Promise<{ error?: string } | { recorded: number }>
): Promise<AskMaryAnalysis | null> {
  const { data: rulesRow } = await supabase
    .from("game_squad_rules")
    .select("budget, max_per_club, squad_size, starting_size")
    .eq("game_id", fanteamGame.id)
    .single();
  if (!rulesRow) return null;
  // Reassigned to a plain non-null const - TypeScript's control-flow
  // narrowing from the guard above doesn't carry into nested function
  // declarations below.
  const rules = rulesRow;

  const { data: squadPlayersRaw } = await supabase
    .from("squad_players")
    .select("game_player_id, is_starting, game_players(price, players(full_name, position, team_id, teams(name)))")
    .eq("squad_id", squad.id)
    .returns<SquadPlayerRow[]>();

  const { data: pool } = await supabase.from("game_player_pool").select("*").eq("game_slug", "fanteam").returns<PoolRow[]>();
  const poolByGamePlayerId = new Map((pool ?? []).map((p) => [p.game_player_id, p]));

  const squadPlayers = (squadPlayersRaw ?? []).map((sp) => {
    const poolRow = poolByGamePlayerId.get(sp.game_player_id);
    return {
      game_player_id: sp.game_player_id,
      full_name: sp.game_players.players.full_name,
      position: sp.game_players.players.position,
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
  const squadTeamsSet = new Set(squadPlayers.map((p) => p.team_name));

  const { data: gwRow } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures!inner(kickoff_at)")
    .eq("game_id", fanteamGame.id)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek", { ascending: true })
    .limit(1)
    .maybeSingle();
  const currentGameweek: number | null = gwRow?.gameweek ?? null;
  const hasCalendar = currentGameweek !== null;
  const { seasonStarted, planningGameweek } = await getSeasonTiming(supabase, fanteamGame.id);

  const freeTransfersBanked = seasonStarted ? squad.free_transfers : Infinity;

  // Fetches one specific gameweek's 1-GW score map - player_score_by_horizon_from
  // is purely parameterized on (start gameweek, window length), no
  // season-started gating, so this works identically pre-season and
  // in-season. Falls back to an empty map (avgFor then uses the flat
  // hail_mary_score) when no calendar is published yet.
  async function getStepScoreMap(gameweek: number): Promise<Map<number, number>> {
    if (!hasCalendar) return new Map();
    const { data } = await supabase.rpc("player_score_by_horizon_from", {
      p_game_slug: "fanteam",
      p_start_gameweek: gameweek,
      p_num_gameweeks: 1,
    });
    return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
  }

  // Captain uses its own selectable horizon window, independent of the
  // gameweek-by-gameweek transfer plan.
  async function getHorizonMap(gameweeks: number): Promise<Map<number, number>> {
    if (hasCalendar && !seasonStarted) {
      const { data } = await supabase.rpc("player_score_by_horizon", { p_game_slug: "fanteam", p_num_gameweeks: gameweeks });
      return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
    }
    if (hasCalendar && seasonStarted && planningGameweek !== null) {
      const { data } = await supabase.rpc("player_score_by_horizon_from", {
        p_game_slug: "fanteam",
        p_start_gameweek: planningGameweek,
        p_num_gameweeks: gameweeks,
      });
      return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
    }
    return new Map();
  }

  const stepGameweeks = planningGameweek != null ? [0, 1, 2].map((offset) => planningGameweek + offset) : [];
  const [stepScoreMaps, captainScoreMap] = await Promise.all([
    Promise.all(stepGameweeks.map((gw) => getStepScoreMap(gw))),
    getHorizonMap(captainHorizonGameweeks),
  ]);

  function avgFor(map: Map<number, number>, gamePlayerId: number): number {
    if (map.size > 0) return map.get(gamePlayerId) ?? 0;
    const hms = poolByGamePlayerId.get(gamePlayerId)?.hail_mary_score;
    return hms != null ? Number(hms) : 0;
  }

  const { data: fixturesRaw } = await supabase
    .from("game_fixture_gameweeks")
    .select(
      "gameweek, fixtures(id, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))"
    )
    .eq("game_id", fanteamGame.id)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek");
  const { data: difficultyRaw } = await supabase
    .from("team_fixture_difficulty")
    .select("fixture_id, team_id, attack_score, clean_sheet_score")
    .eq("game_id", fanteamGame.id)
    .returns<{ fixture_id: number; team_id: number; attack_score: number; clean_sheet_score: number }[]>();
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
      fixtureRows.push({
        teamName,
        gameweek: row.gameweek,
        attackScore: diff ? Number(diff.attack_score) : null,
        cleanSheetScore: diff ? Number(diff.clean_sheet_score) : null,
      });
    }
  }
  const ratings = deriveTeamFixtureRatings(fixtureRows);
  const ratingByTeam = new Map(ratings.map((r) => [r.teamName, r]));

  type SearchState = {
    workingSquad: WorkingSquadPlayer[];
    workingSquadIds: Set<number>;
    workingBudget: number;
    workingClubCounts: Map<number, number>;
    freeRemaining: number;
  };

  /**
   * Greedy incremental search for one gameweek step: find the single best
   * legal transfer against the CURRENT working squad state, apply it
   * hypothetically, re-search from the new state for a possible next
   * transfer, and stop once nothing left clears its own points cost (or
   * MAX_TRANSFERS_PER_STEP is reached - a safety bound, not a real limit,
   * since the cost-clearing check already does the real work). "Best" for
   * picking which slot to fill is the raw projected points gain over this
   * gameweek, not the normalized 0-100 Mary Move Score - that score is
   * min-max normalized within whichever candidate set produced it, so
   * scores from two different search steps (different candidate pools)
   * aren't on a comparable scale. scoreMoveCandidates is still called each
   * step purely to surface a real score/confidence/risk/reasons for
   * whichever move gets chosen (and its runner-up, if kept as an
   * alternative), for display - it never decides which move to take.
   */
  function searchBestMoves(
    state: SearchState,
    scoreMapForStep: Map<number, number>,
    wildcardActive: boolean,
    soldIds: Set<number>,
    boughtIds: Set<number>
  ): { transfers: BundleTransfer[] } & SearchState {
    let { workingSquad, workingSquadIds, workingBudget, workingClubCounts, freeRemaining } = state;
    const transfers: BundleTransfer[] = [];

    for (let slot = 0; slot < MAX_TRANSFERS_PER_STEP; slot++) {
      const poolCandidates: TransferCandidate[] = (pool ?? [])
        .filter((p) => !soldIds.has(p.game_player_id)) // can't buy back a player already sold this plan
        .map((p) => ({
          gamePlayerId: p.game_player_id,
          fullName: p.full_name,
          teamId: p.team_id,
          teamName: p.team_name,
          price: Number(p.price),
          score: avgFor(scoreMapForStep, p.game_player_id),
          position: p.position,
        }));

      type SlotMove = { input: MoveCandidateInput; outPlayer: WorkingSquadPlayer; inCandidate: TransferCandidate };
      const slotMoves: SlotMove[] = [];
      for (const outPlayer of workingSquad) {
        if (boughtIds.has(outPlayer.game_player_id)) continue;
        const outScore = avgFor(scoreMapForStep, outPlayer.game_player_id);
        const matches = findBuyCandidatesForOutgoing(
          poolCandidates,
          {
            gamePlayerId: outPlayer.game_player_id,
            fullName: outPlayer.full_name,
            teamId: outPlayer.team_id,
            teamName: outPlayer.team_name,
            price: outPlayer.price,
            score: outScore,
            position: outPlayer.position,
          },
          workingSquadIds,
          workingBudget,
          workingClubCounts,
          rules.max_per_club
        );
        const best = matches[0];
        if (!best) continue;
        const inCand = best.candidate;
        const inPoolRow = poolByGamePlayerId.get(inCand.gamePlayerId);
        const outPoolRow = poolByGamePlayerId.get(outPlayer.game_player_id);
        const outTeamRating = ratingByTeam.get(outPlayer.team_name);
        const inTeamRating = ratingByTeam.get(inCand.teamName);
        slotMoves.push({
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
            expectedPointsGain: best.delta,
            hailMaryScoreDiff:
              (inPoolRow?.hail_mary_score != null ? Number(inPoolRow.hail_mary_score) : 0) -
              (outPoolRow?.hail_mary_score != null ? Number(outPoolRow.hail_mary_score) : 0),
            fixtureSwingDiff: (inTeamRating?.swingValue ?? 0) - (outTeamRating?.swingValue ?? 0),
            priceDelta: inCand.price - outPlayer.price,
            incomingMinutesSecurity: LINEUP_SECURITY_SCORES[inPoolRow?.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE,
            outgoingMinutesSecurity: LINEUP_SECURITY_SCORES[poolByGamePlayerId.get(outPlayer.game_player_id)?.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE,
            incomingInjuryAvailability: INJURY_AVAILABILITY_SCORES[inPoolRow?.status ?? ""] ?? DEFAULT_SECURITY_SCORE,
            incomingForm: inPoolRow?.form != null ? Number(inPoolRow.form) : null,
            outgoingForm: poolByGamePlayerId.get(outPlayer.game_player_id)?.form != null ? Number(poolByGamePlayerId.get(outPlayer.game_player_id)!.form) : null,
            incomingIsConfirmedStarter: inPoolRow?.lineup === "confirmed_starting",
            hasFixtureData: !!outTeamRating && !!inTeamRating,
            hasStatusData: inPoolRow?.lineup != null && outPoolRow?.lineup != null,
          },
        });
      }

      if (slotMoves.length === 0) break; // no legal move available at all - stop the search here

      const scores = scoreMoveCandidates(
        slotMoves.map((m) => m.input),
        activeStrategy
      );

      let pickIdx = 0;
      for (let i = 1; i < slotMoves.length; i++) {
        if (slotMoves[i].input.expectedPointsGain > slotMoves[pickIdx].input.expectedPointsGain) pickIdx = i;
      }
      const chosen = slotMoves[pickIdx];
      const chosenScore = scores[pickIdx];

      const cost = transferCost(freeRemaining, wildcardActive);
      const netGain = chosen.input.expectedPointsGain + cost;
      if (netGain <= 0) break; // doesn't clear its own cost - not worth recommending

      // A runner-up within ~10% of the chosen move's raw gain (or within
      // a small absolute band for near-zero gains) is a real toss-up -
      // surface it instead of silently discarding it.
      let runnerUpIdx = -1;
      for (let i = 0; i < slotMoves.length; i++) {
        if (i === pickIdx) continue;
        const gap = chosen.input.expectedPointsGain - slotMoves[i].input.expectedPointsGain;
        const tolerance = Math.max(0.3, chosen.input.expectedPointsGain * 0.1);
        if (gap <= tolerance && (runnerUpIdx === -1 || slotMoves[i].input.expectedPointsGain > slotMoves[runnerUpIdx].input.expectedPointsGain)) {
          runnerUpIdx = i;
        }
      }

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
          position: move.input.position,
          pointsGain: Math.round(move.input.expectedPointsGain * 10) / 10,
          costPoints: cost,
          risk: score.risk,
          confidence: score.confidence,
          overall: score.overall,
          reasons: score.reasons,
          warnings: score.warnings,
        };
      }

      const leg = toLeg(chosen, chosenScore);
      if (runnerUpIdx !== -1) {
        leg.alternatives = [toLeg(slotMoves[runnerUpIdx], scores[runnerUpIdx])];
      }
      transfers.push(leg);

      // Apply the accepted move to the working state before searching
      // for a possible next slot.
      workingBudget -= chosen.input.priceDelta;
      workingClubCounts.set(chosen.inCandidate.teamId, (workingClubCounts.get(chosen.inCandidate.teamId) ?? 0) + 1);
      workingClubCounts.set(chosen.outPlayer.team_id, (workingClubCounts.get(chosen.outPlayer.team_id) ?? 0) - 1);
      workingSquad = workingSquad
        .filter((p) => p.game_player_id !== chosen.outPlayer.game_player_id)
        .concat({
          game_player_id: chosen.inCandidate.gamePlayerId,
          full_name: chosen.inCandidate.fullName,
          position: chosen.inCandidate.position,
          team_id: chosen.inCandidate.teamId,
          team_name: chosen.inCandidate.teamName,
          price: chosen.inCandidate.price,
        });
      workingSquadIds = new Set(workingSquad.map((p) => p.game_player_id));
      soldIds.add(chosen.outPlayer.game_player_id);
      boughtIds.add(chosen.inCandidate.gamePlayerId);
      if (cost === 0 && !wildcardActive) freeRemaining -= 1; // consumed one banked free transfer
    }

    return { transfers, workingSquad, workingSquadIds, workingBudget, workingClubCounts, freeRemaining };
  }

  function describeStep(step: {
    seasonStarted: boolean;
    transfers: BundleTransfer[];
    gameweek: number;
    freeAfter: number | "unlimited";
  }): string {
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
      return transfers.length === 1
        ? `Make this transfer using a free transfer: ${names}.`
        : `Use ${transfers.length} free transfers this gameweek: ${names}.`;
    }
    return `Make ${transfers.length} transfer${transfers.length > 1 ? "s" : ""} (${hitCount} at -4 each, still worth it): ${names}.`;
  }

  /**
   * The sequential plan: GAMEWEEK_PLAN_LENGTH steps starting at
   * planningGameweek, each threading the previous step's resulting squad/
   * budget/free-transfer count forward - GW2 can't sell back what GW1 just
   * bought, and a held GW1 genuinely banks a transfer for GW2. Once GW1
   * actually kicks off and finishes, planningGameweek naturally advances
   * (see lib/gameweek.ts) and this same plan shows GW2/GW3/GW4 - no
   * separate rollover logic needed.
   */
  function buildGameweekPlan(): GameweekPlanStep[] {
    if (planningGameweek == null) return [];

    let state: SearchState = {
      workingSquad: squadPlayers.map((p) => ({
        game_player_id: p.game_player_id,
        full_name: p.full_name,
        position: p.position,
        team_id: p.team_id,
        team_name: p.team_name,
        price: p.price,
      })),
      workingSquadIds: new Set(squadPlayers.map((p) => p.game_player_id)),
      workingBudget: budgetRemaining,
      workingClubCounts: new Map(clubCounts),
      freeRemaining: freeTransfersBanked,
    };
    const soldIds = new Set<number>();
    const boughtIds = new Set<number>();

    const steps: GameweekPlanStep[] = [];
    for (let offset = 1; offset <= GAMEWEEK_PLAN_LENGTH; offset++) {
      const gameweek = planningGameweek + offset - 1;

      // Unlimited transfers only apply up to GW1's actual kickoff - not
      // to this whole 3-step plan just because the plan happened to be
      // computed pre-season. `seasonStarted` is a snapshot for "right
      // now", so it's only correct for offset 1 (this plan's first step,
      // which really is GW1 when !seasonStarted - getSeasonTiming always
      // resolves planningGameweek to GW1 itself before kickoff). Every
      // later step is a gameweek that will have already kicked off by
      // the time it's played, even though the analysis runs before any
      // of them have - so it must use real free-transfer economics, not
      // inherit "unlimited" from the pre-season snapshot.
      const isPreSeasonStep = !seasonStarted && offset === 1;

      if (offset > 1) {
        if (!seasonStarted && offset === 2) {
          // The season's first real gameweek - no carryover from "unlimited"
          // pre-season since that was never a real banked count. Starts
          // fresh at exactly the 1 free transfer FanTeam grants every
          // gameweek.
          state = { ...state, freeRemaining: 1 };
        } else {
          // Covers: analysis run mid-season (every step accrues normally),
          // and offset 3 following a pre-season-triggered reset at offset 2.
          state = { ...state, freeRemaining: accrueFreeTransfers(state.freeRemaining) };
        }
      }
      const freeBefore = state.freeRemaining;
      const wildcardActiveHere = isWildcardActive(gameweek, squad.wildcard_1_used_gameweek ?? null, squad.wildcard_2_used_gameweek ?? null);
      const scoreMapForStep = stepScoreMaps[offset - 1] ?? new Map();

      const result = searchBestMoves(state, scoreMapForStep, wildcardActiveHere, soldIds, boughtIds);
      state = { workingSquad: result.workingSquad, workingSquadIds: result.workingSquadIds, workingBudget: result.workingBudget, workingClubCounts: result.workingClubCounts, freeRemaining: result.freeRemaining };

      const resultingSquadExpectedPoints = state.workingSquad.reduce((sum, p) => sum + avgFor(scoreMapForStep, p.game_player_id), 0);

      // "freeAfter" for both the write-up and the returned field is a
      // PREVIEW of what the *next* gameweek brings - not just this step's
      // raw leftover. A hold at 1 banked plus the next gameweek's own +1
      // grant means "2 available before GW+1", which is what the
      // "bank your transfer" sentence needs to say. Only offset 1 can be
      // the pre-season step, and its next step (offset 2) always resets to
      // 1 regardless of what GW1 did (see the reset above) - every other
      // case previews via normal accrual. A preview, not a mutation - the
      // loop's own top-of-iteration logic next time round recomputes the
      // identical value from the same input.
      const freeAfterPreview = isPreSeasonStep ? 1 : accrueFreeTransfers(state.freeRemaining);
      const writeup = describeStep({ seasonStarted: !isPreSeasonStep, transfers: result.transfers, gameweek, freeAfter: freeAfterPreview });

      steps.push({
        gameweek,
        offset: offset as 1 | 2 | 3,
        transfers: result.transfers,
        hold: result.transfers.length === 0,
        freeTransfersAvailable: isPreSeasonStep ? "unlimited" : freeBefore,
        freeTransfersAfter: freeAfterPreview,
        budgetRemainingAfter: state.workingBudget,
        resultingSquadExpectedPoints: Math.round(resultingSquadExpectedPoints * 10) / 10,
        writeup,
      });
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
  // Squad health uses the 5-GW horizon window for fixture-swing awareness
  // - same default the page itself defaults to.
  const health = assessSquadHealth(healthPlayers, positionAverages, rules.max_per_club, ratingByTeam, 5);

  // Captain & Vice-Captain, ranked at the selected planning horizon.
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
    }))
    .sort((a, b) => b.score - a.score);
  const bestCaptain = captaincyPool[0] ?? null;
  const viceCaptain = captaincyPool[1] ?? null;

  // Players to Monitor uses a 5-GW window, independent of the gameweek
  // plan's own step-by-step scoring.
  const planningHorizonForNarrative = 5;
  const monitorList =
    planningGameweek != null
      ? ratings
          .filter(
            (r) =>
              r.swingDirection === "improving" &&
              r.startsInGameweek != null &&
              r.startsInGameweek >= planningGameweek &&
              r.startsInGameweek < planningGameweek + planningHorizonForNarrative &&
              !squadTeamsSet.has(r.teamName)
          )
          .map((r) => {
            const teamPlayers = (pool ?? [])
              .filter((p) => p.team_name === r.teamName && !squadIds.has(p.game_player_id) && p.hail_mary_score != null)
              .sort((a, b) => Number(b.hail_mary_score) - Number(a.hail_mary_score));
            const top = teamPlayers[0];
            if (!top) return null;
            return {
              gamePlayerId: top.game_player_id,
              fullName: top.full_name,
              teamName: r.teamName,
              position: top.position,
              price: Number(top.price),
              hailMaryScore: top.hail_mary_score != null ? Number(top.hail_mary_score) : null,
              startsInGameweek: r.startsInGameweek,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x != null)
          .slice(0, 6)
      : [];

  // Mary Performance Lab - archive this analysis as a batch of immutable
  // predictions: one row per transfer leg (all legs of one step share
  // recommendation_type "gw_plan" and kind "transfer", with `rank` giving
  // their order within the step, `planning_horizon` giving the step's
  // offset 1/2/3, and `gameweek` giving that step's actual gameweek - see
  // performance-lab/page.tsx for how these get grouped back into one step
  // on read), a "hold" row for any step with nothing to recommend, and one
  // "best_captain" row at the selected captain horizon. recordPredictionsFn
  // is injected rather than imported directly - both the Ask Mary page and
  // the Performance Lab refresh loop call the DB the same way but need
  // their own "use server" action for the client-triggered path.
  if (planningGameweek != null && recordPredictionsFn) {
    const { data: latestProjection } = await supabase
      .from("projections")
      .select("algorithm_version_id, season")
      .eq("game_player_id", squadPlayers[0].game_player_id)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    const baseContext = {
      squadId: squad.id,
      gameId: fanteamGame.id,
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
    captainHorizonGameweeks,
    bestCaptain,
    viceCaptain,
    health,
    monitorList,
  };
}

export { toPredictionRow };
