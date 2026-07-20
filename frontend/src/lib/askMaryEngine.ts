import type { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { findBuyCandidatesForOutgoing, type TransferCandidate } from "@/lib/transferMatching";
import { type FixtureDifficultyRow } from "@/lib/fixtureRuns";
import { deriveTeamFixtureRatings, type TeamFixtureRating } from "@/lib/fixtureSwing";
import { LINEUP_SECURITY_SCORES, INJURY_AVAILABILITY_SCORES, DEFAULT_SECURITY_SCORE } from "@/lib/playerStatus";
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

// Below this Mary Move Score, a transfer isn't worth recommending - Ask
// Mary should say so rather than force a marginal move for its own sake.
const HOLD_SCORE_THRESHOLD = 55;

export type AskMaryRecommendation = {
  rank: number;
  label?: string;
  squadId: number;
  gameId: number;
  outGamePlayerId: number;
  outName: string;
  outTeam: string;
  outPrice: number;
  inGamePlayerId: number;
  inName: string;
  inTeam: string;
  inPrice: number;
  position: string;
  transferCost: number;
  moneyRemainingAfter: number;
  expectedPointsBefore: number;
  expectedPointsAfter: number;
  gain1: number | null;
  gain3: number | null;
  gain5: number | null;
  hailMaryScoreDiff: number;
  fixtureSwingDiff: number;
  risk: MoveScore["risk"];
  confidence: number;
  overall: number;
  reasons: MoveReason[];
  warnings: MoveReason[];
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

type Move = { input: MoveCandidateInput; gain1: number | null; gain3: number | null; gain5: number | null; outPrice: number; inPrice: number };

export type HorizonResult = {
  moves: Move[];
  hold: boolean;
  bestOverallScore: number;
  rankedMoves: AskMaryRecommendation[];
  categoryCards: AskMaryRecommendation[];
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
  horizonResults: Map<number, HorizonResult>;
  health: SquadHealthReport;
  bestCaptain: CaptaincyPick | null;
  viceCaptain: CaptaincyPick | null;
  safestCaptain: CaptaincyPick | null;
  differentialCaptain: CaptaincyPick | null;
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

function argmax(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

/**
 * The whole Ask Mary pipeline for one squad: fetches its players/pool/
 * fixtures, builds candidate moves and Mary Move Scores across all three
 * planning horizons, squad health, captaincy, the gameweek roadmap, and
 * players-to-monitor - then archives every recommendation as a batch of
 * immutable predictions (Mary Performance Lab). Used by both the Ask
 * Mary page itself (for the squad/settings currently being viewed) and
 * the background job that keeps every squad's predictions current (see
 * generateAllSquadPredictions below) - one engine, not two copies of the
 * scoring logic.
 *
 * Returns null if the squad's composition is currently invalid (wrong
 * player count) - the caller decides how to surface that (a page shows a
 * message; the background job just skips the squad silently).
 */
export async function runAskMaryAnalysis(
  supabase: Supabase,
  squad: { id: number; name: string; free_transfers: number },
  fanteamGame: { id: number; display_name: string },
  activeStrategy: Strategy,
  activeLimit: { value: number | null },
  recordPredictionsFn?: (records: PredictionRecord[]) => Promise<{ error?: string } | { recorded: number }>
): Promise<AskMaryAnalysis | null> {
  const { data: rulesRow } = await supabase
    .from("game_squad_rules")
    .select("budget, max_per_club, squad_size, starting_size")
    .eq("game_id", fanteamGame.id)
    .single();
  if (!rulesRow) return null;
  // Reassigned to a plain non-null const - TypeScript's control-flow
  // narrowing from the guard above doesn't carry into the nested
  // buildHorizonResult function declaration below.
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
  const scoreMapByGameweeks = new Map([[1, score1Map], [3, score3Map], [5, score5Map]]);

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

  function buildHorizonResult(gameweeks: number, scoreMapForHorizon: Map<number, number>): HorizonResult {
    const poolCandidates: TransferCandidate[] = (pool ?? []).map((p) => ({
      gamePlayerId: p.game_player_id,
      fullName: p.full_name,
      teamId: p.team_id,
      teamName: p.team_name,
      price: Number(p.price),
      score: avgFor(scoreMapForHorizon, p.game_player_id),
      position: p.position,
    }));

    const moves: Move[] = [];
    for (const outPlayer of squadPlayers) {
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
        squadIds,
        budgetRemaining,
        clubCounts,
        rules.max_per_club
      );
      const best = matches[0];
      if (!best) continue;
      const inCand = best.candidate;
      const inPoolRow = poolByGamePlayerId.get(inCand.gamePlayerId);
      const outPoolRow = poolByGamePlayerId.get(outPlayer.game_player_id);
      const outTeamRating = ratingByTeam.get(outPlayer.team_name);
      const inTeamRating = ratingByTeam.get(inCand.teamName);

      const gainAt = (map: Map<number, number>, gws: number) =>
        (avgFor(map, inCand.gamePlayerId) - avgFor(map, outPlayer.game_player_id)) * gws;

      moves.push({
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
          outgoingMinutesSecurity: LINEUP_SECURITY_SCORES[outPlayer.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE,
          incomingInjuryAvailability: INJURY_AVAILABILITY_SCORES[inPoolRow?.status ?? ""] ?? DEFAULT_SECURITY_SCORE,
          incomingForm: inPoolRow?.form != null ? Number(inPoolRow.form) : null,
          outgoingForm: outPlayer.form,
          incomingIsConfirmedStarter: inPoolRow?.lineup === "confirmed_starting",
          hasFixtureData: !!outTeamRating && !!inTeamRating,
          hasStatusData: inPoolRow?.lineup != null && outPlayer.lineup != null,
        },
        gain1: gainAt(score1Map, 1),
        gain3: gainAt(score3Map, 3),
        gain5: gainAt(score5Map, 5),
        outPrice: outPlayer.price,
        inPrice: inCand.price,
      });
    }

    const scoresActive = scoreMoveCandidates(moves.map((m) => m.input), activeStrategy);
    const scoresDifferential = scoreMoveCandidates(moves.map((m) => m.input), "differential");
    const scoresSafe = scoreMoveCandidates(moves.map((m) => m.input), "safe");

    function toRecFor(i: number, score: MoveScore, rank: number, label?: string): AskMaryRecommendation {
      const m = moves[i];
      return {
        rank,
        label,
        squadId: squad.id,
        gameId: fanteamGame.id,
        outGamePlayerId: m.input.outGamePlayerId,
        outName: m.input.outName,
        outTeam: m.input.outTeam,
        outPrice: m.outPrice,
        inGamePlayerId: m.input.inGamePlayerId,
        inName: m.input.inName,
        inTeam: m.input.inTeam,
        inPrice: m.inPrice,
        position: m.input.position,
        transferCost: m.input.priceDelta,
        moneyRemainingAfter: budgetRemaining - m.input.priceDelta,
        expectedPointsBefore: avgFor(scoreMapForHorizon, m.input.outGamePlayerId) * gameweeks,
        expectedPointsAfter: avgFor(scoreMapForHorizon, m.input.inGamePlayerId) * gameweeks,
        gain1: m.gain1,
        gain3: m.gain3,
        gain5: m.gain5,
        hailMaryScoreDiff: m.input.hailMaryScoreDiff,
        fixtureSwingDiff: m.input.fixtureSwingDiff,
        risk: score.risk,
        confidence: score.confidence,
        overall: score.overall,
        reasons: score.reasons,
        warnings: score.warnings,
      };
    }

    const sortedIndices = scoresActive.map((s, i) => i).sort((a, b) => scoresActive[b].overall - scoresActive[a].overall);
    const bestOverallScore = sortedIndices.length > 0 ? scoresActive[sortedIndices[0]].overall : 0;
    const hold = moves.length === 0 || bestOverallScore < HOLD_SCORE_THRESHOLD;

    const rankedMoves = sortedIndices
      .slice(0, activeLimit.value ?? sortedIndices.length)
      .map((idx, n) => toRecFor(idx, scoresActive[idx], n + 1));

    const categoryCards: AskMaryRecommendation[] = [];
    if (moves.length > 0) {
      const gain1Idx = argmax(moves.map((m) => m.gain1 ?? -Infinity));
      categoryCards.push(toRecFor(gain1Idx, scoresActive[gain1Idx], 0, "Best Immediate Move"));

      categoryCards.push(toRecFor(sortedIndices[0], scoresActive[sortedIndices[0]], 0, `Best ${gameweeks} Gameweek${gameweeks > 1 ? "s" : ""} Move`));

      const valueRaw = moves.map((m) =>
        m.input.priceDelta <= 0 ? m.input.expectedPointsGain + 1 : m.input.expectedPointsGain / Math.max(m.input.priceDelta, 0.5)
      );
      const valueIdx = argmax(valueRaw);
      categoryCards.push(toRecFor(valueIdx, scoresActive[valueIdx], 0, "Best Value Move"));

      const diffIndices = moves.map((m, i) => i).filter((i) => !moves[i].input.incomingIsConfirmedStarter);
      if (diffIndices.length > 0) {
        const diffIdx = diffIndices.reduce((best, cur) => (scoresDifferential[cur].overall > scoresDifferential[best].overall ? cur : best));
        categoryCards.push(toRecFor(diffIdx, scoresDifferential[diffIdx], 0, "Best Differential Move"));
      }

      const safeIndices = moves
        .map((m, i) => i)
        .filter((i) => moves[i].input.incomingMinutesSecurity >= 0.85 && moves[i].input.incomingInjuryAvailability === 1);
      if (safeIndices.length > 0) {
        const safeIdx = safeIndices.reduce((best, cur) => (scoresSafe[cur].overall > scoresSafe[best].overall ? cur : best));
        categoryCards.push(toRecFor(safeIdx, scoresSafe[safeIdx], 0, "Best Safe Move"));
      }
    }

    return { moves, hold, bestOverallScore, rankedMoves, categoryCards };
  }

  const horizonResults = new Map<number, HorizonResult>(
    ASK_MARY_HORIZONS.map((h) => [h.gameweeks, buildHorizonResult(h.gameweeks, scoreMapByGameweeks.get(h.gameweeks) ?? new Map())])
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
  // Squad health/captaincy use the 5-GW horizon window for fixture-swing
  // awareness - same default the page itself defaults to.
  const health = assessSquadHealth(healthPlayers, positionAverages, rules.max_per_club, ratingByTeam, 5);

  const captaincyPool: CaptaincyPick[] = squadPlayers
    .filter((p) => p.is_starting)
    .map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      team_name: p.team_name,
      lineup: p.lineup,
      score: poolByGamePlayerId.get(p.game_player_id)?.hail_mary_score != null ? Number(poolByGamePlayerId.get(p.game_player_id)!.hail_mary_score) : 0,
    }))
    .sort((a, b) => b.score - a.score);
  const bestCaptain = captaincyPool[0] ?? null;
  const viceCaptain = captaincyPool[1] ?? null;
  const safestCaptain =
    captaincyPool
      .slice()
      .sort(
        (a, b) =>
          (LINEUP_SECURITY_SCORES[b.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE) - (LINEUP_SECURITY_SCORES[a.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE) ||
          b.score - a.score
      )[0] ?? null;
  const differentialCaptain = captaincyPool.find((p) => p.lineup !== "confirmed_starting") ?? null;

  // Gameweek Plan + Players to Monitor use a 5-GW window, matching the
  // page's own default so the archived-vs-displayed content lines up.
  const planningHorizonForNarrative = 5;
  const roadmap: { label: string; text: string }[] = [];
  if (planningGameweek != null) {
    const result5 = horizonResults.get(5)!;
    const top = result5.rankedMoves[0] ?? null;
    roadmap.push({
      label: `This Gameweek (GW${planningGameweek})`,
      text: !result5.hold && top ? `Sell ${top.outName} and buy ${top.inName}.` : "Hold - no transfer creates a meaningful improvement right now.",
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

  // Mary Performance Lab, Part 1 - archive this analysis as a batch of
  // immutable predictions, across all three planning horizons.
  // recordPredictionsFn is injected rather than imported directly - the
  // background job (generateAllSquadPredictions) calls the DB the same
  // way, but the Ask Mary page needs its own "use server" action for the
  // client-triggered path, so both callers pass in whichever write path
  // is appropriate for their context.
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
      transferLimit: activeLimit.value,
      budgetRemainingBefore: budgetRemaining,
      freeTransfersBefore: squad.free_transfers,
    };

    const predictionRecords: PredictionRecord[] = [];

    for (const h of ASK_MARY_HORIZONS) {
      const result = horizonResults.get(h.gameweeks)!;
      const sharedContext = { ...baseContext, planningHorizon: h.gameweeks };

      if (result.hold) {
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
          maryMoveScore: result.moves.length > 0 ? result.bestOverallScore : null,
          confidence: null,
          risk: null,
          reasons: [{ code: "hold", text: "No available transfer created a meaningful expected-points improvement." }],
          warnings: [],
        });
      } else {
        for (const c of [...result.categoryCards, ...result.rankedMoves]) {
          predictionRecords.push({
            ...sharedContext,
            kind: "transfer",
            recommendationType: c.label ? c.label.toLowerCase().replace(/\s+/g, "_") : "ranked",
            rank: c.label ? null : c.rank,
            outGamePlayerId: c.outGamePlayerId,
            inGamePlayerId: c.inGamePlayerId,
            outPrice: c.outPrice,
            inPrice: c.inPrice,
            transferCost: c.transferCost,
            captainGamePlayerId: null,
            viceCaptainGamePlayerId: null,
            expectedPointsBefore: c.expectedPointsBefore,
            expectedPointsAfter: c.expectedPointsAfter,
            expectedGain: c.expectedPointsAfter - c.expectedPointsBefore,
            hailMaryScoreDiff: c.hailMaryScoreDiff,
            fixtureSwingDiff: c.fixtureSwingDiff,
            maryMoveScore: c.overall,
            confidence: c.confidence,
            risk: c.risk,
            reasons: c.reasons,
            warnings: c.warnings,
          });
        }
      }
    }

    if (bestCaptain && viceCaptain) {
      predictionRecords.push({
        ...baseContext,
        planningHorizon: 1,
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
        reasons: [{ code: "top_scorer", text: `${bestCaptain.full_name} is the highest-projected starter.` }],
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
    horizonResults,
    health,
    bestCaptain,
    viceCaptain,
    safestCaptain,
    differentialCaptain,
    roadmap,
    monitorList,
  };
}

export { toPredictionRow };
