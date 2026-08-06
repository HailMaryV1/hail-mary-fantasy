import Link from "next/link";

/**
 * "< Gameweek N >" pinned above the pitch, matching the real Dream Team
 * Tonic UI the user referenced. Plain server-rendered Links updating
 * ?gameweek= - the page.tsx that renders this is already a server
 * component re-fetching per-gameweek data, so navigation doesn't need
 * any client state of its own (same pattern as golf/rankings' existing
 * ?tournament= switcher).
 */
export default function GameweekSwitcher({
  basePath,
  currentGameweek,
  minGameweek,
  maxGameweek,
  planningGameweek,
}: {
  basePath: string;
  currentGameweek: number;
  minGameweek: number;
  maxGameweek: number;
  planningGameweek: number;
}) {
  const atMin = currentGameweek <= minGameweek;
  const atMax = currentGameweek >= maxGameweek;
  const label = currentGameweek === planningGameweek ? `Gameweek ${currentGameweek} (current)` : `Gameweek ${currentGameweek}`;

  return (
    <div className="flex items-center gap-1 rounded-full border border-navy-700 bg-navy-900 px-1 py-1">
      {atMin ? (
        <span className="cursor-not-allowed rounded-full px-2 py-1 text-xs font-medium text-navy-700">←</span>
      ) : (
        <Link
          href={`${basePath}?gameweek=${currentGameweek - 1}`}
          className="rounded-full px-2 py-1 text-xs font-medium text-navy-300 hover:bg-navy-800 hover:text-white"
        >
          ←
        </Link>
      )}
      <span className="px-2 text-xs font-semibold text-white">{label}</span>
      {atMax ? (
        <span className="cursor-not-allowed rounded-full px-2 py-1 text-xs font-medium text-navy-700">→</span>
      ) : (
        <Link
          href={`${basePath}?gameweek=${currentGameweek + 1}`}
          className="rounded-full px-2 py-1 text-xs font-medium text-navy-300 hover:bg-navy-800 hover:text-white"
        >
          →
        </Link>
      )}
    </div>
  );
}
