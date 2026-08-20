// Reads the modular projection engine's own breakdown (see
// scripts/compute_projections.py - module_detail, opportunity_detail,
// data_confidence, module_scenarios, reconciliation, all persisted into
// projections.inputs by that script, exposed via player_projection_summary
// - migration 0066) into a typed shape any page can render. Built as a
// shared layer deliberately - the Engine Validation page
// (app/algorithm-explain) is the first consumer, but Ask Mary or any
// future page ("why does Mary like this player") should read the exact
// same resolved breakdown rather than re-deriving it.

import type { SupabaseClient } from "@supabase/supabase-js";

export const MODULE_NAMES = [
  "historical_performance",
  "fixture_model",
  "bookmaker_intelligence",
  "recent_form",
  "fantasy_influence",
] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

export const MODULE_DISPLAY_NAMES: Record<ModuleName, string> = {
  historical_performance: "Historical Performance",
  fixture_model: "Fixture Model",
  bookmaker_intelligence: "Bookmaker Intelligence",
  recent_form: "Recent Form",
  fantasy_influence: "Fantasy Influence",
};

export const MODULAR_STATS = ["goal", "assist", "clean_sheet_60min", "shot_on_target"] as const;
export type ModularStat = (typeof MODULAR_STATS)[number];

export const STAT_DISPLAY_NAMES: Record<ModularStat, string> = {
  goal: "Goals",
  assist: "Assists",
  clean_sheet_60min: "Clean Sheet",
  shot_on_target: "Shots On Target",
};

// "Expected X" phrasing for the simple bookmaker-literal view - distinct
// from STAT_DISPLAY_NAMES (used for the dense per-module breakdown),
// since "Expected Goals 0.42" reads naturally where "Goals 0.42" doesn't.
export const EXPECTED_STAT_DISPLAY_NAMES: Record<ModularStat, string> = {
  goal: "Expected Goals",
  assist: "Expected Assists",
  clean_sheet_60min: "Clean Sheet Chance",
  shot_on_target: "Expected Shots On Target",
};

export type BookmakerDataSource = "real" | "estimated" | "unavailable";

export type ModuleDetailEntry = {
  rawRate: number | null;
  configuredWeight: number;
  effectiveWeight: number;
  // Additive across modules for a given stat - these sum back to that
  // stat's own contribution to the final score. NOT the same thing as a
  // "what if only this module decided" scenario score (see
  // ModuleScenarios below) - never conflate the two labels.
  weightedPointContribution: number | null;
};

export type StatDetail = {
  finalRate: number;
  pointsEach: number | null;
  modules: Record<ModuleName, ModuleDetailEntry>;
  bookmakerDataSource: BookmakerDataSource;
};

export type ModuleDetailScope = { isPrimaryFixtureOnly: boolean; fixtureCount: number };

export type DataConfidence = { score: number; label: "High" | "Medium" | "Low" };

export type ReconciliationCheck = {
  expected: number;
  actual: number;
  difference: number;
  tolerance: number;
  passed: boolean;
};

export type Reconciliation = {
  primaryFixtureCheck: ReconciliationCheck;
  fullScoreCheck: ReconciliationCheck;
  modularSum: number;
  nonModularSum: number;
  bonus: number;
  primaryFixtureSubtotal: number;
  additionalFixturesSubtotal: number;
  preAvailabilityTotal: number;
  availabilityMultiplier: number;
  finalScore: number;
};

// "If this player also features in a further fixture this gameweek" -
// e.g. a Carabao Cup tie landing in the same window as the primary
// Premier League fixture. Deliberately NOT part of hail_mary_score/
// finalScore (see compute_projections.py) - shown as separate upside,
// already rotation-risk-discounted per fixture (cup/short-turnaround
// fixtures get ROTATION_CONGESTION_DISCOUNT applied to their own
// contribution before reaching here).
export type AdditionalFixtures = {
  count: number;
  combinedContribution: number;
  fixtures: { fixtureId: number; kickoffAt: string; competition: string | null; contribution: number }[];
};

// "THIS IS THE FIXTURE" - the primary (earliest, hail_mary_score-scoring)
// fixture for this gameweek, for the simple explainability view's header.
export type PrimaryFixture = {
  fixtureId: number;
  kickoffAt: string;
  competition: string | null;
  opponentTeamName: string | null;
  isHome: boolean;
};

const COMPETITION_LABELS: Record<string, string> = {
  soccer_epl: "Premier League",
  soccer_fa_cup: "FA Cup",
  soccer_england_efl_cup: "Carabao Cup",
  soccer_uefa_champs_league: "Champions League",
  soccer_uefa_europa_league: "Europa League",
  soccer_uefa_europa_conference_league: "Conference League",
};

export function competitionLabel(competition: string | null): string {
  if (!competition) return "Unknown competition";
  return COMPETITION_LABELS[competition] ?? competition.replace(/^soccer_/, "").replace(/_/g, " ");
}

export type PlayerStatus = { lineup: string | null; status: string | null; multiplier: number };

// Opportunity Model (Phase A) - see compute_opportunity() in
// scripts/compute_projections.py. Playing-time only (start probability,
// substitute probability, opportunity in minutes) - never event-rate
// quality. Present only for v2 games' primary fixture (module_detail_scope
// applies here too - same "primary fixture only" simplification).
// footballUncertainty is deliberately null - Phase A only models
// STRUCTURAL confidence (sample size + live-status coverage); the
// football-uncertainty axis (rotation/tactical volatility) has nothing
// real to measure from until a later phase's team-level rotation model.
export type OpportunityDetail = {
  pStart: number;
  pStartHistorical: number;
  pAppearIfNotStarted: number;
  opportunityIfStart: number;
  opportunityIfSub: number;
  earlySubstitutionRisk: number | null;
  startShareProxy: number;
  pAppear: number;
  p60Plus: number;
  pFullMatch: number;
  isTransferred: boolean;
  isCongested: boolean;
  isBackupGoalkeeper: boolean;
  liveStatusApplied: boolean;
  structuralConfidence: number;
  footballUncertainty: number | null;
};

// Recent Form - see compute_recent_form_stat()/build_recent_form_rates()
// in scripts/compute_projections.py. Recency-weighted (calendar gameweek
// distance, NOT appearance count - a player's pre-injury form goes stale
// while they're absent) then shrunk toward this player's OWN Historical
// Performance rate (never a position average - see the architectural
// review's §07 for why). finalShrunkRate always lies between
// historicalPriorRate and rawRecencyWeightedRate. A stat is absent
// entirely (not zero-filled) whenever it has no real observations this
// window - goal/assist availability are independent (one stat's data
// existing never implies the other's does).
export type RecentFormStatDetail = {
  rawUnweightedRate: number;
  rawRecencyWeightedRate: number;
  historicalPriorRate: number;
  finalShrunkRate: number;
  observedWeight: number;
  priorWeight: number;
  // Signed diagnostic: finalShrunkRate - rawRecencyWeightedRate. Negative
  // when the historical prior sits below the observed rate (shrinkage
  // pulls the number down), positive when the prior sits above it, and
  // exactly 0 at k_recent=0 (no shrinkage applied at all).
  priorPull: number;
  effectiveWeightedMinutes: number;
  effectiveGames90: number;
  observedAppearancesForStat: number;
  oldestGameweekUsed: number;
  newestGameweekUsed: number;
};

export type RecentFormDetail = {
  goal: RecentFormStatDetail | null;
  assist: RecentFormStatDetail | null;
  lookbackGameweeks: number;
  decay: number;
  kRecent: number;
  decayBasis: string;
  playingAppearancesInWindow: number;
  // Deliberately not built yet - team_fixture_difficulty is an
  // unsnapshotted view and every real query path reading its sources
  // lacks a computed_at <= kickoff_at filter (confirmed live: real rows
  // already have a post-kickoff computed_at) - an absent diagnostic
  // here, not a historically inaccurate one.
  scheduleStrength: number | null;
  scheduleStrengthSource: string;
};

// Fantasy Influence (Phase A) - see build_fantasy_influence_detail() in
// scripts/compute_projections.py. The renamed "Player Role V2" - a
// RATIO to the position average (unbounded), not a share of team
// output (bounded - the structural flaw that got V1 retired). Configured
// weight is 0 for every position in both games (migration 0076) - this
// is real, computed data, visible for validation, but contributes
// nothing to finalScore. goalScalingIndex/assistScalingIndex are
// leave-one-out blends (shot share + the OTHER outcome stat's
// involvement) - deliberately never include that same stat's own
// involvement index, so neither multiplier is derived from the rate it
// scales.
export type FantasyInfluenceDetail = {
  goalInvolvementIdx: number | null;
  assistInvolvementIdx: number | null;
  shotShareIdx: number | null;
  goalScalingIndex: number | null;
  assistScalingIndex: number | null;
  games90: number;
  sampleConfidence: number;
};

// "What if only this module had decided goal/assist/clean-sheet, with
// everything else (saves, cards, bonus...) left exactly as actually
// projected" - a full scenario total in the SAME units as the final
// score, but NOT additive across modules (each one re-includes the same
// non-modular points). Never label this "contribution" on its own - see
// ModuleDetailEntry.weightedPointContribution for the additive view.
export type ModuleScenarios = Partial<Record<ModuleName, number | null>>;

export type EngineExplanation = {
  gameSlug: string;
  gamePlayerId: number;
  fullName: string;
  teamName: string;
  position: string;
  price: number;
  gameweek: number | null;
  finalScore: number;
  pointsPer90: number;
  gamesNinety: number;
  explanation: string;
  status: PlayerStatus;
  expectedMinutesFraction: number | null;
  opportunityDetail: OpportunityDetail | null;
  recentFormDetail: RecentFormDetail | null;
  fantasyInfluenceDetail: FantasyInfluenceDetail | null;
  moduleDetailScope: ModuleDetailScope;
  moduleDetail: Partial<Record<ModularStat, StatDetail>> | null;
  moduleScenarios: ModuleScenarios;
  dataConfidence: DataConfidence;
  reconciliation: Reconciliation | null;
  additionalFixtures: AdditionalFixtures;
  primaryFixture: PrimaryFixture | null;
};

type RawRecentFormStatDetail = {
  raw_unweighted_rate: number; raw_recency_weighted_rate: number; historical_prior_rate: number;
  final_shrunk_rate: number; observed_weight: number; prior_weight: number; prior_pull: number;
  effective_weighted_minutes: number; effective_games90: number; observed_appearances_for_stat: number;
  oldest_gameweek_used: number; newest_gameweek_used: number;
};

type RawInputs = {
  points_per_90?: number;
  games90?: number;
  explanation?: string;
  status?: { lineup: string | null; status: string | null; multiplier: number };
  expected_minutes_fraction?: number | null;
  opportunity_detail?: {
    p_start: number; p_start_historical: number; p_appear_if_not_started: number;
    opportunity_if_start: number; opportunity_if_sub: number; early_substitution_risk: number | null;
    start_share_proxy: number; p_appear: number; p_60_plus: number; p_full_match: number;
    is_transferred: boolean; is_congested: boolean; is_backup_goalkeeper: boolean; live_status_applied: boolean;
    structural_confidence: number; football_uncertainty: number | null;
  } | null;
  recent_form_detail?: {
    goal?: RawRecentFormStatDetail; assist?: RawRecentFormStatDetail;
    lookback_gameweeks: number; decay: number; k_recent: number; decay_basis: string;
    playing_appearances_in_window: number;
    schedule_strength: number | null; schedule_strength_source: string;
  } | null;
  fantasy_influence_detail?: {
    goal_involvement_idx: number | null; assist_involvement_idx: number | null; shot_share_idx: number | null;
    goal_scaling_index: number | null; assist_scaling_index: number | null;
    games90: number; sample_confidence: number;
  } | null;
  module_detail_scope?: { is_primary_fixture_only: boolean; fixture_count: number };
  fixtures?: {
    fixture_id: number; kickoff_at: string; competition: string | null;
    opponent_team_name: string | null; is_home: boolean;
  }[];
  additional_fixtures?: {
    count: number;
    combined_contribution: number;
    fixtures: { fixture_id: number; kickoff_at: string; competition: string | null; contribution: number }[];
  };
  module_detail?: Record<string, { final_rate: number; points_each: number | null; modules: Record<string, {
    raw_rate: number | null; configured_weight: number; effective_weight: number; weighted_point_contribution: number | null;
  }>; bookmaker_data_source: BookmakerDataSource }> | null;
  module_scenarios?: Record<string, number | null>;
  data_confidence?: { score: number; label: "High" | "Medium" | "Low" };
  reconciliation?: {
    primary_fixture_check: { expected: number; actual: number; difference: number; tolerance: number; passed: boolean };
    full_score_check: { expected: number; actual: number; difference: number; tolerance: number; passed: boolean };
    modular_sum: number; non_modular_sum: number; bonus: number; primary_fixture_subtotal: number;
    additional_fixtures_subtotal: number; pre_availability_total: number; availability_multiplier: number; final_score: number;
  } | null;
};

export type SummaryRow = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_name: string;
  price: number;
  hail_mary_score: number;
  gameweek: number | null;
  inputs: RawInputs | null;
};

function parseModuleDetail(raw: RawInputs["module_detail"]): EngineExplanation["moduleDetail"] {
  if (!raw) return null;
  const out: EngineExplanation["moduleDetail"] = {};
  for (const stat of MODULAR_STATS) {
    const detail = raw[stat];
    if (!detail) continue;
    const modules = {} as Record<ModuleName, ModuleDetailEntry>;
    for (const module of MODULE_NAMES) {
      const m = detail.modules[module];
      modules[module] = {
        rawRate: m?.raw_rate ?? null,
        configuredWeight: m?.configured_weight ?? 0,
        effectiveWeight: m?.effective_weight ?? 0,
        weightedPointContribution: m?.weighted_point_contribution ?? null,
      };
    }
    out[stat] = {
      finalRate: detail.final_rate,
      pointsEach: detail.points_each,
      modules,
      bookmakerDataSource: detail.bookmaker_data_source,
    };
  }
  return out;
}

function parseRecentFormStatDetail(raw: RawRecentFormStatDetail | undefined): RecentFormStatDetail | null {
  if (!raw) return null;
  return {
    rawUnweightedRate: raw.raw_unweighted_rate,
    rawRecencyWeightedRate: raw.raw_recency_weighted_rate,
    historicalPriorRate: raw.historical_prior_rate,
    finalShrunkRate: raw.final_shrunk_rate,
    observedWeight: raw.observed_weight,
    priorWeight: raw.prior_weight,
    priorPull: raw.prior_pull,
    effectiveWeightedMinutes: raw.effective_weighted_minutes,
    effectiveGames90: raw.effective_games90,
    observedAppearancesForStat: raw.observed_appearances_for_stat,
    oldestGameweekUsed: raw.oldest_gameweek_used,
    newestGameweekUsed: raw.newest_gameweek_used,
  };
}

export function parseEngineExplanation(gameSlug: string, row: SummaryRow): EngineExplanation | null {
  if (!row.inputs) return null;
  const inputs = row.inputs;
  return {
    gameSlug,
    gamePlayerId: row.game_player_id,
    fullName: row.full_name,
    teamName: row.team_name,
    position: row.position,
    price: Number(row.price),
    gameweek: row.gameweek,
    finalScore: Number(row.hail_mary_score),
    pointsPer90: inputs.points_per_90 ?? 0,
    gamesNinety: inputs.games90 ?? 0,
    explanation: inputs.explanation ?? "",
    status: inputs.status ?? { lineup: null, status: null, multiplier: 1 },
    expectedMinutesFraction: inputs.expected_minutes_fraction ?? null,
    opportunityDetail: inputs.opportunity_detail
      ? {
          pStart: inputs.opportunity_detail.p_start,
          pStartHistorical: inputs.opportunity_detail.p_start_historical,
          pAppearIfNotStarted: inputs.opportunity_detail.p_appear_if_not_started,
          opportunityIfStart: inputs.opportunity_detail.opportunity_if_start,
          opportunityIfSub: inputs.opportunity_detail.opportunity_if_sub,
          earlySubstitutionRisk: inputs.opportunity_detail.early_substitution_risk,
          startShareProxy: inputs.opportunity_detail.start_share_proxy,
          pAppear: inputs.opportunity_detail.p_appear,
          p60Plus: inputs.opportunity_detail.p_60_plus,
          pFullMatch: inputs.opportunity_detail.p_full_match,
          isTransferred: inputs.opportunity_detail.is_transferred,
          isCongested: inputs.opportunity_detail.is_congested,
          isBackupGoalkeeper: inputs.opportunity_detail.is_backup_goalkeeper,
          liveStatusApplied: inputs.opportunity_detail.live_status_applied,
          structuralConfidence: inputs.opportunity_detail.structural_confidence,
          footballUncertainty: inputs.opportunity_detail.football_uncertainty,
        }
      : null,
    recentFormDetail: inputs.recent_form_detail
      ? {
          goal: parseRecentFormStatDetail(inputs.recent_form_detail.goal),
          assist: parseRecentFormStatDetail(inputs.recent_form_detail.assist),
          lookbackGameweeks: inputs.recent_form_detail.lookback_gameweeks,
          decay: inputs.recent_form_detail.decay,
          kRecent: inputs.recent_form_detail.k_recent,
          decayBasis: inputs.recent_form_detail.decay_basis,
          playingAppearancesInWindow: inputs.recent_form_detail.playing_appearances_in_window,
          scheduleStrength: inputs.recent_form_detail.schedule_strength,
          scheduleStrengthSource: inputs.recent_form_detail.schedule_strength_source,
        }
      : null,
    fantasyInfluenceDetail: inputs.fantasy_influence_detail
      ? {
          goalInvolvementIdx: inputs.fantasy_influence_detail.goal_involvement_idx,
          assistInvolvementIdx: inputs.fantasy_influence_detail.assist_involvement_idx,
          shotShareIdx: inputs.fantasy_influence_detail.shot_share_idx,
          goalScalingIndex: inputs.fantasy_influence_detail.goal_scaling_index,
          assistScalingIndex: inputs.fantasy_influence_detail.assist_scaling_index,
          games90: inputs.fantasy_influence_detail.games90,
          sampleConfidence: inputs.fantasy_influence_detail.sample_confidence,
        }
      : null,
    moduleDetailScope: inputs.module_detail_scope
      ? { isPrimaryFixtureOnly: inputs.module_detail_scope.is_primary_fixture_only, fixtureCount: inputs.module_detail_scope.fixture_count }
      : { isPrimaryFixtureOnly: true, fixtureCount: 1 },
    moduleDetail: parseModuleDetail(inputs.module_detail),
    moduleScenarios: (inputs.module_scenarios ?? {}) as ModuleScenarios,
    dataConfidence: inputs.data_confidence ?? { score: 0, label: "Low" },
    reconciliation: inputs.reconciliation
      ? {
          primaryFixtureCheck: {
            expected: inputs.reconciliation.primary_fixture_check.expected,
            actual: inputs.reconciliation.primary_fixture_check.actual,
            difference: inputs.reconciliation.primary_fixture_check.difference,
            tolerance: inputs.reconciliation.primary_fixture_check.tolerance,
            passed: inputs.reconciliation.primary_fixture_check.passed,
          },
          fullScoreCheck: {
            expected: inputs.reconciliation.full_score_check.expected,
            actual: inputs.reconciliation.full_score_check.actual,
            difference: inputs.reconciliation.full_score_check.difference,
            tolerance: inputs.reconciliation.full_score_check.tolerance,
            passed: inputs.reconciliation.full_score_check.passed,
          },
          modularSum: inputs.reconciliation.modular_sum,
          nonModularSum: inputs.reconciliation.non_modular_sum,
          bonus: inputs.reconciliation.bonus,
          primaryFixtureSubtotal: inputs.reconciliation.primary_fixture_subtotal,
          additionalFixturesSubtotal: inputs.reconciliation.additional_fixtures_subtotal,
          preAvailabilityTotal: inputs.reconciliation.pre_availability_total,
          availabilityMultiplier: inputs.reconciliation.availability_multiplier,
          finalScore: inputs.reconciliation.final_score,
        }
      : null,
    additionalFixtures: inputs.additional_fixtures
      ? {
          count: inputs.additional_fixtures.count,
          combinedContribution: inputs.additional_fixtures.combined_contribution,
          fixtures: inputs.additional_fixtures.fixtures.map((fx) => ({
            fixtureId: fx.fixture_id,
            kickoffAt: fx.kickoff_at,
            competition: fx.competition,
            contribution: fx.contribution,
          })),
        }
      : { count: 0, combinedContribution: 0, fixtures: [] },
    primaryFixture: inputs.fixtures?.[0]
      ? {
          fixtureId: inputs.fixtures[0].fixture_id,
          kickoffAt: inputs.fixtures[0].kickoff_at,
          competition: inputs.fixtures[0].competition,
          opponentTeamName: inputs.fixtures[0].opponent_team_name,
          isHome: inputs.fixtures[0].is_home,
        }
      : null,
  };
}

/** Server-side fetch - one row, already-resolved current-gameweek
 * projection (player_projection_summary, migration 0062/0066), no extra
 * recomputation. Works for any game_player_id in any game with the
 * modular engine (fanteam, dreamteam) - returns null if that player has
 * no projection at all yet. */
export async function fetchEngineExplanation(
  supabase: SupabaseClient,
  gameSlug: string,
  gamePlayerId: number
): Promise<EngineExplanation | null> {
  const { data } = await supabase
    .from("player_projection_summary")
    .select("game_player_id, full_name, position, team_name, price, hail_mary_score, gameweek, inputs")
    .eq("game_slug", gameSlug)
    .eq("game_player_id", gamePlayerId)
    .maybeSingle<SummaryRow>();
  if (!data) return null;
  return parseEngineExplanation(gameSlug, data);
}

/**
 * Same shape as fetchEngineExplanation, but for an EXPLICIT gameweek
 * rather than whatever player_projection_summary's own current_gw lateral
 * considers "current" (migration 0129 - the smallest gameweek whose
 * EARLIEST fixture hasn't kicked off). Real user report 2026-08-21: EFL
 * Fantasy's own per-player locking (eflFixtureLocking.ts) can legitimately
 * disagree with that shared view - a single rearranged fixture kicking
 * off doesn't end the gameweek for EFL Fantasy the way it does for the
 * other 3 games - so the pool/squad board correctly held on GW2 while
 * this panel, reading the shared view, jumped ahead to GW3.
 *
 * Bypasses player_projection_summary entirely (two plain queries instead
 * of its current_gw join) rather than editing that view - it's shared by
 * every game, and only EFL Fantasy's own callers pass a gameweek here.
 */
export async function fetchEngineExplanationForGameweek(
  supabase: SupabaseClient,
  gameSlug: string,
  gamePlayerId: number,
  gameweek: number
): Promise<EngineExplanation | null> {
  const [{ data: playerRow }, { data: projRow }] = await Promise.all([
    supabase
      .from("game_players")
      .select("id, position_code, price, players(full_name, teams(name))")
      .eq("id", gamePlayerId)
      .single<{ id: number; position_code: string; price: number; players: { full_name: string; teams: { name: string } } }>(),
    supabase
      .from("projections")
      .select("hail_mary_score, gameweek, inputs")
      .eq("game_player_id", gamePlayerId)
      .eq("gameweek", gameweek)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ hail_mary_score: number; gameweek: number; inputs: RawInputs | null }>(),
  ]);
  if (!playerRow || !projRow) return null;

  const row: SummaryRow = {
    game_player_id: playerRow.id,
    full_name: playerRow.players.full_name,
    position: playerRow.position_code,
    team_name: playerRow.players.teams.name,
    price: Number(playerRow.price),
    hail_mary_score: Number(projRow.hail_mary_score),
    gameweek: projRow.gameweek,
    inputs: projRow.inputs,
  };
  return parseEngineExplanation(gameSlug, row);
}

export type PlayerOption = { gamePlayerId: number; fullName: string; teamName: string; position: string; price: number };

/** Full player list for a game, for the search/select control - small
 * enough (a few hundred rows) to filter entirely client-side rather than
 * round-tripping on every keystroke. */
export async function fetchPlayerOptions(supabase: SupabaseClient, gameSlug: string): Promise<PlayerOption[]> {
  const { data } = await supabase
    .from("player_projection_summary")
    .select("game_player_id, full_name, team_name, position, price")
    .eq("game_slug", gameSlug)
    .order("full_name");
  return (data ?? []).map((r) => ({
    gamePlayerId: r.game_player_id,
    fullName: r.full_name,
    teamName: r.team_name,
    position: r.position,
    price: Number(r.price),
  }));
}

export function confidenceTone(label: DataConfidence["label"]): string {
  if (label === "High") return "bg-emerald-950 text-emerald-400";
  if (label === "Medium") return "bg-amber-950 text-amber-400";
  return "bg-red-950 text-red-400";
}

export function dataSourceTone(source: BookmakerDataSource): string {
  if (source === "real") return "bg-emerald-950 text-emerald-400";
  if (source === "estimated") return "bg-amber-950 text-amber-400";
  return "bg-navy-800 text-navy-400";
}

export function dataSourceLabel(source: BookmakerDataSource): string {
  if (source === "real") return "Real market data";
  if (source === "estimated") return "Estimated from a scaled baseline";
  return "Unavailable - no market data ingested yet";
}
