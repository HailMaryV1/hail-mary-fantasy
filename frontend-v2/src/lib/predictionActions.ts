"use server";

import { createAuthServerClient } from "./supabaseServerClient";
import { toPredictionRow, type PredictionRecord } from "./predictionArchive";

/**
 * Records a batch of predictions from one Ask Mary analysis - grouped by
 * (planning horizon, kind, recommendationType) since each group is its
 * own distinct "analysis" that should archive once, not once per page
 * view. Shared across every game's Ask Mary (Dream Team first, FanTeam/
 * Cloud FF later) - nothing here is game-specific. Predictions are
 * otherwise immutable - no update path exists (see migration 0033).
 *
 * Existence is enforced by the `predictions_dedup_key` unique index
 * (migration 0041), not a SELECT-before-INSERT check - two near-
 * simultaneous calls for the same analysis both pass a SELECT before
 * either INSERT commits, which would duplicate every leg of a batch. A
 * unique-violation (23505) means "this exact batch was already
 * recorded" - expected, not an error.
 *
 * Deliberately does not capture prediction_module_snapshots (migration
 * 0078's Decision Snapshot Architecture, present in the old frontend) -
 * scoped out for this pass, see the Ask Mary port plan.
 */
export async function recordPredictions(records: PredictionRecord[]) {
  if (records.length === 0) return { recorded: 0 };

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const byGroup = new Map<string, PredictionRecord[]>();
  for (const r of records) {
    const key = `${r.planningHorizon}:${r.kind}:${r.recommendationType}`;
    const list = byGroup.get(key) ?? [];
    list.push(r);
    byGroup.set(key, list);
  }

  let recorded = 0;
  for (const group of byGroup.values()) {
    const rows = group.map((r) => toPredictionRow(r, user.id));
    const { error } = await supabase.from("predictions").insert(rows);
    if (error) {
      if (error.code === "23505") continue; // already recorded - not an error
      return { error: error.message };
    }
    recorded += rows.length;
  }

  return { recorded };
}
