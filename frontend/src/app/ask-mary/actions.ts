"use server";

import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { toPredictionRow, type PredictionRecord } from "@/lib/predictionArchive";

/**
 * Records a batch of predictions from one Ask Mary analysis, which now
 * spans all three planning horizons (1/3/5 GW) plus a captain pick in a
 * single call - grouped by (planning horizon, kind) since each group is
 * its own distinct "analysis" that should archive once, not once per
 * page view. A batch-wide dedupe would be wrong here: the captain pick
 * is tagged horizon=1 regardless of which horizon the transfer groups
 * used, so it needs its own existence check separate from the transfer/
 * hold group that happens to share that same horizon number. Predictions
 * are otherwise immutable - no update path exists (see migration 0033).
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
    const first = group[0];
    const { data: existing } = await supabase
      .from("predictions")
      .select("id")
      .eq("user_id", user.id)
      .eq("squad_id", first.squadId)
      .eq("gameweek", first.gameweek)
      .eq("algorithm_version_id", first.algorithmVersionId)
      .eq("planning_horizon", first.planningHorizon)
      .eq("strategy", first.strategy)
      .eq("kind", first.kind)
      .limit(1)
      .maybeSingle();
    if (existing) continue;

    const rows = group.map((r) => toPredictionRow(r, user.id));
    const { error } = await supabase.from("predictions").insert(rows);
    if (error) return { error: error.message };
    recorded += rows.length;
  }

  return { recorded };
}
