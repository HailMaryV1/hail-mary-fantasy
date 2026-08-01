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
    const { data: inserted, error } = await supabase
      .from("predictions")
      .insert(rows)
      .select("id, gameweek, kind, rank, out_game_player_id, in_game_player_id, captain_game_player_id, vice_captain_game_player_id");
    if (error) {
      if (error.code === "23505") continue; // already recorded - not an error
      return { error: error.message };
    }
    recorded += rows.length;

    // Decision Snapshot Architecture (migration 0078) - freezes each
    // involved player's full projections.inputs at the exact moment this
    // recommendation became real, since projections.inputs gets
    // overwritten in place on every later recompute. Never fatal to the
    // primary predictions insert above, which has already succeeded.
    if (inserted && inserted.length > 0) {
      try {
        await captureModuleSnapshots(supabase, inserted, group);
      } catch (err) {
        console.error("captureModuleSnapshots failed (non-fatal):", err);
      }
    }
  }

  return { recorded };
}

/**
 * Correlates a returned `predictions` row back to the `PredictionRecord`
 * it came from - deliberately NOT by array position (Postgres/PostgREST
 * order-preservation for a multi-row INSERT...RETURNING is not something
 * to depend on). `(gameweek, kind, rank, out/in/captain/vice player ids)`
 * is a real, established key - a subset of the exact columns
 * `predictions_dedup_key` (migration 0041) already enforces uniqueness
 * over - so it's guaranteed unique within one insert batch, computed
 * identically on the outbound record and the returned row.
 */
function correlationKey(
  gameweek: number | null,
  kind: string,
  rank: number | null,
  outId: number | null,
  inId: number | null,
  captainId: number | null,
  viceId: number | null
): string {
  return [gameweek ?? -1, kind, rank ?? -1, outId ?? -1, inId ?? -1, captainId ?? -1, viceId ?? -1].join(":");
}

type InsertedPredictionRow = {
  id: number;
  gameweek: number | null;
  kind: string;
  rank: number | null;
  out_game_player_id: number | null;
  in_game_player_id: number | null;
  captain_game_player_id: number | null;
  vice_captain_game_player_id: number | null;
};

async function captureModuleSnapshots(
  supabase: Awaited<ReturnType<typeof createAuthServerClient>>,
  insertedRows: InsertedPredictionRow[],
  sourceRecords: PredictionRecord[]
) {
  const sourceByKey = new Map(
    sourceRecords.map((r) => [
      correlationKey(r.gameweek, r.kind, r.rank, r.outGamePlayerId, r.inGamePlayerId, r.captainGamePlayerId, r.viceCaptainGamePlayerId),
      r,
    ])
  );

  type Target = { predictionId: number; gamePlayerId: number; role: "out" | "in" | "captain" | "vice_captain"; gameweek: number; algorithmVersionId: number };
  const targets: Target[] = [];

  for (const row of insertedRows) {
    const source = sourceByKey.get(
      correlationKey(row.gameweek, row.kind, row.rank, row.out_game_player_id, row.in_game_player_id, row.captain_game_player_id, row.vice_captain_game_player_id)
    );
    if (!source || row.gameweek == null || source.algorithmVersionId == null) continue;

    const pairs: { role: Target["role"]; gamePlayerId: number | null }[] =
      row.kind === "transfer"
        ? [
            { role: "out", gamePlayerId: row.out_game_player_id },
            { role: "in", gamePlayerId: row.in_game_player_id },
          ]
        : row.kind === "captain"
          ? [
              { role: "captain", gamePlayerId: row.captain_game_player_id },
              { role: "vice_captain", gamePlayerId: row.vice_captain_game_player_id },
            ]
          : []; // hold - nothing to snapshot

    for (const { role, gamePlayerId } of pairs) {
      if (gamePlayerId == null) continue;
      targets.push({ predictionId: row.id, gamePlayerId, role, gameweek: row.gameweek, algorithmVersionId: source.algorithmVersionId });
    }
  }

  if (targets.length === 0) return;

  const gamePlayerIds = Array.from(new Set(targets.map((t) => t.gamePlayerId)));
  const gameweeks = Array.from(new Set(targets.map((t) => t.gameweek)));
  const algorithmVersionId = targets[0].algorithmVersionId; // constant per recordPredictions() call - all records share one baseContext

  const { data: projectionRows } = await supabase
    .from("projections")
    .select("game_player_id, gameweek, hail_mary_score, inputs")
    .eq("algorithm_version_id", algorithmVersionId)
    .in("game_player_id", gamePlayerIds)
    .in("gameweek", gameweeks);

  const projectionByKey = new Map((projectionRows ?? []).map((p) => [`${p.game_player_id}:${p.gameweek}`, p]));

  const snapshotRows = targets
    .map((t) => {
      const proj = projectionByKey.get(`${t.gamePlayerId}:${t.gameweek}`);
      if (!proj) {
        console.warn(`captureModuleSnapshots: no projection found for game_player_id=${t.gamePlayerId} gameweek=${t.gameweek} algorithm_version_id=${t.algorithmVersionId} - skipping`);
        return null;
      }
      return {
        prediction_id: t.predictionId,
        game_player_id: t.gamePlayerId,
        player_role: t.role,
        gameweek: t.gameweek,
        algorithm_version_id: t.algorithmVersionId,
        snapshot_score: proj.hail_mary_score,
        inputs: proj.inputs,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (snapshotRows.length === 0) return;

  const { error } = await supabase.from("prediction_module_snapshots").insert(snapshotRows);
  if (error) console.error("captureModuleSnapshots insert failed (non-fatal):", error.message);
}
