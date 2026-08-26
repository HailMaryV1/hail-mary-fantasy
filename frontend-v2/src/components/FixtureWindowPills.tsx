import { fixtureDifficultyTier } from "@/lib/fixtureDifficultyColor";
import type { TargetScoreWindowFixture } from "@/lib/targetScoreActions";

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// "it should show the next fixtures that occur during those gameweeks
// selected... use the difficulty pills with differing colours too"
// (2026-08-23/26 user requests) - every real fixture in the selected
// window, not just the nearest one, each tagged with a colored
// difficulty pill. Shared by TargetScoreBoard's top-5 rows and
// RatingsBrowseTable's Browse All Players rows so a fixture pill means
// the same thing everywhere it appears - a 1-gameweek window naturally
// has just one entry, so this looks like a single tagged fixture there,
// no special-casing needed.
export default function FixtureWindowPills({ fixtures }: { fixtures: TargetScoreWindowFixture[] | null }) {
  if (!fixtures || fixtures.length === 0) return <span className="truncate text-[10px] text-navy-600">No fixture in this window.</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {fixtures.map((f, i) => {
        const tier = fixtureDifficultyTier(f.difficultyRaw);
        return (
          <span
            key={i}
            title={tier?.label}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[9px] font-semibold"
            style={tier ? { backgroundColor: tier.bg, color: tier.fg } : undefined}
          >
            {f.isHome ? "vs" : "at"} {f.opponentTeamName ?? "TBC"}
            {f.kickoffAt ? ` (${shortDate(f.kickoffAt)})` : ""}
          </span>
        );
      })}
    </div>
  );
}
