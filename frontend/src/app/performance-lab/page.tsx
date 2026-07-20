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
import { runAskMaryAnalysis } from "@/lib/askMaryEngine";
import { recordPredictions } from "@/app/ask-mary/actions";

// Reflects whatever the pipeline's evaluate_predictions.py just graded -
// same "never serve a stale cached response" reasoning as every other
// data-driven page in this app.
export const dynamic = "force-dynamic";

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

export default async function PerformanceLabPage({
  searchParams,
}: {
  searchParams: Promise<{ squad?: string }>;
}) {
  const { squad: squadParam } = await searchParams;

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const header = (
    <div>
      <h1 className="text-2xl font-semibold text-white">Mary Performance Lab</h1>
      <p className="mt-1 text-sm text-navy-300">
        Every recommendation Ask Mary has made, measured against what actually happened.
      </p>
    </div>
  );

  const { data: allSquadsRaw } = await supabase
    .from("squads")
    .select("id, name, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek, fantasy_games(id, slug, display_name)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  type SquadWithGame = {
    id: number;
    name: string;
    free_transfers: number;
    wildcard_1_used_gameweek: number | null;
    wildcard_2_used_gameweek: number | null;
    fantasy_games: { id: number; slug: string; display_name: string };
  };
  const allSquads = (allSquadsRaw ?? []) as unknown as SquadWithGame[];
  const squadNameById = new Map(allSquads.map((s) => [s.id, s.name]));

  if (allSquads.length === 0) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-6">
            <p className="text-sm text-navy-300">
              You don&apos;t have any squads yet.{" "}
              <Link href="/squads" className="text-sky-400 hover:text-sky-300">
                Build one
              </Link>{" "}
              - Ask Mary&apos;s recommendations get archived here automatically for every squad you have.
            </p>
          </div>
        </main>
      </div>
    );
  }

  // Keep every FanTeam squad's predictions current whenever this page is
  // visited, not just squads the user happened to open Ask Mary for
  // directly - runAskMaryAnalysis silently skips a squad with an invalid
  // composition, and recordPredictions dedupes per (gameweek, horizon,
  // kind), so revisiting this page is cheap once everything's current.
  // Dream Team has no live projections pipeline yet (no real calendar/
  // scrape source - a longstanding, documented gap elsewhere in this
  // app), so only FanTeam squads get analysed here.
  const fanteamSquads = allSquads.filter((s) => s.fantasy_games.slug === "fanteam");
  if (fanteamSquads.length > 0) {
    const fanteamGame = { id: fanteamSquads[0].fantasy_games.id, display_name: fanteamSquads[0].fantasy_games.display_name };
    await Promise.all(
      fanteamSquads.map((s) =>
        runAskMaryAnalysis(
          supabase,
          {
            id: s.id,
            name: s.name,
            free_transfers: s.free_transfers,
            wildcard_1_used_gameweek: s.wildcard_1_used_gameweek,
            wildcard_2_used_gameweek: s.wildcard_2_used_gameweek,
          },
          fanteamGame,
          "balanced",
          1,
          recordPredictions
        ).catch(() => null)
      )
    );
  }

  const { data: predictionsRaw } = await supabase
    .from("predictions")
    .select(
      "id, squad_id, gameweek, algorithm_version_id, strategy, planning_horizon, kind, recommendation_type, rank, mary_move_score, confidence, risk, expected_gain, created_at, out_game_player_id, in_game_player_id, captain_game_player_id, vice_captain_game_player_id"
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .returns<PredictionRow[]>();

  const allPredictions = predictionsRaw ?? [];

  if (allPredictions.length === 0) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-6">
            <p className="text-sm text-navy-300">
              No predictions yet - your squad{fanteamSquads.length === 1 ? "" : "s"} may still be mid-analysis, or
              incomplete (Ask Mary needs a full, valid squad to work from). Visit{" "}
              <Link href="/ask-mary" className="text-sky-400 hover:text-sky-300">
                Ask Mary
              </Link>{" "}
              to check.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const squadIdsInvolved = Array.from(new Set(allPredictions.map((p) => p.squad_id)));

  const selectedSquadId = squadParam ? Number(squadParam) : null;
  const predictions = selectedSquadId != null ? allPredictions.filter((p) => p.squad_id === selectedSquadId) : allPredictions;

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

  // "Did the user actually make this move" - reconciled at read time
  // against the real transfer/captain history rather than a stored flag,
  // so it stays honest even for predictions logged before this feature
  // existed. Matched on (squad, players) only, not gameweek - a move
  // applied a little later than Mary suggested it still counts as
  // "applied".
  const { data: transfersRaw } = await supabase
    .from("squad_transfers")
    .select("squad_id, out_game_player_id, in_game_player_id")
    .in("squad_id", squadIdsInvolved);
  const appliedTransferKeys = new Set((transfersRaw ?? []).map((t) => `${t.squad_id}:${t.out_game_player_id}:${t.in_game_player_id}`));

  const { data: captainHistoryRaw } = await supabase
    .from("squad_captain_history")
    .select("squad_id, captain_game_player_id, vice_captain_game_player_id")
    .in("squad_id", squadIdsInvolved);
  const appliedCaptainKeys = new Set(
    (captainHistoryRaw ?? []).map((c) => `${c.squad_id}:${c.captain_game_player_id}:${c.vice_captain_game_player_id}`)
  );

  const rows: PredictionEvalRow[] = predictions.map((p) => {
    const ev = evaluationByPredictionId.get(p.id);
    let applied: boolean | null = null;
    if (p.kind === "transfer") {
      applied = appliedTransferKeys.has(`${p.squad_id}:${p.out_game_player_id}:${p.in_game_player_id}`);
    } else if (p.kind === "captain") {
      applied = appliedCaptainKeys.has(`${p.squad_id}:${p.captain_game_player_id}:${p.vice_captain_game_player_id}`);
    }
    return {
      id: p.id,
      squadId: p.squad_id,
      squadName: squadNameById.get(p.squad_id) ?? `Squad #${p.squad_id}`,
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
      applied,
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

  const bySquad = breakdownBy(rows, (r) => String(r.squadId), (k) => squadNameById.get(Number(k)) ?? `Squad #${k}`);
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

  // A "Best Transfer" recommendation can bundle more than one simultaneous
  // transfer (see lib/askMaryEngine.ts) - each leg is its own predictions
  // row (sharing recommendation_type/planning_horizon/gameweek/kind), so
  // group them back into one history entry with a single "Recommendation
  // Followed" verdict (every leg applied) rather than showing each leg's
  // applied badge separately, which read as N separate recommendations
  // instead of the one bundle the user actually saw and could apply.
  const historyGroups = (() => {
    const byKey = new Map<string, PredictionEvalRow[]>();
    for (const r of rows) {
      const key = `${r.squadId}:${r.gameweek}:${r.planningHorizon}:${r.kind}:${r.recommendationType}`;
      const list = byKey.get(key) ?? [];
      list.push(r);
      byKey.set(key, list);
    }
    return Array.from(byKey.values())
      .map((legsUnsorted) => {
        const legs = legsUnsorted.slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
        const first = legs[0];
        const applied = legs.some((l) => l.applied != null) ? legs.every((l) => l.applied === true) : null;
        const totalActualGain = legs.every((l) => l.evaluation?.actualGain != null)
          ? legs.reduce((sum, l) => sum + (l.evaluation!.actualGain ?? 0), 0)
          : null;
        const allEvaluated = legs.every((l) => l.evaluation != null);
        return { key: `${first.squadId}:${first.gameweek}:${first.planningHorizon}:${first.kind}:${first.recommendationType}`, first, legs, applied, totalActualGain, allEvaluated };
      })
      .sort((a, b) => new Date(b.first.createdAt).getTime() - new Date(a.first.createdAt).getTime());
  })();

  // Grouped by game (FanTeam / Dream Team) rather than one flat list -
  // shows every squad the user has, not just ones with predictions
  // already archived, so a brand-new or Dream Team squad is still
  // visible even before (or without) an analysis existing for it.
  const squadsByGame = new Map<string, SquadWithGame[]>();
  for (const s of allSquads) {
    const list = squadsByGame.get(s.fantasy_games.display_name) ?? [];
    list.push(s);
    squadsByGame.set(s.fantasy_games.display_name, list);
  }

  const squadSelector = (
    <div className="mb-4 flex flex-col gap-2">
      <Link
        href="/performance-lab"
        prefetch={false}
        className={`self-start rounded-md px-2.5 py-1 text-xs font-medium ${
          selectedSquadId == null ? "bg-sky-500 text-navy-950" : "bg-navy-900 text-navy-300 hover:text-white"
        }`}
      >
        All Squads
      </Link>
      {Array.from(squadsByGame.entries()).map(([gameDisplayName, squadsForGame]) => (
        <div key={gameDisplayName} className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-wide text-navy-500">{gameDisplayName}</span>
          {squadsForGame.map((s) => (
            <Link
              key={s.id}
              href={`/performance-lab?squad=${s.id}`}
              prefetch={false}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                selectedSquadId === s.id ? "bg-sky-500 text-navy-950" : "bg-navy-900 text-navy-300 hover:text-white"
              } ${!squadIdsInvolved.includes(s.id) ? "opacity-50" : ""}`}
              title={!squadIdsInvolved.includes(s.id) ? "No predictions for this squad yet" : undefined}
            >
              {s.name}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-5xl">
        {header}
        <div className="mt-4">{squadSelector}</div>

        <section className="mt-2">
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
            <Tile label="Suggestions Followed" value={formatPct(summary.applicationRate)} sub="of transfer/captain picks" />
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
          <BreakdownTable title="By Squad" rows={bySquad} />
          <BreakdownTable title="By Strategy" rows={byStrategy} />
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
                      <span className="rounded-full bg-navy-700 px-2 py-0.5 font-medium text-white">{r.squadName}</span>
                      <span className="rounded-full bg-navy-800 px-2 py-0.5 font-medium uppercase tracking-wide text-sky-400">
                        {titleCase(r.recommendationType)}
                      </span>
                      <span className="text-navy-500">
                        GW{r.gameweek ?? "-"} - {titleCase(r.strategy)} - {r.planningHorizon} GW horizon
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {g.applied != null && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            g.applied ? "bg-sky-950 text-sky-400" : "bg-navy-800 text-navy-400"
                          }`}
                        >
                          {g.applied ? "✅ Recommendation Followed" : "❌ Recommendation Not Followed"}
                        </span>
                      )}
                      {g.allEvaluated ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            r.kind === "transfer"
                              ? (g.totalActualGain ?? 0) >= 0
                                ? "bg-emerald-950 text-emerald-400"
                                : "bg-red-950 text-red-400"
                              : r.evaluation?.captainSuccess
                                ? "bg-emerald-950 text-emerald-400"
                                : "bg-red-950 text-red-400"
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
                          {playerName(leg.outGamePlayerId)} -&gt; {playerName(leg.inGamePlayerId)}
                        </p>
                      ))}
                    {r.kind === "captain" && (
                      <p className="text-sm text-white">
                        Captain: {playerName(r.captainGamePlayerId)} (vice: {playerName(r.viceCaptainGamePlayerId)})
                      </p>
                    )}
                    {r.kind === "hold" && <p className="text-sm text-white">No transfer recommended</p>}
                  </div>
                  {r.evaluation && r.evaluation.errorAttribution.length > 0 && (
                    <p className="mt-1 text-xs text-navy-400">{r.evaluation.errorAttribution.map(titleCase).join(", ")}</p>
                  )}
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
