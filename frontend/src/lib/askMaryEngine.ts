import type { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { findLegalReplacementsForOutgoing, type TransferCandidate } from "@/lib/transferMatching";
import { suggestBestXI, type Formation } from "@/lib/squadOptimizer";
import { computeAutoSubAwareTotal, type AutoSubPlayer } from "@/lib/benchAutoSub";
import { type FixtureDifficultyRow } from "@/lib/fixtureRuns";
import { deriveTeamFixtureRatings, type TeamFixtureRating } from "@/lib/fixtureSwing";
import { LINEUP_SECURITY_SCORES, INJURY_AVAILABILITY_SCORES, DEFAULT_SECURITY_SCORE } from "@/lib/playerStatus";
import { buildFormByGamePlayerId, type FormStatus } from "@/lib/hailMaryForm";
import { getMatchDaysForSquad, resolveAutoPick } from "@/lib/matchDayCaptains";
import {
  transferCost as fanteamTransferCost,
  isWildcardActive as fanteamIsWildcardActive,
  accrueFreeTransfers as fanteamAccrueFreeTransfers,
} from "@/lib/transferEconomy";
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
  inFormStatus?: FormStatus | null; // is the incoming player hot/cold against Mary's own model - see lib/hailMaryForm.ts
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
  // Index (within this same step's transfers[]) of the other leg this one
  // was budget-pooled with - see findBestPairBundle. Set on both sides of
  // a pair, undefined for an ordinary single leg that clears its own cost
  // alone. Lets the UI show "these two were evaluated together" instead
  // of a leg with a negative raw gain looking like an unexplained mistake.
  pairedLegIndex?: number;
};

/**
 * What Mary recommends for one specific upcoming gameweek - zero to
 * MAX_TRANSFERS_PER_STEP transfers, always jointly legal (each leg
 * validated against the cumulative state left by the legs before it, via
 * the same findLegalReplacementsForOutgoing budget/position/club-limit
 * filter every other transfer surface in this app already uses), so an illegal
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
  // The optimal STARTING XI's projected points for this specific
  // gameweek, after this step - not a flat sum of all 15 squad players,
  // since bench points don't count toward the real total (see
  // optimalXITotal).
  resultingSquadExpectedPoints: number;
  writeup: string; // plain-English summary of what this step recommends and why
};

export type FavouredMoveKind = "quick_win" | "momentum_3gw" | "long_term_5gw" | "hold" | "prepare_for_target";

/**
 * One of up to 5 ranked, genuinely different options presented alongside
 * (not instead of) the sequential gameweekPlan above - "what should I do
 * THIS gameweek" viewed through different lenses (next week only, next 3,
 * next 5, doing nothing, or setting up a bigger move) rather than one
 * committed multi-week path. Each option is independently computed from
 * the squad's CURRENT real state, so they're real alternatives to pick
 * between, not steps that assume an earlier option was already taken.
 * See buildFavouredMoves.
 */
export type FavouredMove = {
  kind: FavouredMoveKind;
  label: string;
  transfers: BundleTransfer[]; // empty when hold is true
  hold: boolean;
  horizonGameweeks: number; // the window this option was optimized against
  projectedGainOverHorizon: number; // realized points gain (already net of any -4 hit), 0 for hold
  writeup: string;
  // Only set for "prepare_for_target" - the elite player this move is
  // working toward, not yet affordable outright.
  targetPlayer?: { gamePlayerId: number; fullName: string; teamName: string; price: number };
};

/** How much more cash the closest route Mary tried for a target would still need. */
export type TargetFundingShortfall = {
  amount: number;
  primaryOutName: string;
  // Set only when a second downgrade was actually tried for this route -
  // null means the same-position swap alone was the closest attempt.
  secondaryOutName: string | null;
  secondaryInName: string | null;
};

export type TargetPlanResult = {
  move: FavouredMove | null;
  // Set only when move is null - the closest route Mary actually found
  // (a same-position swap, optionally plus one further legal downgrade
  // elsewhere), so "not reachable" can show a real number instead of the
  // target's full price.
  closestShortfall: TargetFundingShortfall | null;
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
  formStatus?: FormStatus | null;
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

// Cloud FF's real captain rule - one captain per calendar match-day, not
// per gameweek (see migration 0083's docstring) - additive to bestCaptain/
// viceCaptain below, which keep serving every other game's real single-
// captain-per-gameweek rule unchanged. Only ever populated for cloudff.
export type MatchDayCaptainPick = {
  matchDate: string;
  gameweek: number;
  captain: { game_player_id: number; full_name: string; team_name: string; score: number } | null;
  vice: { game_player_id: number; full_name: string; team_name: string; score: number } | null;
  autoPicked: boolean;
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
  favouredMoves: FavouredMove[];
  // Only set when the caller passes explicitTargetGamePlayerId - the
  // "Fund a Target" workflow's result for that one player. Null overall
  // means the player wasn't found in the pool (or is already owned);
  // otherwise `move` is the same shape as a favouredMoves entry (kind:
  // "prepare_for_target") so it renders through the existing
  // FavouredMoveCard unchanged, or null with closestShortfall set when no
  // route was found - see TargetPlanResult.
  targetPlan: TargetPlanResult | null;
  bestCaptain: CaptaincyPick | null;
  viceCaptain: CaptaincyPick | null;
  captainsByMatchDay: MatchDayCaptainPick[];
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
  fanteamGame: { id: number; display_name: string; slug: string },
  activeStrategy: Strategy,
  recordPredictionsFn?: (records: PredictionRecord[]) => Promise<{ error?: string } | { recorded: number }>,
  // "Fund a Target" - when set, also computes targetPlan for this one
  // specific player (see buildTargetPlan below). Never affects
  // gameweekPlan/favouredMoves/captain - purely additive.
  explicitTargetGamePlayerId?: number
): Promise<AskMaryAnalysis | null> {
  // Captain/vice-captain is no longer horizon-selectable - always the
  // next gameweek only. Kept as a named local (not inlined at every call
  // site below) since it still feeds getHorizonMap and the archived
  // prediction's planning_horizon column.
  const captainHorizonGameweeks = 1;

  // Cloud FF's real transfer model (50 transfers/season total + one
  // Overhaul window, zero points penalty ever) has no home in the schema
  // yet - no season-total-cap column exists anywhere. Mirrors
  // executeTransfer's existing isCloudFF bypass (squads/actions.ts) here
  // on the search side too: every transfer this engine considers for
  // Cloud FF is treated as free and never wildcard-blocked, rather than
  // running FanTeam's real cost function against free_transfers/wildcard
  // columns that don't mean anything for Cloud FF. A flagged, temporary
  // simplification, not the real model - every call below this point
  // uses these local shadows instead of transferEconomy.ts directly, so
  // no individual call site needs its own game-slug branch.
  const isCloudFF = fanteamGame.slug === "cloudff";
  function transferCost(freeTransfersRemaining: number, wildcardActive: boolean): number {
    return isCloudFF ? 0 : fanteamTransferCost(freeTransfersRemaining, wildcardActive);
  }
  function isWildcardActive(gameweek: number, wildcard1UsedGameweek: number | null, wildcard2UsedGameweek: number | null): boolean {
    return isCloudFF ? false : fanteamIsWildcardActive(gameweek, wildcard1UsedGameweek, wildcard2UsedGameweek);
  }
  function accrueFreeTransfers(current: number): number {
    return isCloudFF ? current : fanteamAccrueFreeTransfers(current);
  }

  // Every query below reads only the input params (fanteamGame.id,
  // fanteamGame.slug, or squad.id) - none of them depend on
  // another query's result, so they're fetched together instead of one
  // await at a time. That sequential-by-default pattern was previously
  // adding 4+ real round trips of pure network latency to every Ask Mary
  // page load before any recommendation math even started - confirmed by
  // measuring a live page's TTFB. fixturesRaw/difficultyRaw (used much
  // further down, alongside the fixture-block/swing computations) and
  // getSeasonTiming's own query are folded into this same batch for the
  // same reason - their own inputs are equally independent, they were
  // just physically written later in the function.
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
    supabase.from("game_squad_rules").select("budget, max_per_club, squad_size, starting_size").eq("game_id", fanteamGame.id).single(),
    // Needed to know which players in a hypothetical squad would actually
    // START (and therefore actually score) - see optimalXITotal below.
    supabase.from("game_formations").select("code, gk_count, def_count, mid_count, fwd_count").eq("game_id", fanteamGame.id).order("code"),
    supabase
      .from("squad_players")
      .select("game_player_id, is_starting, game_players(price, players(full_name, position, team_id, teams!players_team_id_fkey(name)))")
      .eq("squad_id", squad.id)
      .returns<SquadPlayerRow[]>(),
    supabase.from("game_player_pool").select("*").eq("game_slug", fanteamGame.slug).returns<PoolRow[]>(),
    // Hail Mary Form - same merge pattern as every other surface, sourced
    // from the frozen prediction archive (migration 0044) rather than
    // game_player_pool. Threaded through poolCandidates below so a
    // recommended buy's form shows up on BundleTransfer.inFormStatus.
    // completed gameweeks only - also keeps this well under PostgREST's
    // default row cap across a full season.
    supabase
      .from("player_gameweek_predictions")
      .select("game_player_id, gameweek, points_difference")
      .eq("game_id", fanteamGame.id)
      .not("points_difference", "is", null),
    supabase
      .from("game_fixture_gameweeks")
      .select("gameweek, fixtures!inner(kickoff_at)")
      .eq("game_id", fanteamGame.id)
      .gte("fixtures.kickoff_at", nowIso)
      .order("gameweek", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("game_fixture_gameweeks")
      .select(
        "gameweek, fixtures(id, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))"
      )
      .eq("game_id", fanteamGame.id)
      .gte("fixtures.kickoff_at", nowIso)
      .order("gameweek"),
    supabase
      .from("team_fixture_difficulty")
      .select("fixture_id, team_id, attack_score, clean_sheet_score")
      .eq("game_id", fanteamGame.id)
      .returns<{ fixture_id: number; team_id: number; attack_score: number; clean_sheet_score: number }[]>(),
    getSeasonTiming(supabase, fanteamGame.id),
  ]);

  if (!rulesRow) return null;
  // Reassigned to a plain non-null const - TypeScript's control-flow
  // narrowing from the guard above doesn't carry into nested function
  // declarations below.
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

  const currentGameweek: number | null = gwRow?.gameweek ?? null;
  const hasCalendar = currentGameweek !== null;
  const { seasonStarted, planningGameweek } = seasonTiming;

  const freeTransfersBanked = seasonStarted ? squad.free_transfers : Infinity;

  // Fetches one specific gameweek's 1-GW score map - player_score_by_horizon_from
  // is purely parameterized on (start gameweek, window length), no
  // season-started gating, so this works identically pre-season and
  // in-season. Falls back to an empty map (avgFor then uses the flat
  // hail_mary_score) when no calendar is published yet.
  async function getStepScoreMap(gameweek: number): Promise<Map<number, number>> {
    if (!hasCalendar) return new Map();
    const { data } = await supabase.rpc("player_score_by_horizon_from", {
      p_game_slug: fanteamGame.slug,
      p_start_gameweek: gameweek,
      p_num_gameweeks: 1,
    });
    return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
  }

  // Captain uses its own selectable horizon window, independent of the
  // gameweek-by-gameweek transfer plan.
  async function getHorizonMap(gameweeks: number): Promise<Map<number, number>> {
    if (hasCalendar && !seasonStarted) {
      const { data } = await supabase.rpc("player_score_by_horizon", { p_game_slug: fanteamGame.slug, p_num_gameweeks: gameweeks });
      return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
    }
    if (hasCalendar && seasonStarted && planningGameweek !== null) {
      const { data } = await supabase.rpc("player_score_by_horizon_from", {
        p_game_slug: fanteamGame.slug,
        p_start_gameweek: planningGameweek,
        p_num_gameweeks: gameweeks,
      });
      return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
    }
    return new Map();
  }

  const stepGameweeks = planningGameweek != null ? [0, 1, 2].map((offset) => planningGameweek + offset) : [];
  const [stepScoreMaps, captainScoreMap, threeGwMap, fiveGwMap] = await Promise.all([
    Promise.all(stepGameweeks.map((gw) => getStepScoreMap(gw))),
    getHorizonMap(captainHorizonGameweeks),
    getHorizonMap(3),
    getHorizonMap(5),
  ]);

  function avgFor(map: Map<number, number>, gamePlayerId: number): number {
    if (map.size > 0) return map.get(gamePlayerId) ?? 0;
    const hms = poolByGamePlayerId.get(gamePlayerId)?.hail_mary_score;
    return hms != null ? Number(hms) : 0;
  }

  // Same real-world meaning as compute_projections.py's status_multiplier
  // (lineup likelihood x injury/suspension availability) - mirrored here
  // via lib/playerStatus.ts's numeric tables rather than duplicating the
  // Python mapping. Defaults to 1 (nailed on) when no live status exists
  // yet, which is every player right now, pre-season.
  function survivalProbabilityFor(gamePlayerId: number): number {
    const row = poolByGamePlayerId.get(gamePlayerId);
    const lineupScore = LINEUP_SECURITY_SCORES[row?.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE;
    const injuryScore = INJURY_AVAILABILITY_SCORES[row?.status ?? ""] ?? DEFAULT_SECURITY_SCORE;
    return lineupScore * injuryScore;
  }

  /**
   * The realized total for one hypothetical squad state at one gameweek's
   * scores: only the OPTIMAL STARTING XI's points actually count (see
   * suggestBestXI, which picks the best-legal formation and its top
   * scorers per position) - bench value is credited only through real
   * auto-substitution (see computeAutoSubAwareTotal), never assumed. This
   * is what the whole transfer search below optimizes for instead of a
   * flat sum of all 15 players' scores, which would silently credit
   * points a bench player was never actually going to score.
   *
   * Mary doesn't manage a persisted bench order for her own hypothetical
   * squads (that's a real LineupBuilder concern - see squads/[id]/page.tsx
   * for where the user's actual saved bench_order feeds the same
   * auto-sub math) - the non-starters are ranked by their own score,
   * highest first, the obvious default a rational manager would pick
   * absent any other instruction.
   */
  function optimalXITotal(squad: WorkingSquadPlayer[], scoreMapForStep: Map<number, number>): number {
    const withScores = squad.map((p) => ({ game_player_id: p.game_player_id, position: p.position, score: avgFor(scoreMapForStep, p.game_player_id) }));
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
    return {
      game_player_id: cand.gamePlayerId,
      full_name: cand.fullName,
      position: cand.position,
      team_id: cand.teamId,
      team_name: cand.teamName,
      price: cand.price,
    };
  }

  // fixturesRaw/difficultyRaw already fetched in the initial Promise.all above.
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

  type SlotMove = { input: MoveCandidateInput; outPlayer: WorkingSquadPlayer; inCandidate: TransferCandidate };

  /**
   * Builds the full MoveCandidateInput (fixture/status/form context etc.)
   * for one hypothetical sell/buy leg - shared by the single-slot search
   * and the pair-bundle search below so this lookup isn't duplicated.
   * `realizedPointsGain` is the actual starting-XI-aware value of this
   * leg (see optimalXITotal) - always supplied by both call sites now;
   * the raw score delta fallback only exists so this can't silently
   * produce NaN if a future caller forgets it.
   */
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
        hailMaryScoreDiff:
          (inPoolRow?.hail_mary_score != null ? Number(inPoolRow.hail_mary_score) : 0) -
          (outPoolRow?.hail_mary_score != null ? Number(outPoolRow.hail_mary_score) : 0),
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
   * Budget-pooled 2-leg search. The single-slot search below can only ever
   * suggest a leg that individually clears its own cost (a strictly
   * better same-position replacement) - so a player who's already the
   * best in their position (e.g. a premium whose price has simply caught
   * up with them) can never be flagged for sale, even when selling them
   * would free enough budget to fund a much bigger combined upgrade
   * elsewhere (e.g. selling an expensive slot plus a budget slot to land
   * two mid-price players whose combined output beats the premium alone -
   * a real strategy the per-slot search structurally couldn't see, since
   * neither leg has to justify itself alone, only the pair together).
   * This searches every pair of current squad members (any positions -
   * money isn't position-locked, only each leg's replacement is), pools
   * their combined sale value, and finds the best-scoring affordable
   * same-position replacement for each leg. Shortlisted to the top 15
   * pool candidates per position (by this step's score) before pairing,
   * since the true best combo is overwhelmingly unlikely to need a
   * low-scoring candidate the price constraint wouldn't reward anyway -
   * keeps this O(pairs x 15 x 15) instead of O(pairs x poolSize^2).
   * Triples and larger bundles aren't searched - pairs already cover the
   * reported gap, and the combinatorial cost grows fast.
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
            !boughtIds.has(p.game_player_id)
        )
        .map((p) => ({
          gamePlayerId: p.game_player_id,
          fullName: p.full_name,
          teamId: p.team_id,
          teamName: p.team_name,
          price: Number(p.price),
          score: avgFor(scoreMapForStep, p.game_player_id),
          position: p.position,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 15);
      shortlistByPosition.set(position, shortlist);
    }

    let best: {
      outA: WorkingSquadPlayer; outB: WorkingSquadPlayer; inA: TransferCandidate; inB: TransferCandidate;
      netGain: number; costA: number; costB: number; gainA: number; gainB: number;
    } | null = null;

    for (let i = 0; i < sellable.length; i++) {
      for (let j = i + 1; j < sellable.length; j++) {
        const outA = sellable[i];
        const outB = sellable[j];
        const freedBudget = workingBudget + outA.price + outB.price;
        const candA = shortlistByPosition.get(outA.position) ?? [];
        const candB = shortlistByPosition.get(outB.position) ?? [];

        // Raw combined score picks which CANDIDATES to even consider - a
        // cheap, reliable proxy for "worth full evaluation" (a low-score
        // candidate is essentially never going to raise the starting XI
        // total). The actual accept/reject decision below uses real,
        // starting-XI-aware value instead - see the netGain comment.
        let bestCombo: { inA: TransferCandidate; inB: TransferCandidate; combinedScore: number } | null = null;
        for (const inA of candA) {
          for (const inB of candB) {
            if (inA.gamePlayerId === inB.gamePlayerId) continue;
            if (inA.price + inB.price > freedBudget) continue;
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

        // Realized (starting-XI-aware) value, not raw score sums - selling
        // one asset specifically to fund a bigger upgrade elsewhere only
        // pays off if that upgrade actually cracks the starting XI, not
        // just raises a bench player's raw score. Sequential attribution
        // (apply A, measure the new total; apply B, measure again) so
        // gainA + gainB always telescopes to the pair's true combined
        // delta, while each leg still gets a sensible individual number.
        const squadAfterA = workingSquad.filter((p) => p.game_player_id !== outA.game_player_id).concat(toWorkingSquadPlayer(bestCombo.inA));
        const xiTotalAfterA = optimalXITotal(squadAfterA, scoreMapForStep);
        const squadAfterBoth = squadAfterA.filter((p) => p.game_player_id !== outB.game_player_id).concat(toWorkingSquadPlayer(bestCombo.inB));
        const xiTotalAfterBoth = optimalXITotal(squadAfterBoth, scoreMapForStep);
        const gainA = xiTotalAfterA - currentXITotal;
        const gainB = xiTotalAfterBoth - xiTotalAfterA;
        const netGain = gainA + gainB + costA + costB;
        if (netGain <= 0) continue; // pair doesn't clear its combined cost - not worth it

        if (!best || netGain > best.netGain) {
          best = { outA, outB, inA: bestCombo.inA, inB: bestCombo.inB, netGain, costA, costB, gainA, gainB };
        }
      }
    }

    if (!best) return null;
    const outScoreA = avgFor(scoreMapForStep, best.outA.game_player_id);
    const outScoreB = avgFor(scoreMapForStep, best.outB.game_player_id);
    return {
      legA: buildLegInput(best.outA, best.inA, outScoreA, best.gainA),
      legB: buildLegInput(best.outB, best.inB, outScoreB, best.gainB),
      costA: best.costA,
      costB: best.costB,
      netGain: best.netGain,
    };
  }

  /**
   * Greedy incremental search for one gameweek step: each round, compares
   * the single best legal transfer against the CURRENT working squad
   * state with the best budget-pooled PAIR of transfers (see
   * findBestPairBundle - doesn't require either leg to individually clear
   * cost, only the pair combined), takes whichever has the higher net
   * gain, applies it hypothetically, and re-searches from the new state -
   * stopping once neither option clears cost (or MAX_TRANSFERS_PER_STEP
   * is reached - a safety bound on loop iterations, not a real limit,
   * since the cost-clearing check already does the real work). "Best" for
   * picking which slot to fill is the REALIZED, starting-XI-aware points
   * gain (see optimalXITotal) - not each candidate's raw projected score,
   * and not the normalized 0-100 Mary Move Score either (that score is
   * min-max normalized within whichever candidate set produced it, so
   * scores from two different search rounds aren't on a comparable
   * scale). Points sitting on the bench don't count toward a squad's real
   * total, so a swap that only raises a bench player's raw score - one
   * that would never actually start - correctly shows ~0 realized gain
   * and gets passed over in favour of a move that actually changes who's
   * in the starting XI. scoreMoveCandidates is still called each round
   * purely to surface a real score/confidence/risk/reasons for whichever
   * move(s) get chosen (and a single leg's runner-up, if kept as an
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

    // Applies one accepted leg to the working state (shared by both the
    // single-leg and pair-bundle paths below) before the next round.
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
        .filter((p) => !soldIds.has(p.game_player_id)) // can't buy back a player already sold this plan
        .map((p) => ({
          gamePlayerId: p.game_player_id,
          fullName: p.full_name,
          teamId: p.team_id,
          teamName: p.team_name,
          price: Number(p.price),
          score: avgFor(scoreMapForStep, p.game_player_id),
          position: p.position,
          formStatus: p.formStatus,
        }));

      // What the squad's realized total actually is right now - the
      // baseline every candidate leg below is measured against.
      const currentXITotal = optimalXITotal(workingSquad, scoreMapForStep);

      const slotMoves: SlotMove[] = [];
      for (const outPlayer of workingSquad) {
        if (boughtIds.has(outPlayer.game_player_id)) continue;
        const outScore = avgFor(scoreMapForStep, outPlayer.game_player_id);
        // Legality only (position/budget/club-limit) - no "must be
        // individually better" requirement here, unlike the old
        // findBuyCandidatesForOutgoing this replaced. That requirement
        // used to be the ONLY thing filtering candidates, using each
        // player's raw score; now the real filter is realized value
        // below, which correctly handles the case a raw-score comparison
        // can't: a same-position swap to a higher scorer that would still
        // just sit on the bench is worth exactly 0, not "an upgrade".
        const legalCandidates = findLegalReplacementsForOutgoing(
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
        // Shortlisted to the top 20 by raw score before evaluating
        // realized value - same pragmatic bound as findBestPairBundle's
        // shortlist and for the same reason: raw score reliably predicts
        // which candidates are even worth full evaluation, and this keeps
        // worst-case cost predictable against a large player pool.
        let bestCandidate: TransferCandidate | null = null;
        let bestGain = 0; // must clear 0 (i.e. actually raise the realized total) to be worth recommending at all
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
      const singleCost = transferCost(freeRemaining, wildcardActive);
      const singleNetGain = bestSingleIdx !== -1 ? slotMoves[bestSingleIdx].input.expectedPointsGain + singleCost : -Infinity;

      const pairResult = findBestPairBundle(
        { workingSquad, workingSquadIds, workingBudget, workingClubCounts, freeRemaining },
        scoreMapForStep,
        wildcardActive,
        soldIds,
        boughtIds,
        currentXITotal
      );
      const pairNetGain = pairResult ? pairResult.netGain : -Infinity;

      if (bestSingleIdx === -1 && !pairResult) break; // nothing legal at all - stop the search here

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

      if (bestSingleIdx === -1 || singleNetGain <= 0) break; // doesn't clear its own cost - not worth recommending

      const scores = scoreMoveCandidates(
        slotMoves.map((m) => m.input),
        activeStrategy
      );
      const chosen = slotMoves[bestSingleIdx];
      const chosenScore = scores[bestSingleIdx];

      // A runner-up within ~10% of the chosen move's raw gain (or within
      // a small absolute band for near-zero gains) is a real toss-up -
      // surface it instead of silently discarding it.
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

  function describeStep(step: {
    seasonStarted: boolean;
    transfers: BundleTransfer[];
    gameweek: number;
    freeAfter: number | "unlimited";
  }): string {
    const { transfers, gameweek, freeAfter } = step;
    // Cloud FF has no free-transfer-banking concept at all (see the
    // isCloudFF bypass above) - every transfer this engine considers for
    // it is already free, so describe it that way unconditionally
    // instead of talking about "banking a free transfer" that doesn't
    // exist for this game, regardless of the FanTeam-shaped
    // seasonStarted flag.
    if (isCloudFF) {
      if (transfers.length === 0) return "Hold - nothing beats what you already have here.";
      const names = transfers.map((t) => `${t.outName} → ${t.inName}`).join(", ");
      return transfers.length === 1
        ? `Make this transfer - Cloud FF transfers are free: ${names}.`
        : `Make these ${transfers.length} transfers - Cloud FF transfers are free: ${names}.`;
    }
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

  type StepBranch = { step: GameweekPlanStep; state: SearchState; soldIds: Set<number>; boughtIds: Set<number> };

  /**
   * Computes ONE gameweek step from a given incoming state, in up to two
   * flavours: "greedy" (searchBestMoves's real best chain for this step,
   * exactly as before) and - only when a real move was actually available
   * and it isn't the pre-season unlimited-transfers step - "forcedHold" (the
   * same incoming state carried forward untouched). forcedHold is what lets
   * the plan discover "banking now sets up a bigger move later," something
   * a purely greedy walk can never see: greedy always takes any move that
   * clears its own cost THIS gameweek, even a marginal one, so it can never
   * choose to withhold a transfer in order to combine it with a future
   * gameweek's free transfer for a bigger move. Each branch gets its own
   * copies of soldIds/boughtIds so exploring both doesn't let one branch's
   * hypothetical sale leak into the other's.
   */
  function computeStepBranches(
    offset: number,
    incomingState: SearchState,
    incomingSoldIds: Set<number>,
    incomingBoughtIds: Set<number>
  ): { greedy: StepBranch; forcedHold: StepBranch | null } {
    // Unlimited transfers only apply up to GW1's actual kickoff - not to
    // this whole plan just because it happened to be computed pre-season.
    // See the original single-path implementation this replaced for the
    // full reasoning; unchanged here.
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
    const greedyResult = searchBestMoves(state, scoreMapForStep, wildcardActiveHere, greedySoldIds, greedyBoughtIds);
    const greedyStep = buildStep(greedyResult);
    const greedyState: SearchState = {
      workingSquad: greedyResult.workingSquad,
      workingSquadIds: greedyResult.workingSquadIds,
      workingBudget: greedyResult.workingBudget,
      workingClubCounts: greedyResult.workingClubCounts,
      freeRemaining: greedyResult.freeRemaining,
    };
    const greedy: StepBranch = { step: greedyStep, state: greedyState, soldIds: greedySoldIds, boughtIds: greedyBoughtIds };

    if (isPreSeasonStep || greedyStep.transfers.length === 0) {
      // Nothing to withhold: pre-season transfers cost nothing to spend
      // immediately, and if greedy itself found no move that clears cost,
      // a forced hold would be an exact duplicate of the greedy branch.
      return { greedy, forcedHold: null };
    }

    const holdSoldIds = new Set(incomingSoldIds);
    const holdBoughtIds = new Set(incomingBoughtIds);
    const holdStep = buildStep({ transfers: [], ...state });
    const n = greedyStep.transfers.length;
    holdStep.writeup = isCloudFF
      ? `Hold this gameweek instead of using ${n === 1 ? "a transfer" : `${n} transfers`} now - waiting pays off more over the next couple of gameweeks than spending it here.`
      : `Hold this gameweek instead of using ${n === 1 ? "a transfer" : `${n} transfers`} now - banking pays off more over the next couple of gameweeks than spending it here.`;
    const forcedHold: StepBranch = { step: holdStep, state, soldIds: holdSoldIds, boughtIds: holdBoughtIds };

    return { greedy, forcedHold };
  }

  /**
   * Full-horizon path search: at every step, tries both the greedy pick
   * AND (when one exists) the forced-hold alternative, recurses into the
   * rest of the plan from each, and scores each COMPLETE 3-step path by
   * its total realized points (each step's optimal-XI total plus that
   * step's own transfer costs, using that step's own fixed score map - the
   * same score maps regardless of path, so totals across different paths
   * are directly comparable). This is a bounded tree search (at most 2^3=8
   * full paths for GAMEWEEK_PLAN_LENGTH=3, collapsing to fewer whenever a
   * step naturally holds), not literal backward induction - a full
   * Bellman-style solve isn't tractable over a combinatorial transfer
   * action space, so this is the standard practical stand-in: evaluate
   * whole candidate paths and keep the best, rather than committing
   * greedily one step at a time the way the plan used to. If
   * GAMEWEEK_PLAN_LENGTH ever grows, this needs a beam-width cap to stay
   * bounded - fine at 3 steps, not at, say, 10.
   */
  function enumeratePlanPaths(
    offset: number,
    state: SearchState,
    soldIds: Set<number>,
    boughtIds: Set<number>
  ): { steps: GameweekPlanStep[]; totalScore: number }[] {
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

    const paths = enumeratePlanPaths(1, initialState, new Set(), new Set());
    if (paths.length === 0) return [];
    let best = paths[0];
    for (const p of paths) {
      if (p.totalScore > best.totalScore) best = p;
    }
    return best.steps;
  }

  /**
   * A single independent snapshot search - unlike searchBestMoves (which
   * chains multiple legs together into one sequential plan), this only
   * ever proposes ONE leg, evaluated fresh against the squad's real
   * current state. Used to build each of the "favoured moves" below so
   * they're genuine alternatives to pick between, not steps of each other.
   * No pair-bundling here deliberately - favoured moves are meant to be
   * simple, presentable single swaps; the budget-pooled pair search stays
   * exclusive to the sequential plan above.
   */
  function findBestSingleMove(
    scoreMapForStep: Map<number, number>,
    workingSquad: WorkingSquadPlayer[],
    workingSquadIds: Set<number>,
    workingBudget: number,
    workingClubCounts: Map<number, number>,
    freeRemaining: number,
    wildcardActive: boolean
  ): { move: SlotMove; gain: number; cost: number } | null {
    const poolCandidates: TransferCandidate[] = (pool ?? []).map((p) => ({
      gamePlayerId: p.game_player_id,
      fullName: p.full_name,
      teamId: p.team_id,
      teamName: p.team_name,
      price: Number(p.price),
      score: avgFor(scoreMapForStep, p.game_player_id),
      position: p.position,
      formStatus: p.formStatus,
    }));
    const currentXITotal = optimalXITotal(workingSquad, scoreMapForStep);

    let best: { move: SlotMove; gain: number } | null = null;
    for (const outPlayer of workingSquad) {
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
          position: outPlayer.position,
        },
        workingSquadIds,
        workingBudget,
        workingClubCounts,
        rules.max_per_club
      );
      for (const match of legalCandidates.slice(0, 20)) {
        const hypotheticalSquad = workingSquad.filter((p) => p.game_player_id !== outPlayer.game_player_id).concat(toWorkingSquadPlayer(match.candidate));
        const gain = optimalXITotal(hypotheticalSquad, scoreMapForStep) - currentXITotal;
        if (!best || gain > best.gain) {
          best = { move: buildLegInput(outPlayer, match.candidate, outScore, gain), gain };
        }
      }
    }
    if (!best || best.gain <= 0) return null;
    const cost = transferCost(freeRemaining, wildcardActive);
    if (best.gain + cost <= 0) return null; // doesn't clear its own cost
    return { move: best.move, gain: best.gain, cost };
  }

  // The reusable core of "prepare for / fund a target": given ONE
  // specific target (already known, not ranked/discovered here), searches
  // for every real, immediately-appliable route onto the squad: (1) the
  // target directly replaces one of the squad's own players in the SAME
  // position - the only kind of swap the squad's fixed position quotas
  // allow, so this is mandatory, not optional, and its sale value is real
  // cash toward the price; (2) if that alone isn't enough, ONE further
  // legal downgrade elsewhere in the squad to close the remaining gap.
  // Both legs are validated sequentially through the same
  // findLegalReplacementsForOutgoing legality engine every other transfer
  // surface in this app uses - leg 2 is checked against the squad/budget/
  // club-count state AFTER leg 1, the same way applyRecommendation itself
  // validates a bundle - PLUS a final holistic club-count check across
  // both legs together (routeClubCountsLegal below), since a leg's own
  // pairwise check only ever validates its own incoming player's club,
  // not a third player's (e.g. selling a DIFFERENT club's player to fund
  // a target whose own club is already at cap must still be rejected -
  // only a same-club secondary sale can legally cure that, and this is
  // how a legitimate one gets found rather than a false positive).
  // Every fully-legal route found is scored with the same weighted
  // recommendation model every other Ask Mary move is judged by
  // (scoreMoveCandidates), and the highest-scoring one wins - not just
  // whichever was found first, and not just whichever costs the fewest
  // realized points, so this reflects projection gain, opportunity,
  // price efficiency and the active strategy weighting together, same as
  // every other move in this file. When nothing closes the gap, also
  // reports the closest legal attempt found (see TargetFundingShortfall)
  // so the caller can show a truthful number instead of guessing. Shared
  // by both findPrepareForTargetMove (auto-discovers a target from the
  // pool below) and the user-driven "Fund a Target" workflow
  // (explicitTargetGamePlayerId), which calls this directly with a
  // player the user picked themselves - same search, same legality
  // engine, not two implementations.
  function findFundingPathForTarget(
    target: { gamePlayerId: number; fullName: string; teamId: number; teamName: string; price: number; position: "GK" | "DEF" | "MID" | "FWD" },
    workingSquad: WorkingSquadPlayer[]
  ): TargetPlanResult {
    const notReachable: TargetPlanResult = { move: null, closestShortfall: null };
    if (planningGameweek == null) return notReachable;

    const quickWinScoreMap = stepScoreMaps[0] ?? new Map();
    const currentXITotal = optimalXITotal(workingSquad, quickWinScoreMap);

    const targetCandidate: TransferCandidate = {
      gamePlayerId: target.gamePlayerId,
      fullName: target.fullName,
      teamId: target.teamId,
      teamName: target.teamName,
      price: target.price,
      position: target.position,
      score: avgFor(quickWinScoreMap, target.gamePlayerId),
    };

    function toCandidate(p: WorkingSquadPlayer): TransferCandidate {
      return {
        gamePlayerId: p.game_player_id,
        fullName: p.full_name,
        teamId: p.team_id,
        teamName: p.team_name,
        price: p.price,
        position: p.position,
        score: avgFor(quickWinScoreMap, p.game_player_id),
      };
    }

    // Holistic final check across the WHOLE route (not incremental map
    // bookkeeping) - every club's final count, computed fresh from the
    // real starting clubCounts, must respect the cap. Catches the case a
    // single-leg pairwise check structurally can't: a third club (the
    // target's) breaching its cap because of what a DIFFERENT leg's own
    // check never looks at.
    function routeClubCountsLegal(removed: { team_id: number }[], added: { teamId: number }[]): boolean {
      if (rules.max_per_club == null) return true;
      const counts = new Map(clubCounts);
      for (const r of removed) counts.set(r.team_id, (counts.get(r.team_id) ?? 0) - 1);
      for (const a of added) counts.set(a.teamId, (counts.get(a.teamId) ?? 0) + 1);
      for (const c of counts.values()) if (c > rules.max_per_club) return false;
      return true;
    }

    type RouteCandidate = {
      primaryOut: WorkingSquadPlayer;
      secondaryOut: WorkingSquadPlayer | null;
      secondaryIn: TransferCandidate | null;
      pointCost: number;
      // Sequential attribution (same principle as findBestPairBundle) -
      // primaryGain is measured against the squad before either leg,
      // secondaryGain (if present) against the squad primaryGain already
      // left behind, so each leg's expectedPointsGain fed into
      // scoreMoveCandidates below is the real starting-XI-aware value,
      // not a raw score delta that could overstate a bench-only swap.
      primaryGain: number;
      secondaryGain: number | null;
    };
    const routeCandidates: RouteCandidate[] = [];
    let closestGap = Infinity;
    let closest: { primaryOut: WorkingSquadPlayer; secondaryOut: WorkingSquadPlayer | null; secondaryIn: TransferCandidate | null } | null = null;

    for (const primaryOut of workingSquad.filter((p) => p.position === target.position)) {
      const primaryMatches = findLegalReplacementsForOutgoing([targetCandidate], toCandidate(primaryOut), squadIds, budgetRemaining, clubCounts, rules.max_per_club);

      const squadAfterPrimaryOnly = workingSquad.filter((p) => p.game_player_id !== primaryOut.game_player_id).concat(toWorkingSquadPlayer(targetCandidate));
      const xiAfterPrimaryOnly = optimalXITotal(squadAfterPrimaryOnly, quickWinScoreMap);
      const primaryGain = xiAfterPrimaryOnly - currentXITotal;

      if (primaryMatches.length > 0 && routeClubCountsLegal([primaryOut], [targetCandidate])) {
        // Reachable via this one same-position swap alone.
        routeCandidates.push({ primaryOut, secondaryOut: null, secondaryIn: null, pointCost: -primaryGain, primaryGain, secondaryGain: null });
        continue;
      }

      const budgetAfterPrimary = budgetRemaining + primaryOut.price - target.price;
      if (budgetAfterPrimary >= 0) continue; // not a cash gap - a club-limit block only a same-club secondary sale below could cure

      if (-budgetAfterPrimary < closestGap) {
        closestGap = -budgetAfterPrimary;
        closest = { primaryOut, secondaryOut: null, secondaryIn: null };
      }

      const squadIdsAfterPrimary = new Set(squadIds);
      squadIdsAfterPrimary.delete(primaryOut.game_player_id);
      squadIdsAfterPrimary.add(target.gamePlayerId);
      const clubCountsAfterPrimary = new Map(clubCounts);
      clubCountsAfterPrimary.set(primaryOut.team_id, (clubCountsAfterPrimary.get(primaryOut.team_id) ?? 0) - 1);
      clubCountsAfterPrimary.set(target.teamId, (clubCountsAfterPrimary.get(target.teamId) ?? 0) + 1);

      for (const secondaryOut of workingSquad) {
        if (secondaryOut.game_player_id === primaryOut.game_player_id) continue;
        if (secondaryOut.position === target.position) continue; // that slot's already spoken for by primaryOut/target

        const secondaryPool: TransferCandidate[] = (pool ?? [])
          .filter((p) => p.position === secondaryOut.position && p.game_player_id !== secondaryOut.game_player_id && !squadIdsAfterPrimary.has(p.game_player_id))
          .map((p) => ({
            gamePlayerId: p.game_player_id,
            fullName: p.full_name,
            teamId: p.team_id,
            teamName: p.team_name,
            price: Number(p.price),
            position: p.position,
            score: avgFor(quickWinScoreMap, p.game_player_id),
          }));

        const affordable = findLegalReplacementsForOutgoing(secondaryPool, toCandidate(secondaryOut), squadIdsAfterPrimary, budgetAfterPrimary, clubCountsAfterPrimary, rules.max_per_club);

        for (const match of affordable) {
          if (!routeClubCountsLegal([primaryOut, secondaryOut], [targetCandidate, match.candidate])) continue;
          const squadAfterBoth = squadAfterPrimaryOnly.filter((p) => p.game_player_id !== secondaryOut.game_player_id).concat(toWorkingSquadPlayer(match.candidate));
          const xiAfterBoth = optimalXITotal(squadAfterBoth, quickWinScoreMap);
          const secondaryGain = xiAfterBoth - xiAfterPrimaryOnly;
          const pointCost = currentXITotal - xiAfterBoth;
          routeCandidates.push({ primaryOut, secondaryOut, secondaryIn: match.candidate, pointCost, primaryGain, secondaryGain });
        }

        if (affordable.length === 0) {
          // Nothing at the real budget closes it - check the cheapest
          // legal (position/club-limit) candidate regardless of price,
          // purely to report an honest "still short by £X" figure.
          const anyLegal = findLegalReplacementsForOutgoing(secondaryPool, toCandidate(secondaryOut), squadIdsAfterPrimary, Infinity, clubCountsAfterPrimary, rules.max_per_club).filter((m) =>
            routeClubCountsLegal([primaryOut, secondaryOut], [targetCandidate, m.candidate])
          );
          if (anyLegal.length > 0) {
            const cheapest = anyLegal.reduce((a, b) => (b.candidate.price < a.candidate.price ? b : a));
            const freed = secondaryOut.price - cheapest.candidate.price;
            const gap = -(budgetAfterPrimary + freed);
            if (gap > 0 && gap < closestGap) {
              closestGap = gap;
              closest = { primaryOut, secondaryOut, secondaryIn: cheapest.candidate };
            }
          }
        }
      }
    }

    if (routeCandidates.length === 0) {
      if (!closest) return notReachable;
      return {
        move: null,
        closestShortfall: {
          amount: Math.round(closestGap * 10) / 10,
          primaryOutName: closest.primaryOut.full_name,
          secondaryOutName: closest.secondaryOut?.full_name ?? null,
          secondaryInName: closest.secondaryIn?.fullName ?? null,
        },
      };
    }

    // Score every fully-legal route with the same recommendation model
    // used everywhere else (not raw point cost alone) so the winner
    // reflects projection gain, opportunity, price efficiency and the
    // active strategy - and pick the highest-scoring one, not just the
    // first found. Every leg from every candidate is scored together in
    // ONE batch (not per-route) - scoreMoveCandidates min-max normalizes
    // within whatever batch it's given, so scoring routes separately
    // would make their scores incomparable to each other.
    const legBundles = routeCandidates.map((route) => ({
      primary: buildLegInput(route.primaryOut, targetCandidate, avgFor(quickWinScoreMap, route.primaryOut.game_player_id), route.primaryGain),
      secondary:
        route.secondaryOut && route.secondaryIn
          ? buildLegInput(route.secondaryOut, route.secondaryIn, avgFor(quickWinScoreMap, route.secondaryOut.game_player_id), route.secondaryGain ?? undefined)
          : null,
    }));
    const allLegInputs = legBundles.flatMap((b) => (b.secondary ? [b.primary.input, b.secondary.input] : [b.primary.input]));
    const allLegScores = scoreMoveCandidates(allLegInputs, activeStrategy);

    let scoreCursor = 0;
    const routeLegScores = legBundles.map((bundle) => {
      const primary = allLegScores[scoreCursor++];
      const secondary = bundle.secondary ? allLegScores[scoreCursor++] : null;
      return { primary, secondary };
    });

    let bestRouteIdx = 0;
    let bestRouteScore = -Infinity;
    for (let i = 0; i < routeCandidates.length; i++) {
      const { primary, secondary } = routeLegScores[i];
      const routeScore = secondary ? (primary.overall + secondary.overall) / 2 : primary.overall;
      if (routeScore > bestRouteScore) {
        bestRouteScore = routeScore;
        bestRouteIdx = i;
      }
    }

    const best = routeCandidates[bestRouteIdx];
    const bestBundle = legBundles[bestRouteIdx];
    const bestScores = routeLegScores[bestRouteIdx];

    const transfers: BundleTransfer[] = [
      {
        outGamePlayerId: bestBundle.primary.input.outGamePlayerId,
        outName: bestBundle.primary.input.outName,
        outTeam: bestBundle.primary.input.outTeam,
        outPrice: bestBundle.primary.outPlayer.price,
        inGamePlayerId: bestBundle.primary.input.inGamePlayerId,
        inName: bestBundle.primary.input.inName,
        inTeam: bestBundle.primary.input.inTeam,
        inPrice: bestBundle.primary.inCandidate.price,
        position: bestBundle.primary.input.position,
        pointsGain: Math.round(bestBundle.primary.input.expectedPointsGain * 10) / 10,
        costPoints: 0,
        risk: bestScores.primary.risk,
        confidence: bestScores.primary.confidence,
        overall: bestScores.primary.overall,
        reasons: bestScores.primary.reasons,
        warnings: bestScores.primary.warnings,
      },
    ];
    if (bestBundle.secondary && bestScores.secondary) {
      transfers.push({
        outGamePlayerId: bestBundle.secondary.input.outGamePlayerId,
        outName: bestBundle.secondary.input.outName,
        outTeam: bestBundle.secondary.input.outTeam,
        outPrice: bestBundle.secondary.outPlayer.price,
        inGamePlayerId: bestBundle.secondary.input.inGamePlayerId,
        inName: bestBundle.secondary.input.inName,
        inTeam: bestBundle.secondary.input.inTeam,
        inPrice: bestBundle.secondary.inCandidate.price,
        position: bestBundle.secondary.input.position,
        pointsGain: Math.round(bestBundle.secondary.input.expectedPointsGain * 10) / 10,
        costPoints: 0,
        risk: bestScores.secondary.risk,
        confidence: bestScores.secondary.confidence,
        overall: bestScores.secondary.overall,
        reasons: bestScores.secondary.reasons,
        warnings: bestScores.secondary.warnings,
      });
    }

    const totalGain = Math.round(-best.pointCost * 10) / 10;
    let writeup: string;
    if (best.secondaryOut && best.secondaryIn) {
      const gapClosed = best.secondaryOut.price - best.secondaryIn.price;
      writeup = `${best.primaryOut.full_name} → ${target.fullName} needs an extra £${gapClosed.toFixed(1)}m, freed by also selling ${best.secondaryOut.full_name} → ${best.secondaryIn.fullName}. ${totalGain >= 0 ? "+" : ""}${totalGain.toFixed(1)} pts to your starting XI this week.`;
    } else {
      writeup = `${target.fullName} directly replaces ${best.primaryOut.full_name} (£${best.primaryOut.price.toFixed(1)}m) - already affordable with your current budget, no further sale needed. ${totalGain >= 0 ? "+" : ""}${totalGain.toFixed(1)} pts to your starting XI this week.`;
    }

    return {
      move: {
        kind: "prepare_for_target",
        label: "Prepare for a Target",
        transfers,
        hold: false,
        horizonGameweeks: 5,
        projectedGainOverHorizon: totalGain,
        writeup,
        targetPlayer: { gamePlayerId: target.gamePlayerId, fullName: target.fullName, teamName: target.teamName, price: target.price },
      },
      closestShortfall: null,
    };
  }

  /**
   * "Prepare for a Target" - the 5th favoured move, and the only one that
   * looks beyond what's legally affordable right now. Auto-discovers a
   * target: ranks the top 15 currently-unaffordable pool players by
   * 5-GW score, then tries findFundingPathForTarget against each in
   * order until one is genuinely reachable via a single downgrade.
   */
  function findPrepareForTargetMove(workingSquad: WorkingSquadPlayer[]): FavouredMove | null {
    if (planningGameweek == null) return null;

    const targetCandidates = (pool ?? [])
      .filter((p) => !squadIds.has(p.game_player_id))
      .map((p) => ({
        gamePlayerId: p.game_player_id,
        fullName: p.full_name,
        teamId: p.team_id,
        teamName: p.team_name,
        price: Number(p.price),
        position: p.position,
        score: avgFor(fiveGwMap, p.game_player_id),
      }))
      .filter((c) => c.price > budgetRemaining) // already affordable outright - not a "prepare" case
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    for (const target of targetCandidates) {
      const result = findFundingPathForTarget(target, workingSquad);
      if (result.move) return result.move;
    }
    return null;
  }

  /**
   * The "5 favoured moves" - genuinely different single-move options for
   * THIS gameweek, each computed independently from the squad's real
   * current state (not chained, unlike gameweekPlan): the best move judged
   * over the next gameweek only, the best judged over the next 3, the best
   * judged over the next 5, doing nothing at all, and (when a real one
   * exists) a downgrade that sets up an otherwise-unaffordable target.
   * Deduplicated by outgoing/incoming pair - if the same swap tops more
   * than one horizon, it's only shown once (as the shortest horizon it
   * appeared under), rather than presented as if it were 2-3 distinct
   * ideas.
   */
  function buildFavouredMoves(): FavouredMove[] {
    if (planningGameweek == null) return [];
    const workingSquad: WorkingSquadPlayer[] = squadPlayers.map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      position: p.position,
      team_id: p.team_id,
      team_name: p.team_name,
      price: p.price,
    }));
    const wildcardActiveNow = isWildcardActive(planningGameweek, squad.wildcard_1_used_gameweek ?? null, squad.wildcard_2_used_gameweek ?? null);
    const quickWinScoreMap = stepScoreMaps[0] ?? new Map();

    function toFavouredMove(kind: FavouredMoveKind, label: string, horizonGameweeks: number, result: ReturnType<typeof findBestSingleMove>): FavouredMove | null {
      if (!result) return null;
      const score = scoreMoveCandidates([result.move.input], activeStrategy)[0];
      const leg: BundleTransfer = {
        outGamePlayerId: result.move.input.outGamePlayerId,
        outName: result.move.input.outName,
        outTeam: result.move.input.outTeam,
        outPrice: result.move.outPlayer.price,
        inGamePlayerId: result.move.input.inGamePlayerId,
        inName: result.move.input.inName,
        inTeam: result.move.input.inTeam,
        inPrice: result.move.inCandidate.price,
        inFormStatus: result.move.inCandidate.formStatus ?? null,
        position: result.move.input.position,
        pointsGain: Math.round(result.gain * 10) / 10,
        costPoints: result.cost,
        risk: score.risk,
        confidence: score.confidence,
        overall: score.overall,
        reasons: score.reasons,
        warnings: score.warnings,
      };
      const netGain = Math.round((result.gain + result.cost) * 10) / 10;
      const horizonPhrase = horizonGameweeks === 1 ? "next gameweek" : `next ${horizonGameweeks} gameweeks`;
      const writeup = `${leg.outName} → ${leg.inName}: projected ${netGain >= 0 ? "+" : ""}${netGain} pts over the ${horizonPhrase}${leg.costPoints < 0 ? " (after the -4 hit)" : ""}.`;
      return { kind, label, transfers: [leg], hold: false, horizonGameweeks, projectedGainOverHorizon: netGain, writeup };
    }

    const moves: FavouredMove[] = [];
    const seenSignatures = new Set<string>();
    function pushIfNew(mv: FavouredMove | null) {
      if (!mv) return;
      const sig = mv.hold ? "hold" : `${mv.transfers[0].outGamePlayerId}:${mv.transfers[0].inGamePlayerId}`;
      if (seenSignatures.has(sig)) return;
      seenSignatures.add(sig);
      moves.push(mv);
    }

    pushIfNew(
      toFavouredMove(
        "quick_win",
        "Quick Win - Next Gameweek",
        1,
        findBestSingleMove(quickWinScoreMap, workingSquad, squadIds, budgetRemaining, clubCounts, freeTransfersBanked, wildcardActiveNow)
      )
    );
    pushIfNew(
      toFavouredMove(
        "momentum_3gw",
        "Momentum - Next 3 Gameweeks",
        3,
        findBestSingleMove(threeGwMap, workingSquad, squadIds, budgetRemaining, clubCounts, freeTransfersBanked, wildcardActiveNow)
      )
    );
    pushIfNew(
      toFavouredMove(
        "long_term_5gw",
        "Long-Term - Next 5 Gameweeks",
        5,
        findBestSingleMove(fiveGwMap, workingSquad, squadIds, budgetRemaining, clubCounts, freeTransfersBanked, wildcardActiveNow)
      )
    );

    const holdFreeAfter = accrueFreeTransfers(freeTransfersBanked);
    pushIfNew({
      kind: "hold",
      label: "Hold",
      transfers: [],
      hold: true,
      horizonGameweeks: 1,
      projectedGainOverHorizon: 0,
      writeup: seasonStarted
        ? `Make no transfers this gameweek - banks your free transfer, giving you ${holdFreeAfter} available before the next gameweek.`
        : "Hold for now - transfers are free and unlimited before kickoff, so there's no cost to waiting for late team news.",
    });

    pushIfNew(findPrepareForTargetMove(workingSquad));

    return moves;
  }

  // "Fund a Target" - the user-driven counterpart to
  // findPrepareForTargetMove above: instead of Mary auto-discovering a
  // target from the top of the pool, the caller names one explicitly
  // (a player they picked themselves). Reuses findFundingPathForTarget
  // directly - same search, same legality engine, no separate
  // implementation. Returns null (not an error) when the named player
  // can't be found in this game's pool, or when no funding path exists -
  // the caller decides how to present "not reachable right now."
  function buildTargetPlan(explicitTargetGamePlayerId: number): TargetPlanResult | null {
    const targetRow = (pool ?? []).find((p) => p.game_player_id === explicitTargetGamePlayerId);
    if (!targetRow || squadIds.has(targetRow.game_player_id)) return null;
    const workingSquad: WorkingSquadPlayer[] = squadPlayers.map((p) => ({
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      position: p.position,
      team_id: p.team_id,
      team_name: p.team_name,
      price: p.price,
    }));
    return findFundingPathForTarget(
      {
        gamePlayerId: targetRow.game_player_id,
        fullName: targetRow.full_name,
        teamId: targetRow.team_id,
        teamName: targetRow.team_name,
        price: Number(targetRow.price),
        position: targetRow.position,
      },
      workingSquad
    );
  }

  const gameweekPlan = buildGameweekPlan();
  const favouredMoves = buildFavouredMoves();
  const targetPlan = explicitTargetGamePlayerId != null ? buildTargetPlan(explicitTargetGamePlayerId) : null;

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

  // Cloud FF's real captain rule - one per match-day, not per gameweek
  // (see MatchDayCaptainPick's own comment above). bestCaptain/viceCaptain
  // above are untouched and keep serving every other game's picker.
  let captainsByMatchDay: MatchDayCaptainPick[] = [];
  if (isCloudFF && planningGameweek !== null) {
    const matchDays = await getMatchDaysForSquad(
      supabase,
      fanteamGame.id,
      squad.id,
      planningGameweek,
      planningGameweek + GAMEWEEK_PLAN_LENGTH - 1
    );
    captainsByMatchDay = matchDays.map((day) => {
      const auto = resolveAutoPick(day);
      const ranked = day.eligiblePlayers
        .map((p) => ({ game_player_id: p.gamePlayerId, full_name: p.fullName, team_name: p.teamName, score: avgForCaptain(p.gamePlayerId) }))
        .sort((a, b) => b.score - a.score);
      const captain = auto
        ? { game_player_id: auto.captain.gamePlayerId, full_name: auto.captain.fullName, team_name: auto.captain.teamName, score: avgForCaptain(auto.captain.gamePlayerId) }
        : (ranked[0] ?? null);
      return {
        matchDate: day.matchDate,
        gameweek: day.gameweek,
        captain,
        vice: auto ? null : (ranked[1] ?? null),
        autoPicked: auto !== null,
      };
    });
  }

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
    favouredMoves,
    targetPlan,
    bestCaptain,
    viceCaptain,
    captainsByMatchDay,
    health,
    monitorList,
  };
}

export { toPredictionRow };
