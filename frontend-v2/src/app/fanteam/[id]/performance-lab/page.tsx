import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { computeLifetimeSummary, breakdownBy, type PredictionEvalRow } from "@/lib/performanceAnalytics";

// Reflects whatever the pipeline's evaluate_predictions.py just graded -
// same "never serve a stale cached response" reasoning as every other
// data-driven page in this app.
export const dynamic = "force-dynamic";

type SquadRow = { id: number; name: string; user_id: string; fantasy_games: { slug: string } | { slug: string }[] };

type PredictionRow = {
  id: number;
  squad_id: number;
  gameweek: number | null;
  algorithm_version_id: number | null;
  strategy: string;
  planning_horizon: number;
  kind: "transfer" | "captain" | "hold";
  recommendation_type: string;
  rank: number | null;
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
  was_followed: boolean | null;
  counterfactual_player_id: number | null;
  counterfactual_actual_points: number | null;
  counterfactual_gain: number | null;
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

export default async function FanTeamPerformanceLabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const squadId = Number(id);

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: squad } = await supabase.from("squads").select("id, name, user_id, fantasy_games(slug)").eq("id", squadId).single<SquadRow>();
  if (!squad || squad.user_id !== user.id) notFound();
  const game = Array.isArray(squad.fantasy_games) ? squad.fantasy_games[0] : squad.fantasy_games;
  if (!game || game.slug !== "fanteam") notFound();

  const header = (
    <div>
      <Link href={`/fanteam/${squadId}`} className="text-sm font-medium text-navy-400 hover:text-sky-400">
        ← Back to squad
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-white">Mary Performance Lab</h1>
      <p className="mt-1 text-sm text-navy-300">Every recommendation Ask Mary has made for {squad.name}, measured against what actually happened.</p>
    </div>
  );

  const { data: predictionsRaw } = await supabase
    .from("predictions")
    .select(
      "id, squad_id, gameweek, algorithm_version_id, strategy, planning_horizon, kind, recommendation_type, rank, mary_move_score, confidence, risk, expected_gain, created_at, out_game_player_id, in_game_player_id, captain_game_player_id, vice_captain_game_player_id"
    )
    .eq("user_id", user.id)
    .eq("squad_id", squadId)
    .order("created_at", { ascending: false })
    .returns<PredictionRow[]>();

  const predictions = predictionsRaw ?? [];

  if (predictions.length === 0) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-6">
            <p className="text-sm text-navy-300">
              No predictions yet -{" "}
              <Link href={`/fanteam/${squadId}/ask-mary`} className="text-sky-400 hover:text-sky-300">
                visit Ask Mary
              </Link>{" "}
              to get a recommendation, which archives automatically.
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
      "prediction_id, actual_gain, prediction_error, transfer_success, captain_actual_points, vice_captain_actual_points, captain_success, error_attribution, was_followed, counterfactual_player_id, counterfactual_actual_points, counterfactual_gain"
    )
    .in("prediction_id", predictionIds)
    .returns<EvaluationRow[]>();
  const evaluationByPredictionId = new Map((evaluationsRaw ?? []).map((e) => [e.prediction_id, e]));

  // Looked up by the exact IDs these predictions actually reference, not
  // a whole game's pool - see the old frontend's performance-lab/page.tsx
  // for why game_player_pool can't be safely queried unfiltered
  // (PostgREST's 1,000-row default cap).
  const referencedGamePlayerIds = Array.from(
    new Set([
      ...predictions.flatMap((p) => [p.out_game_player_id, p.in_game_player_id, p.captain_game_player_id, p.vice_captain_game_player_id].filter((id): id is number => id != null)),
      ...(evaluationsRaw ?? []).map((e) => e.counterfactual_player_id).filter((id): id is number => id != null),
    ])
  );
  const { data: pool } = referencedGamePlayerIds.length > 0 ? await supabase.from("game_player_pool").select("game_player_id, full_name").in("game_player_id", referencedGamePlayerIds) : { data: [] };
  const nameById = new Map((pool ?? []).map((p) => [p.game_player_id, p.full_name as string]));

  const rows: PredictionEvalRow[] = predictions.map((p) => {
    const ev = evaluationByPredictionId.get(p.id);
    return {
      id: p.id,
      squadId: p.squad_id,
      squadName: squad.name,
      gameweek: p.gameweek,
      algorithmVersionId: p.algorithm_version_id,
      strategy: p.strategy,
      planningHorizon: p.planning_horizon,
      kind: p.kind,
      recommendationType: p.recommendation_type,
      rank: p.rank,
      maryMoveScore: p.mary_move_score,
      confidence: p.confidence,
      risk: p.risk,
      expectedGain: p.expected_gain,
      createdAt: p.created_at,
      outGamePlayerId: p.out_game_player_id,
      inGamePlayerId: p.in_game_player_id,
      captainGamePlayerId: p.captain_game_player_id,
      viceCaptainGamePlayerId: p.vice_captain_game_player_id,
      // Read directly from the gameweek-scoped grading column
      // (evaluate_predictions.py's transfer_adherence/captain_adherence,
      // migration 0085) - not the old frontend's read-time (out, in)
      // match with no gameweek check.
      applied: p.kind === "hold" ? null : (ev?.was_followed ?? null),
      evaluation: ev
        ? {
            actualGain: ev.actual_gain,
            predictionError: ev.prediction_error,
            transferSuccess: ev.transfer_success,
            captainActualPoints: ev.captain_actual_points,
            viceCaptainActualPoints: ev.vice_captain_actual_points,
            captainSuccess: ev.captain_success,
            errorAttribution: ev.error_attribution,
            counterfactualPlayerId: ev.counterfactual_player_id,
            counterfactualGain: ev.counterfactual_gain,
          }
        : null,
    };
  });

  const summary = computeLifetimeSummary(rows);

  const byHorizon = breakdownBy(rows, (r) => String(r.planningHorizon), (k) => `${k} GW`);
  const byType = breakdownBy(rows, (r) => r.recommendationType, titleCase);
  const byGameweek = breakdownBy(rows, (r) => String(r.gameweek ?? "-"), (k) => (k === "-" ? "Unknown" : `GW${k}`)).sort((a, b) => Number(a.key) - Number(b.key));

  function playerName(id: number | null) {
    if (id == null) return null;
    return nameById.get(id) ?? `#${id}`;
  }

  // A gameweek-plan step can bundle more than one simultaneous transfer
  // (see lib/fanteamAskMaryEngine.ts) - each leg is its own predictions
  // row sharing (gameweek, planningHorizon, kind, recommendationType,
  // createdAt), grouped back into one history entry here.
  const historyGroups = (() => {
    const byKey = new Map<string, PredictionEvalRow[]>();
    for (const r of rows) {
      const key = `${r.gameweek}:${r.planningHorizon}:${r.kind}:${r.recommendationType}:${r.createdAt}`;
      const list = byKey.get(key) ?? [];
      list.push(r);
      byKey.set(key, list);
    }
    return Array.from(byKey.values())
      .map((legsUnsorted) => {
        const legs = legsUnsorted.slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
        const first = legs[0];
        const applied = legs.some((l) => l.applied != null) ? legs.every((l) => l.applied === true) : null;
        const totalActualGain = legs.every((l) => l.evaluation?.actualGain != null) ? legs.reduce((sum, l) => sum + (l.evaluation!.actualGain ?? 0), 0) : null;
        const totalCounterfactualGain = legs.every((l) => l.evaluation?.counterfactualGain != null) ? legs.reduce((sum, l) => sum + (l.evaluation!.counterfactualGain ?? 0), 0) : null;
        const allEvaluated = legs.every((l) => l.evaluation != null);
        return {
          key: `${first.gameweek}:${first.planningHorizon}:${first.kind}:${first.recommendationType}:${first.createdAt}`,
          first,
          legs,
          applied,
          totalActualGain,
          totalCounterfactualGain,
          allEvaluated,
        };
      })
      .sort((a, b) => new Date(b.first.createdAt).getTime() - new Date(a.first.createdAt).getTime());
  })();

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
            <Tile label="Prediction Bias" value={formatPts(summary.predictionBias)} sub="expected minus actual" />
            <Tile label="Captain Success Rate" value={formatPct(summary.captainSuccessRate)} />
            <Tile label="Lifetime Captain Gain" value={formatPts(summary.lifetimeCaptainGain)} sub="vs vice-captain" />
            <Tile label="Hold Calls Made" value={String(summary.holdPredictions)} />
            <Tile label="Suggestions Followed" value={formatPct(summary.applicationRate)} sub="of transfer/captain picks" />
            <Tile
              label="Missed Gain/Loss"
              value={summary.totalCounterfactualGain != null ? formatPts(summary.totalCounterfactualGain) : "-"}
              sub={summary.unfollowedCount > 0 ? `${summary.unfollowedCount} not followed` : "nothing skipped yet"}
            />
            <Tile label="Algorithm Health Score" value={summary.algorithmHealthScore != null ? `${summary.algorithmHealthScore}/100` : "Not enough data"} />
          </div>
          {summary.evaluatedTransfers === 0 && (
            <p className="mt-2 text-xs text-amber-400">
              No predictions have been graded yet - that happens automatically once a gameweek deadline passes and the pipeline captures real results. Gain/accuracy figures above will fill in from
              there.
            </p>
          )}
        </section>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <BreakdownTable title="By Planning Horizon" rows={byHorizon} />
          <BreakdownTable title="By Recommendation Type" rows={byType} />
          <BreakdownTable title="By Gameweek" rows={byGameweek} />
        </div>

        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Recommendation History</h2>
          <div className="mt-2 flex flex-col gap-2">
            {historyGroups.slice(0, 100).map((g) => {
              const r = g.first;
              return (
                <div key={g.key} className="rounded-lg border border-navy-800 bg-navy-900 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full bg-navy-800 px-2 py-0.5 font-medium uppercase tracking-wide text-sky-400">{titleCase(r.recommendationType)}</span>
                      <span className="text-navy-500">
                        GW{r.gameweek ?? "-"} - {r.planningHorizon} GW horizon
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {g.applied != null && (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${g.applied ? "bg-sky-950 text-sky-400" : "bg-navy-800 text-navy-400"}`}>
                          {g.applied ? "Followed" : "Not followed"}
                        </span>
                      )}
                      {g.allEvaluated ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            r.kind === "transfer" ? ((g.totalActualGain ?? 0) >= 0 ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400") : r.evaluation?.captainSuccess ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
                          }`}
                        >
                          {r.kind === "transfer" ? formatPts(g.totalActualGain) : r.evaluation?.captainSuccess ? "Correct" : "Incorrect"}
                        </span>
                      ) : (
                        <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[10px] font-medium text-navy-400">Awaiting result</span>
                      )}
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-col gap-0.5">
                    {r.kind === "transfer" &&
                      g.legs.map((leg) => (
                        <p key={leg.id} className="text-sm text-white">
                          {playerName(leg.outGamePlayerId)} → {playerName(leg.inGamePlayerId)}
                        </p>
                      ))}
                    {r.kind === "captain" && (
                      <p className="text-sm text-white">
                        Captain: {playerName(r.captainGamePlayerId)} (vice: {playerName(r.viceCaptainGamePlayerId)})
                      </p>
                    )}
                    {r.kind === "hold" && <p className="text-sm text-white">No transfer recommended</p>}
                  </div>
                  {g.applied === false && g.totalCounterfactualGain != null && (
                    <p className="mt-1.5 text-xs text-amber-300">
                      You chose {playerName(r.evaluation?.counterfactualPlayerId ?? null) ?? "something else"} instead - that cost you {formatPts(-g.totalCounterfactualGain)} vs following Mary.
                    </p>
                  )}
                  {r.evaluation && r.evaluation.errorAttribution.length > 0 && <p className="mt-1 text-xs text-navy-400">{r.evaluation.errorAttribution.map(titleCase).join(", ")}</p>}
                </div>
              );
            })}
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
