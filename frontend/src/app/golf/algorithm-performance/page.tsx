import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { computeTeamTotal, type GolfOptimizerPlayer } from "@/lib/golfTeamOptimizer";

export const dynamic = "force-dynamic";

type ResultRow = {
  full_name: string;
  tournament_name: string;
  price: number | null;
  expected_points: number;
  actual_points: number;
  points_difference: number;
};

type SquadRow = {
  id: number;
  name: string;
  golf_tournament_id: number;
  golf_captain_game_player_id: number | null;
  golf_tournaments: { name: string; event_number: number | null } | null;
  squad_players: { game_player_id: number; game_players: { golfers: { full_name: string } } | null }[];
};

type PredictionGradeRow = {
  game_player_id: number;
  price: number | null;
  expected_points: number | null;
  actual_points: number | null;
};

type TeamGrade = {
  squadId: number;
  squadName: string;
  tournamentLabel: string;
  captainName: string | null;
  expectedTotal: number;
  actualTotal: number | null;
  diff: number | null;
  pending: boolean;
};

async function fetchTeamGrades(): Promise<TeamGrade[]> {
  const authSupabase = await createAuthServerClient();
  const {
    data: { user },
  } = await authSupabase.auth.getUser();
  if (!user) return [];

  const { data: squads } = await authSupabase
    .from("squads")
    .select(
      "id, name, golf_tournament_id, golf_captain_game_player_id, golf_tournaments(name, event_number), squad_players(game_player_id, game_players(golfers(full_name)))"
    )
    .eq("user_id", user.id)
    .not("golf_tournament_id", "is", null)
    .returns<SquadRow[]>();

  // Each squad's grade is scoped to its own tournament_id/player ids, with
  // no shared state across iterations - run every squad's lookup
  // concurrently instead of one round trip at a time, then sort once at
  // the end exactly as the original sequential loop did.
  const gradeResults = await Promise.all(
    (squads ?? []).map(async (squad): Promise<TeamGrade | null> => {
      const gamePlayerIds = squad.squad_players.map((sp) => sp.game_player_id);
      if (gamePlayerIds.length === 0) return null;

      const { data: preds } = await authSupabase
        .from("golf_tournament_predictions")
        .select("game_player_id, price, expected_points, actual_points")
        .eq("tournament_id", squad.golf_tournament_id)
        .in("game_player_id", gamePlayerIds)
        .returns<PredictionGradeRow[]>();

      // No frozen prediction yet for every golfer on this team (registration
      // for that tournament hasn't closed) - nothing to grade yet, skip.
      if (!preds || preds.length !== gamePlayerIds.length) return null;

      const nameByPlayer = new Map(
        squad.squad_players.map((sp) => [sp.game_player_id, sp.game_players?.golfers?.full_name ?? "Unknown"])
      );

      const asPlayers = (points: (p: PredictionGradeRow) => number): GolfOptimizerPlayer[] =>
        preds.map((p) => ({
          gamePlayerId: p.game_player_id,
          fullName: nameByPlayer.get(p.game_player_id) ?? "Unknown",
          price: p.price != null ? Number(p.price) : 0,
          expectedPoints: points(p),
          floor: 0,
          ceiling: 0,
          makeCutProbability: null,
        }));

      const expectedResult = computeTeamTotal(
        asPlayers((p) => (p.expected_points != null ? Number(p.expected_points) : 0)),
        squad.golf_captain_game_player_id
      );

      const pending = preds.some((p) => p.actual_points == null);
      let actualTotal: number | null = null;
      let diff: number | null = null;
      if (!pending) {
        // Same captain the expected-side total used (whether stored or
        // auto-detected) - grades the team on the captain choice actually
        // in play, rather than letting "highest scorer" silently shift to a
        // different golfer once real results are in.
        const actualResult = computeTeamTotal(
          asPlayers((p) => (p.actual_points != null ? Number(p.actual_points) : 0)),
          expectedResult.captainId
        );
        actualTotal = actualResult.total;
        diff = Math.round((actualResult.total - expectedResult.total) * 100) / 100;
      }

      const tournament = squad.golf_tournaments;
      return {
        squadId: squad.id,
        squadName: squad.name,
        tournamentLabel: tournament ? `${tournament.name}${tournament.event_number ? ` · GW${tournament.event_number}` : ""}` : "Unknown",
        captainName: nameByPlayer.get(expectedResult.captainId ?? -1) ?? null,
        expectedTotal: expectedResult.total,
        actualTotal,
        diff,
        pending,
      };
    })
  );

  const grades = gradeResults.filter((g): g is TeamGrade => g !== null);
  grades.sort((a, b) => (b.actualTotal ?? b.expectedTotal) - (a.actualTotal ?? a.expectedTotal));
  return grades;
}

export default async function GolfAlgorithmPerformancePage() {
  const supabase = createServerSupabaseClient();
  const teamGrades = await fetchTeamGrades();

  const { data: rows } = await supabase
    .from("golf_tournament_predictions")
    .select(
      "price, expected_points, actual_points, points_difference, game_players(golfers(full_name)), golf_tournaments(name)"
    )
    .not("actual_points", "is", null)
    .order("actuals_captured_at", { ascending: false })
    .returns<
      {
        price: number | null;
        expected_points: number;
        actual_points: number;
        points_difference: number;
        game_players: { golfers: { full_name: string } };
        golf_tournaments: { name: string };
      }[]
    >();

  const results: ResultRow[] = (rows ?? []).map((r) => ({
    full_name: r.game_players?.golfers?.full_name ?? "Unknown",
    tournament_name: r.golf_tournaments?.name ?? "Unknown",
    price: r.price != null ? Number(r.price) : null,
    expected_points: Number(r.expected_points),
    actual_points: Number(r.actual_points),
    points_difference: Number(r.points_difference),
  }));

  const n = results.length;
  const meanAbsoluteError = n > 0 ? results.reduce((s, r) => s + Math.abs(r.points_difference), 0) / n : null;
  const bias = n > 0 ? results.reduce((s, r) => s + r.points_difference, 0) / n : null;
  const overrated = results.filter((r) => r.points_difference < -5).length;
  const underrated = results.filter((r) => r.points_difference > 5).length;
  // "Got it right" = within 5pts either way - same ±5pt threshold the
  // over/under-rated split already uses, just framed as a single
  // headline accuracy number rather than two separate miss counts.
  const withinFive = n - overrated - underrated;
  const accuracyPct = n > 0 ? (withinFive / n) * 100 : null;

  const sorted = results.slice().sort((a, b) => Math.abs(b.points_difference) - Math.abs(a.points_difference));

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <Link href="/golf" className="text-sm text-navy-400 hover:text-sky-300">
          ← FanTeam Golf
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">Algorithm Performance</h1>
        <p className="mt-1 text-sm text-navy-300">
          How Hail Mary Golf&apos;s pre-tournament calls have graded out against what actually happened - frozen
          predictions (never overwritten once a tournament starts), compared to real FanTeam points.
        </p>

        {teamGrades.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Your teams</h2>
            <p className="mt-1 text-xs text-navy-500">
              Which of your saved teams actually delivered, captain and underdog bonuses included.
            </p>
            <div className="mt-2 flex flex-col gap-2">
              {teamGrades.map((g) => (
                <div key={g.squadId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-navy-700 bg-navy-900 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-white">{g.squadName}</p>
                    <p className="text-xs text-navy-400">
                      {g.tournamentLabel}
                      {g.captainName && <span> · Captain: {g.captainName}</span>}
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    <span className="text-navy-400">Expected {g.expectedTotal.toFixed(1)}</span>
                    {g.pending ? (
                      <span className="ml-3 text-navy-500">Pending results</span>
                    ) : (
                      <>
                        <span className="ml-3 font-semibold text-white">Actual {g.actualTotal!.toFixed(1)}</span>
                        <span className={`ml-3 font-semibold ${g.diff! >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {g.diff! >= 0 ? "+" : ""}
                          {g.diff!.toFixed(1)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {n === 0 && (
          <p className="mt-8 text-sm text-navy-300">
            No completed tournaments with results yet - this page fills in once a tournament your model has
            projected finishes and{" "}
            <code className="rounded bg-navy-800 px-1 py-0.5">scripts/attach_golf_tournament_results.py</code> has
            run against it.
          </p>
        )}

        {n > 0 && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <p className="text-xs uppercase tracking-wide text-navy-400">Graded predictions</p>
                <p className="mt-1 text-xl font-semibold text-white">{n}</p>
              </div>
              <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <p className="text-xs uppercase tracking-wide text-navy-400">Got it right</p>
                <p className="mt-1 text-xl font-semibold text-emerald-400">
                  {withinFive}/{n} <span className="text-sm text-navy-400">({accuracyPct?.toFixed(0)}%)</span>
                </p>
                <p className="mt-0.5 text-[11px] text-navy-500">within ±5pts of actual</p>
              </div>
              <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <p className="text-xs uppercase tracking-wide text-navy-400">Mean absolute error</p>
                <p className="mt-1 text-xl font-semibold text-white">{meanAbsoluteError?.toFixed(1)}</p>
              </div>
              <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <p className="text-xs uppercase tracking-wide text-navy-400">Bias</p>
                <p className={`mt-1 text-xl font-semibold ${bias != null && bias > 0 ? "text-emerald-400" : "text-amber-400"}`}>
                  {bias != null && bias >= 0 ? "+" : ""}
                  {bias?.toFixed(1)}
                </p>
                <p className="mt-0.5 text-[11px] text-navy-500">{bias != null && bias < 0 ? "Overrating players on average" : "Underrating players on average"}</p>
              </div>
              <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <p className="text-xs uppercase tracking-wide text-navy-400">Big misses</p>
                <p className="mt-1 text-xl font-semibold text-white">
                  {overrated} over / {underrated} under
                </p>
                <p className="mt-0.5 text-[11px] text-navy-500">±5pt threshold</p>
              </div>
            </div>

            <div className="mt-6 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
                    <th className="px-4 py-3 font-medium">Golfer</th>
                    <th className="hidden px-4 py-3 font-medium sm:table-cell">Tournament</th>
                    <th className="px-4 py-3 text-right font-medium">Expected</th>
                    <th className="px-4 py-3 text-right font-medium">Actual</th>
                    <th className="px-4 py-3 text-right font-medium">Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr key={i} className="border-b border-navy-800 last:border-0">
                      <td className="px-4 py-3 font-medium text-white">{r.full_name}</td>
                      <td className="hidden px-4 py-3 text-navy-300 sm:table-cell">{r.tournament_name}</td>
                      <td className="px-4 py-3 text-right text-navy-300">{r.expected_points.toFixed(1)}</td>
                      <td className="px-4 py-3 text-right text-white">{r.actual_points.toFixed(1)}</td>
                      <td className={`px-4 py-3 text-right font-semibold ${r.points_difference >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {r.points_difference >= 0 ? "+" : ""}
                        {r.points_difference.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
