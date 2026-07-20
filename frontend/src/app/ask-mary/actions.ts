"use server";

import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { toPredictionRow, type PredictionRecord } from "@/lib/predictionArchive";

/**
 * Records a batch of predictions from one Ask Mary analysis. Dedupes on
 * the combination that defines "the same analysis" (squad, gameweek,
 * algorithm version, horizon, strategy) - Ask Mary recomputes on every
 * page view, but a prediction should be archived once per distinct
 * analysis, not once per view, so this checks for an existing row before
 * inserting the batch. Predictions are otherwise immutable - no update
 * path exists (see migration 0033).
 */
export async function recordPredictions(records: PredictionRecord[]) {
  if (records.length === 0) return { recorded: 0 };

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const first = records[0];
  const { data: existing } = await supabase
    .from("predictions")
    .select("id")
    .eq("user_id", user.id)
    .eq("squad_id", first.squadId)
    .eq("gameweek", first.gameweek)
    .eq("algorithm_version_id", first.algorithmVersionId)
    .eq("planning_horizon", first.planningHorizon)
    .eq("strategy", first.strategy)
    .limit(1)
    .maybeSingle();
  if (existing) return { recorded: 0, skipped: true as const };

  const rows = records.map((r) => toPredictionRow(r, user.id));
  const { error } = await supabase.from("predictions").insert(rows);
  if (error) return { error: error.message };
  return { recorded: rows.length };
}
