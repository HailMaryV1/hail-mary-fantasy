import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type ResultRow = {
  full_name: string;
  tournament_name: string;
  price: number | null;
  expected_points: number;
  actual_points: number;
  points_difference: number;
};

export default async function GolfAlgorithmPerformancePage() {
  const supabase = createServerSupabaseClient();

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
