import type { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { findBuyCandidatesForOutgoing, type TransferCandidate } from "@/lib/transferMatching";
import { type FixtureDifficultyRow } from "@/lib/fixtureRuns";
import { deriveTeamFixtureRatings, type TeamFixtureRating } from "@/lib/fixtureSwing";
import { LINEUP_SECURITY_SCORES, INJURY_AVAILABILITY_SCORES, DEFAULT_SECURITY_SCORE } from "@/lib/playerStatus";
import { transferCost, isWildcardActive } from "@/lib/transferEconomy";
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

export const ASK_MARY_HORIZONS = [
  { key: "1", label: "Next Gameweek", gameweeks: 1 },
  { key: "3", label: "Next 3 Gameweeks", gameweeks: 3 },
  { key: "5", label: "Next 5 Gameweeks", gameweeks: 5 },
] as const;

export type AskMaryHorizon = (typeof ASK_MARY_HORIZONS)[number];

// A bundle can hold up to this many simultaneous transfers - keeps a
// recommendation explainable ("Transfer 1 -> Transfer 2 -> Resulting
// squad") rather than an open-ended churn list.
const MAX_BUNDLE_SIZE = 3;

/** One leg of a transfer bundle - a single sell/buy pair, in the order Mary would make them. */
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
  pointsGain: number; // raw projected points over the horizon, before this slot's cost
  costPoints: number; // 0 or -4 - see lib/transferEconomy.ts
  risk: MoveScore["risk"];
  confidence: number;
  overall: number;
  reasons: MoveReason[];
  warnings: MoveReason[];
};

/**
 * "Best Transfer" for one planning horizon - zero to MAX_BUNDLE_SIZE
 * transfers, always jointly legal (each leg validated against the
 * cumulative state left by the legs before it, via the same
 * findBuyCandidatesForOutgoing budget/position/club-limit filter every
 * other transfer surface in this app already uses), so an illegal
 * recommendation can never be produced in the first place.
 */
export type AskMaryBundle = {
  horizonGameweeks: number;
  transfers: BundleTransfer[];
  hold: boolean; // true when transfers.length === 0 - no move clears its own points cost
  budgetRemainingAfter: number;
  resultingSquadExpectedPoints: number; // whole squad's projected points over this horizon, after the bundle
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
  bundles: Map<number, AskMaryBundle>; // keyed by horizon gameweeks: 1, 3, 5
  captainHorizonGameweeks: number;
  bestCaptain: CaptaincyPick | null;
  viceCaptain: CaptaincyPick | null;
  health: SquadHealthReport;
  roadmap: { label: string; text: string }[];
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
 * fixtures, builds a "Best Transfer" bundle for each of the three
 * planning horizons (1/3/5 GW) - each jointly budget/position/club-limit
 * legal by construction, never just individually legal - plus a single
 * horizon-aware Captain & Vice-Captain pick, squad health, the gameweek
 * roadmap, and players-to-monitor, then archives all of it as immutable
 * predictions (Mary Performance Lab). Used by both the Ask Mary page
 * itself and the background refresh that keeps every squad's predictions
 * current (performance-lab/page.tsx) - one engine, not two copies.
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

  // Whether the next transfer this gameweek would be free - drives the
  // bundle search's points-vs-cost gating below. Only meaningful once the
  // season has actually started; pre-season transfers are free/unlimited
  // (see squads/actions.ts's executeTransfer for the enforcement side).
  const wildcardActive =
    planningGameweek != null
      ? isWildcardActive(planningGameweek, squad.wildcard_1_used_gameweek ?? null, squad.wildcard_2_used_gameweek ?? null)
      : false;
  const freeTransfersBanked = seasonStarted ? squad.free_transfers : Infinity;

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

  const [score1Map, score3Map, score5Map] = await Promise.all([getHorizonMap(1), getHorizonMap(3), getHorizonMap(5)]);
  const scoreMapByGameweeks = new Map([
    [1, score1Map],
    [3, score3Map],
    [5, score5Map],
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

  /**
   * Greedy incremental bundle search for one horizon: find the single
   * best legal transfer against the CURRENT working squad state, apply
   * it hypothetically, re-search from the new state for a possible next
   * transfer, and stop once nothing left clears its own points cost (or
   * MAX_BUNDLE_SIZE is reached). "Best" for picking which slot to fill is
   * the raw projected points gain over the horizon, not the normalized
   * 0-100 Mary Move Score - that score is min-max normalized within
   * whichever candidate set produced it, so scores from two different
   * search steps (different candidate pools) aren't on a comparable
   * scale. scoreMoveCandidates is still called each step purely to
   * surface a real score/confidence/risk/reasons for whichever move gets
   * chosen, for display - it never decides which move to take.
   */
  function buildBundleForHorizon(gameweeks: number, scoreMapForHorizon: Map<number, number>): AskMaryBundle {
    let workingSquad: WorkingSquadPlayer[] = squadPlayers.map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      position: p.position,
      team_id: p.team_id,
      team_name: p.team_name,
      price: p.price,
    }));
    let workingSquadIds = new Set(workingSquad.map((p) => p.game_player_id));
    let workingBudget = budgetRemaining;
    const workingClubCounts = new Map(clubCounts);
    const soldIds = new Set<number>();
    let freeRemaining = freeTransfersBanked;

    const transfers: BundleTransfer[] = [];

    for (let slot = 0; slot < MAX_BUNDLE_SIZE; slot++) {
      const poolCandidates: TransferCandidate[] = (pool ?? [])
        .filter((p) => !soldIds.has(p.game_player_id)) // can't buy back a player this bundle already sold
        .map((p) => ({
          gamePlayerId: p.game_player_id,
          fullName: p.full_name,
          teamId: p.team_id,
          teamName: p.team_name,
          price: Number(p.price),
          score: avgFor(scoreMapForHorizon, p.game_player_id),
          position: p.position,
        }));

      type SlotMove = { input: MoveCandidateInput; outPlayer: WorkingSquadPlayer; inCandidate: TransferCandidate };
      const slotMoves: SlotMove[] = [];
      for (const outPlayer of workingSquad) {
        const outScoreH = avgFor(scoreMapForHorizon, outPlayer.game_player_id);
        const matches = findBuyCandidatesForOutgoing(
          poolCandidates,
          {
            gamePlayerId: outPlayer.game_player_id,
            fullName: outPlayer.full_name,
            teamId: outPlayer.team_id,
            teamName: outPlayer.team_name,
            price: outPlayer.price,
            score: outScoreH,
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
            expectedPointsGain: best.delta * gameweeks,
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

      if (slotMoves.length === 0) break; // no legal move available at all - stop the bundle here

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

      transfers.push({
        outGamePlayerId: chosen.input.outGamePlayerId,
        outName: chosen.input.outName,
        outTeam: chosen.input.outTeam,
        outPrice: chosen.outPlayer.price,
        inGamePlayerId: chosen.input.inGamePlayerId,
        inName: chosen.input.inName,
        inTeam: chosen.input.inTeam,
        inPrice: chosen.inCandidate.price,
        position: chosen.input.position,
        pointsGain: Math.round(chosen.input.expectedPointsGain * 10) / 10,
        costPoints: cost,
        risk: chosenScore.risk,
        confidence: chosenScore.confidence,
        overall: chosenScore.overall,
        reasons: chosenScore.reasons,
        warnings: chosenScore.warnings,
      });

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
      if (cost === 0 && !wildcardActive) freeRemaining -= 1; // consumed one banked free transfer
    }

    const resultingSquadExpectedPoints = workingSquad.reduce((sum, p) => sum + avgFor(scoreMapForHorizon, p.game_player_id) * gameweeks, 0);

    return {
      horizonGameweeks: gameweeks,
      transfers,
      hold: transfers.length === 0,
      budgetRemainingAfter: workingBudget,
      resultingSquadExpectedPoints: Math.round(resultingSquadExpectedPoints * 10) / 10,
    };
  }

  const bundles = new Map<number, AskMaryBundle>(
    ASK_MARY_HORIZONS.map((h) => [h.gameweeks, buildBundleForHorizon(h.gameweeks, scoreMapByGameweeks.get(h.gameweeks) ?? new Map())])
  );

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

  // Captain & Vice-Captain, ranked at the selected planning horizon (the
  // same per-horizon scoreMap the transfer bundles use) rather than a
  // flat single-gameweek Hail Mary Score - "using the same horizon as the
  // selected analysis" per the simplified 4-recommendation design.
  const captainScoreMap = scoreMapByGameweeks.get(captainHorizonGameweeks) ?? new Map();
  const captaincyPool: CaptaincyPick[] = squadPlayers
    .filter((p) => p.is_starting)
    .map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      team_name: p.team_name,
      lineup: p.lineup,
      score: avgFor(captainScoreMap, p.game_player_id),
    }))
    .sort((a, b) => b.score - a.score);
  const bestCaptain = captaincyPool[0] ?? null;
  const viceCaptain = captaincyPool[1] ?? null;

  // Gameweek Plan + Players to Monitor use a 5-GW window, matching the
  // page's own default so the archived-vs-displayed content lines up.
  const planningHorizonForNarrative = 5;
  const roadmap: { label: string; text: string }[] = [];
  if (planningGameweek != null) {
    const bundle5 = bundles.get(5)!;
    const top = bundle5.transfers[0] ?? null;
    roadmap.push({
      label: `This Gameweek (GW${planningGameweek})`,
      text: !bundle5.hold && top ? `Sell ${top.outName} and buy ${top.inName}.` : "Hold - no transfer creates a meaningful improvement right now.",
    });
    for (let offset = 1; offset < planningHorizonForNarrative; offset++) {
      const gw = planningGameweek + offset;
      const decliningHere = Array.from(squadTeamsSet)
        .map((t) => ratingByTeam.get(t))
        .filter((r): r is TeamFixtureRating => !!r && r.swingDirection === "declining" && r.startsInGameweek === gw);
      const improvingHere = ratings.filter((r) => r.swingDirection === "improving" && r.startsInGameweek === gw && !squadTeamsSet.has(r.teamName));
      if (decliningHere.length > 0) {
        roadmap.push({ label: `Gameweek ${gw}`, text: `Review ${decliningHere.map((r) => r.teamName).join(", ")} assets before their difficult fixture run.` });
      } else if (improvingHere.length > 0) {
        roadmap.push({ label: `Gameweek ${gw}`, text: `${improvingHere.map((r) => r.teamName).join(", ")}'s favourable fixture swing begins - worth monitoring.` });
      } else {
        roadmap.push({ label: `Gameweek ${gw}`, text: "Hold unless a squad player's status changes." });
      }
    }
  }

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
  // predictions: one row per transfer leg (all legs of one horizon's
  // bundle share recommendation_type "best_transfer_gwN" and kind
  // "transfer", with `rank` giving their order within the bundle - see
  // performance-lab/page.tsx for how these get grouped back into one
  // bundle on read), a "hold" row for any horizon with nothing to
  // recommend, and one "best_captain" row at the selected horizon.
  // recordPredictionsFn is injected rather than imported directly - both
  // the Ask Mary page and the Performance Lab refresh loop call the DB
  // the same way but need their own "use server" action for the
  // client-triggered path.
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
      gameweek: planningGameweek,
      season: latestProjection?.season ?? "unknown",
      algorithmVersionId: latestProjection?.algorithm_version_id ?? null,
      recommendationWeights: STRATEGY_WEIGHTS[activeStrategy],
      strategy: activeStrategy,
      transferLimit: null,
      budgetRemainingBefore: budgetRemaining,
      freeTransfersBefore: squad.free_transfers,
    };

    const predictionRecords: PredictionRecord[] = [];

    for (const h of ASK_MARY_HORIZONS) {
      const bundle = bundles.get(h.gameweeks)!;
      const sharedContext = { ...baseContext, planningHorizon: h.gameweeks };

      if (bundle.hold) {
        predictionRecords.push({
          ...sharedContext,
          kind: "hold",
          recommendationType: "hold",
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
          reasons: [{ code: "hold", text: "No available transfer clears its own cost right now." }],
          warnings: [],
        });
      } else {
        bundle.transfers.forEach((t, i) => {
          predictionRecords.push({
            ...sharedContext,
            kind: "transfer",
            recommendationType: `best_transfer_gw${h.gameweeks}`,
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
    bundles,
    captainHorizonGameweeks,
    bestCaptain,
    viceCaptain,
    health,
    roadmap,
    monitorList,
  };
}

export { toPredictionRow };
