import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { runAskMaryAnalysis, ASK_MARY_HORIZONS } from "@/lib/askMaryEngine";
import BundleCard from "@/app/ask-mary/BundleCard";

/**
 * Compact "Mary's Recommendations" summary at the top of the Transfers
 * page - the user is already in a transfer mindset here, so they
 * shouldn't have to navigate to /ask-mary to see or act on Mary's advice.
 * Reuses runAskMaryAnalysis (the same engine Ask Mary itself calls)
 * rather than any separate transfer-recommendation logic, and reuses
 * BundleCard for rendering so there's exactly one recommendation UI, not
 * two. Deliberately omits recordPredictionsFn - the Ask Mary page and
 * Performance Lab's own refresh-on-visit already archive predictions on
 * every visit; wiring this page into that too would just be a second,
 * less-visible write path for no analytical benefit.
 *
 * Only rendered for FanTeam-soccer squads (see runAskMaryAnalysis's own
 * scope note) - Dream Team has no live projections pipeline and NFL
 * FanTeam has no gameweek calendar/transfer economy yet, same gating
 * every other Ask Mary/Performance Lab entry point in this app already
 * uses.
 */
export default async function MaryRecommendationsPanel({
  squad,
}: {
  squad: { id: number; name: string; free_transfers: number; wildcard_1_used_gameweek: number | null; wildcard_2_used_gameweek: number | null; game_id: number };
}) {
  const supabase = await createAuthServerClient();
  const { data: fanteamGameRow } = await supabase.from("fantasy_games").select("id, display_name").eq("id", squad.game_id).single();
  if (!fanteamGameRow) return null;

  const analysis = await runAskMaryAnalysis(supabase, squad, fanteamGameRow, "balanced", 1);
  if (!analysis) return null;

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Mary&apos;s Recommendations</h2>
        <Link href={`/ask-mary?squad=${squad.id}`} className="text-xs font-medium text-sky-400 hover:text-sky-300">
          View Full Analysis →
        </Link>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {ASK_MARY_HORIZONS.map((h) => (
          <BundleCard key={h.key} label={h.label} bundle={analysis.bundles.get(h.gameweeks)!} squadId={squad.id} gameId={fanteamGameRow.id} />
        ))}
        <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
          <h3 className="text-sm font-semibold text-white">Captain &amp; Vice-Captain</h3>
          {!analysis.bestCaptain ? (
            <p className="mt-2 text-sm text-navy-400">Set a starting XI to get captaincy advice.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2 text-sm">
              <p className="text-white">
                <span className="text-navy-500">C:</span> {analysis.bestCaptain.full_name}
              </p>
              <p className="text-white">
                <span className="text-navy-500">VC:</span> {analysis.viceCaptain?.full_name ?? "-"}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
