// Reads the modular projection engine's own breakdown (see
// scripts/compute_projections.py - module_detail, player_role_detail,
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
  "player_role",
  "recent_form",
] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

export const MODULE_DISPLAY_NAMES: Record<ModuleName, string> = {
  historical_performance: "Historical Performance",
  fixture_model: "Fixture Model",
  bookmaker_intelligence: "Bookmaker Intelligence",
  player_role: "Player Role",
  recent_form: "Recent Form",
};

export const MODULAR_STATS = ["goal", "assist", "clean_sheet_60min"] as const;
export type ModularStat = (typeof MODULAR_STATS)[number];

export const STAT_DISPLAY_NAMES: Record<ModularStat, string> = {
  goal: "Goals",
  assist: "Assists",
  clean_sheet_60min: "Clean Sheet",
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

export type PlayerRoleDetail = {
  playerGoalTotal: number;
  playerAssistTotal: number;
  teamGoalTotal: number;
  teamAssistTotal: number;
  teamGoalShare: number | null;
  teamAssistShare: number | null;
  teamGoalPer90: number;
  teamAssistPer90: number;
};

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

export type PlayerStatus = { lineup: string | null; status: string | null; multiplier: number };

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
  moduleDetailScope: ModuleDetailScope;
  moduleDetail: Partial<Record<ModularStat, StatDetail>> | null;
  moduleScenarios: ModuleScenarios;
  playerRoleDetail: PlayerRoleDetail | null;
  dataConfidence: DataConfidence;
  reconciliation: Reconciliation | null;
};

type RawInputs = {
  points_per_90?: number;
  games90?: number;
  explanation?: string;
  status?: { lineup: string | null; status: string | null; multiplier: number };
  expected_minutes_fraction?: number | null;
  module_detail_scope?: { is_primary_fixture_only: boolean; fixture_count: number };
  module_detail?: Record<string, { final_rate: number; points_each: number | null; modules: Record<string, {
    raw_rate: number | null; configured_weight: number; effective_weight: number; weighted_point_contribution: number | null;
  }>; bookmaker_data_source: BookmakerDataSource }> | null;
  module_scenarios?: Record<string, number | null>;
  player_role_detail?: {
    player_goal_total: number; player_assist_total: number; team_goal_total: number; team_assist_total: number;
    team_goal_share: number | null; team_assist_share: number | null; team_goal_per90: number; team_assist_per90: number;
  } | null;
  data_confidence?: { score: number; label: "High" | "Medium" | "Low" };
  reconciliation?: {
    primary_fixture_check: { expected: number; actual: number; difference: number; tolerance: number; passed: boolean };
    full_score_check: { expected: number; actual: number; difference: number; tolerance: number; passed: boolean };
    modular_sum: number; non_modular_sum: number; bonus: number; primary_fixture_subtotal: number;
    additional_fixtures_subtotal: number; pre_availability_total: number; availability_multiplier: number; final_score: number;
  } | null;
};

type SummaryRow = {
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
    moduleDetailScope: inputs.module_detail_scope
      ? { isPrimaryFixtureOnly: inputs.module_detail_scope.is_primary_fixture_only, fixtureCount: inputs.module_detail_scope.fixture_count }
      : { isPrimaryFixtureOnly: true, fixtureCount: 1 },
    moduleDetail: parseModuleDetail(inputs.module_detail),
    moduleScenarios: (inputs.module_scenarios ?? {}) as ModuleScenarios,
    playerRoleDetail: inputs.player_role_detail
      ? {
          playerGoalTotal: inputs.player_role_detail.player_goal_total,
          playerAssistTotal: inputs.player_role_detail.player_assist_total,
          teamGoalTotal: inputs.player_role_detail.team_goal_total,
          teamAssistTotal: inputs.player_role_detail.team_assist_total,
          teamGoalShare: inputs.player_role_detail.team_goal_share,
          teamAssistShare: inputs.player_role_detail.team_assist_share,
          teamGoalPer90: inputs.player_role_detail.team_goal_per90,
          teamAssistPer90: inputs.player_role_detail.team_assist_per90,
        }
      : null,
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
