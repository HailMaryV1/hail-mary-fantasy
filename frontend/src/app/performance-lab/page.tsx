import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import {
  computeLifetimeSummary,
  breakdownBy,
  compareAlgorithmVersions,
  compareTwoVersions,
  type PredictionEvalRow,
} from "@/lib/performanceAnalytics";

// Reflects whatever the pipeline's evaluate_predictions.py just graded -
// same "never serve a stale cached response" reasoning as every other
// data-driven page in this app.
export const dynamic = "force-dynamic";

type PredictionRow = {
  id: number;
  gameweek: number | null;
  algorithm_version_id: number | null;
  strategy: string;
  planning_horizon: number;
  kind: "transfer" | "captain" | "hold";
  recommendation_type: string;
  mary_move_score: number | null;
  confidence: number | null;
  risk: string | null;
  expected_gain: number | null;
  created_at: string;
  out_game_player_id: number | null;
  in_game_player_id: number | null;
  captain_game_player_id: number | null;
  vice_captain_game_player_id: number | null;
};

type EvaluationRow = {
  prediction_id: number;
  actual_gain: number | null;
  prediction_error: number | null;
  transfer_success: boolean | null;
  captain_actual_points: number | null;
  vice_captain_actual_points: number | null;
  captain_success: boolean | null;
  error_attribution: string[];
};

function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPct(v: number | null) {
  return v == null ? "-" : `${Math.round(v * 100)}%`;
}

function formatPts(v: number | null) {
  return v == null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
}

export default async function PerformanceLabPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: predictionsRaw } = await supabase
    .from("predictions")
    .select(
      "id, gameweek, algorithm_version_id, strategy, planning_horizon, kind, recommendation_type, mary_move_score, confidence, risk, expected_gain, created_at, out_game_player_id, in_game_player_id, captain_game_player_id, vice_captain_game_player_id"
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .returns<PredictionRow[]>();

  const predictions = predictionsRaw ?? [];

  const header = (
    <div>
      <h1 className="text-2xl font-semibold text-white">Mary Performance Lab</h1>
      <p className="mt-1 text-sm text-navy-300">
        Every recommendation Ask Mary has made, measured against what actually happened.
      </p>
    </div>
  );

  if (predictions.length === 0) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-6">
            <p className="text-sm text-navy-300">
              No predictions recorded yet. Visit{" "}
              <Link href="/ask-mary" className="text-sky-400 hover:text-sky-300">
                Ask Mary
              </Link>{" "}
              to generate some - every analysis Mary runs archives itself here automatically.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const predictionIds = predictions.map((p) => p.id);
  const { data: evaluationsRaw } = await supabase
    .from("prediction_evaluations")
    .select(
      "prediction_id, actual_gain, prediction_error, transfer_success, captain_actual_points, vice_captain_actual_points, captain_success, error_attribution"
    )
    .in("prediction_id", predictionIds)
    .returns<EvaluationRow[]>();
  const evaluationByPredictionId = new Map((evaluationsRaw ?? []).map((e) => [e.prediction_id, e]));

  const { data: algoVersions } = await supabase.from("algorithm_versions").select("id, version_label");
  const versionLabelById = new Map((algoVersions ?? []).map((v) => [v.id, v.version_label as string]));

  const { data: pool } = await supabase.from("game_player_pool").select("game_player_id, full_name").eq("game_slug", "fanteam");
  const nameById = new Map((pool ?? []).map((p) => [p.game_player_id, p.full_name as string]));

  const rows: PredictionEvalRow[] = predictions.map((p) => {
    const ev = evaluationByPredictionId.get(p.id);
    return {
      id: p.id,
      gameweek: p.gameweek,
      algorithmVersionId: p.algorithm_version_id,
      strategy: p.strategy,
      planningHorizon: p.planning_horizon,
      kind: p.kind,
      recommendationType: p.recommendation_type,
      maryMoveScore: p.mary_move_score,
      confidence: p.confidence,
      risk: p.risk,
      expectedGain: p.expected_gain,
      createdAt: p.created_at,
      outGamePlayerId: p.out_game_player_id,
      inGamePlayerId: p.in_game_player_id,
      captainGamePlayerId: p.captain_game_player_id,
      viceCaptainGamePlayerId: p.vice_captain_game_player_id,
      evaluation: ev
        ? {
            actualGain: ev.actual_gain,
            predictionError: ev.prediction_error,
            transferSuccess: ev.transfer_success,
            captainActualPoints: ev.captain_actual_points,
            viceCaptainActualPoints: ev.vice_captain_actual_points,
            captainSuccess: ev.captain_success,
            errorAttribution: ev.error_attribution,
          }
        : null,
    };
  });

  const summary = computeLifetimeSummary(rows);

  const byStrategy = breakdownBy(rows, (r) => r.strategy, titleCase);
  const byHorizon = breakdownBy(rows, (r) => String(r.planningHorizon), (k) => `${k} GW`);
  const byType = breakdownBy(rows, (r) => r.recommendationType, titleCase);
  const byGameweek = breakdownBy(rows, (r) => String(r.gameweek ?? "-"), (k) => (k === "-" ? "Unknown" : `GW${k}`)).sort(
    (a, b) => Number(a.key) - Number(b.key)
  );

  const versionComparison = compareAlgorithmVersions(rows, versionLabelById);
  const sortedVersions = versionComparison.slice().sort((a, b) => b.algorithmVersionId - a.algorithmVersionId);
  const verdict =
    sortedVersions.length >= 2 ? compareTwoVersions(sortedVersions[0], sortedVersions[1]) : { hasEnoughData: false, winner: null, improvement: null };

  function playerName(id: number | null) {
    if (id == null) return null;
    return nameById.get(id) ?? `#${id}`;
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-5xl">
        {header}

        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Lifetime Summary</h2>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <Tile label="Total Predictions" value={String(summary.totalPredictions)} />
            <Tile label="Evaluated Transfers" value={`${summary.evaluatedTransfers} / ${summary.transferPredictions}`} />
            <Tile label="Transfer Success Rate" value={formatPct(summary.transferSuccessRate)} />
            <Tile label="Lifetime Transfer Gain" value={formatPts(summary.lifetimeTransferGain)} />
            <Tile label="Average Expected Gain" value={formatPts(summary.averageExpectedGain)} />
            <Tile label="Average Actual Gain" value={formatPts(summary.averageActualGain)} />
            <Tile label="Prediction Bias" value={formatPts(summary.predictionBias)} sub="expected minus actual" />
            <Tile label="Captain Success Rate" value={formatPct(summary.captainSuccessRate)} />
            <Tile label="Lifetime Captain Gain" value={formatPts(summary.lifetimeCaptainGain)} sub="vs vice-captain" />
            <Tile label="Hold Calls Made" value={String(summary.holdPredictions)} />
            <Tile label="Average Confidence" value={summary.averageConfidence != null ? `${Math.round(summary.averageConfidence)}%` : "-"} />
            <Tile
              label="Algorithm Health Score"
              value={summary.algorithmHealthScore != null ? `${summary.algorithmHealthScore}/100` : "Not enough data"}
            />
          </div>
          {summary.evaluatedTransfers === 0 && (
            <p className="mt-2 text-xs text-amber-400">
              No predictions have been graded yet - that happens automatically once a gameweek completes and the
              pipeline captures real results. Gain/accuracy figures above will fill in from there.
            </p>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Version Comparison</h2>
          <div className="mt-2 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
                  <th className="px-4 py-2 font-medium">Version</th>
                  <th className="px-4 py-2 text-right font-medium">Evaluated Transfers</th>
                  <th className="px-4 py-2 text-right font-medium">Success Rate</th>
                  <th className="px-4 py-2 text-right font-medium">Average Gain</th>
                </tr>
              </thead>
              <tbody>
                {sortedVersions.map((v) => (
                  <tr key={v.algorithmVersionId} className="border-b border-navy-800 last:border-0">
                    <td className="px-4 py-2 text-white">{v.versionLabel}</td>
                    <td className="px-4 py-2 text-right text-navy-300">{v.evaluatedTransfers}</td>
                    <td className="px-4 py-2 text-right text-navy-300">{formatPct(v.successRate)}</td>
                    <td className="px-4 py-2 text-right text-navy-300">{formatPts(v.averageGain)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-navy-400">
            {verdict.hasEnoughData && verdict.winner
              ? `${verdict.winner.versionLabel} is currently outperforming by ${formatPts(verdict.improvement)} points per transfer on average.`
              : "Not enough graded predictions on at least two versions yet to declare a winner - each needs 5+ evaluated transfers."}
          </p>
        </section>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <BreakdownTable title="By Strategy" rows={byStrategy} />
          <BreakdownTable title="By Planning Horizon" rows={byHorizon} />
          <BreakdownTable title="By Recommendation Type" rows={byType} />
          <BreakdownTable title="By Gameweek" rows={byGameweek} />
        </div>

        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Recommendation History</h2>
          <div className="mt-2 flex flex-col gap-2">
            {rows.slice(0, 100).map((r) => (
              <div key={r.id} className="rounded-lg border border-navy-800 bg-navy-900 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded-full bg-navy-800 px-2 py-0.5 font-medium uppercase tracking-wide text-sky-400">
                      {titleCase(r.recommendationType)}
                    </span>
                    <span className="text-navy-500">
                      GW{r.gameweek ?? "-"} - {titleCase(r.strategy)} - {r.planningHorizon} GW horizon
                    </span>
                  </div>
                  {r.evaluation ? (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        r.kind === "transfer"
                          ? r.evaluation.transferSuccess
                            ? "bg-emerald-950 text-emerald-400"
                            : "bg-red-950 text-red-400"
                          : r.evaluation.captainSuccess
                            ? "bg-emerald-950 text-emerald-400"
                            : "bg-red-950 text-red-400"
                      }`}
                    >
                      {r.kind === "transfer" ? formatPts(r.evaluation.actualGain) : r.evaluation.captainSuccess ? "Correct" : "Incorrect"}
                    </span>
                  ) : (
                    <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[10px] font-medium text-navy-400">Awaiting result</span>
                  )}
                </div>
                <p className="mt-1.5 text-sm text-white">
                  {r.kind === "transfer" && `${playerName(r.outGamePlayerId)} -> ${playerName(r.inGamePlayerId)}`}
                  {r.kind === "captain" && `Captain: ${playerName(r.captainGamePlayerId)} (vice: ${playerName(r.viceCaptainGamePlayerId)})`}
                  {r.kind === "hold" && "No transfer recommended"}
                </p>
                {r.evaluation && r.evaluation.errorAttribution.length > 0 && (
                  <p className="mt-1 text-xs text-navy-400">{r.evaluation.errorAttribution.map(titleCase).join(", ")}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-navy-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-white">{value}</p>
      {sub && <p className="text-[10px] text-navy-500">{sub}</p>}
    </div>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: { key: string; label: string; count: number; evaluatedCount: number; successRate: number | null; averageGain: number | null }[] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-navy-500">{title}</h3>
      <div className="mt-2 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
              <th className="px-3 py-2 font-medium">{title.replace("By ", "")}</th>
              <th className="px-3 py-2 text-right font-medium">Count</th>
              <th className="px-3 py-2 text-right font-medium">Success</th>
              <th className="px-3 py-2 text-right font-medium">Avg Gain</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-navy-800 last:border-0">
                <td className="px-3 py-2 text-white">{r.label}</td>
                <td className="px-3 py-2 text-right text-navy-300">{r.count}</td>
                <td className="px-3 py-2 text-right text-navy-300">{formatPct(r.successRate)}</td>
                <td className="px-3 py-2 text-right text-navy-300">{formatPts(r.averageGain)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
