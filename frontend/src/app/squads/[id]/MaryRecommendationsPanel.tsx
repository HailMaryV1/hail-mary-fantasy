import Link from "next/link";
import type { AskMaryAnalysis } from "@/lib/askMaryEngine";
import GameweekPlanRow from "@/app/ask-mary/GameweekPlanRow";

/**
 * Compact "Mary's Recommendations" summary at the top of the Transfers
 * page - the user is already in a transfer mindset here, so they
 * shouldn't have to navigate to /ask-mary to see or act on Mary's advice.
 *
 * Purely presentational - `analysis` is computed exactly ONCE by the
 * parent squad page (squads/[id]/page.tsx) and passed down to both this
 * panel AND CaptainPicker's "Recommended" banner. This used to run
 * runAskMaryAnalysis a second time, independently, which could silently
 * disagree with both /ask-mary's own display and CaptainPicker's
 * separate recommendation. See squads/[id]/page.tsx for the single
 * source of truth this now reads from.
 */
export default function MaryRecommendationsPanel({
  squadId,
  gameId,
  gameSlug,
  analysis,
}: {
  squadId: number;
  gameId: number;
  gameSlug: string;
  analysis: AskMaryAnalysis | null;
}) {
  if (!analysis) return null;

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Mary&apos;s Recommendations</h2>
        <Link href={`/ask-mary?squad=${squadId}`} className="text-xs font-medium text-sky-400 hover:text-sky-300">
          View Full Analysis →
        </Link>
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {analysis.gameweekPlan.map((step) => (
          <GameweekPlanRow key={step.offset} step={step} squadId={squadId} gameId={gameId} gameSlug={gameSlug} />
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
