"use server";

import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { toPredictionRow, type PredictionRecord } from "@/lib/predictionArchive";

/**
 * Records a batch of predictions from one Ask Mary analysis, which now
 * spans the whole gameweek plan plus a captain pick in a single call -
 * grouped by (planning horizon, kind) since each group is its own
 * distinct "analysis" that should archive once, not once per page view.
 * A batch-wide dedupe would be wrong here: the captain pick is tagged
 * with its own horizon regardless of which step's transfer group used
 * that same number, so it needs its own uniqueness check separate from
 * the transfer/hold group. Predictions are otherwise immutable - no
 * update path exists (see migration 0033).
 *
 * Existence is enforced by the `predictions_dedup_key` unique index
 * (migration 0041), not a SELECT-before-INSERT check - the earlier
 * check-then-act version had a race (two near-simultaneous calls, e.g.
 * from performance-lab/page.tsx re-running on every load, could both
 * pass the SELECT before either INSERT committed) that duplicated every
 * leg of a batch, visible as doubled rows in Performance Lab. A unique-
 * violation (23505) now means "this exact batch was already recorded" -
 * an expected, harmless outcome, not an error.
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
    const key = `${r.planningHorizon}:${r.kind}`;
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
