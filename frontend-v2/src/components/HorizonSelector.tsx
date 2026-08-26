import Link from "next/link";
import { HORIZONS, type HorizonSelection } from "@/lib/horizonSelection";

// The "Best for" pill row (This gameweek / Next N gameweeks / Live
// Gameweek) - shared by the top of /ratings and, per real user request
// 2026-08-26 ("Allow me to switch gameweek option on there too rather
// than have to scroll to the top"), duplicated inside Browse All
// Players too. Plain URL-param <Link>s, same pattern as the game pills -
// no client state needed, both copies always agree because they both
// just read the same ?horizon= param. `scroll={false}` on the embedded
// copy specifically is what actually satisfies "without scrolling" -
// Next.js's default Link behaviour jumps the viewport to the top on
// every navigation, which would silently defeat the whole point of
// putting the control down here.
export default function HorizonSelector({
  activeSlug,
  viewedGameweek,
  horizonSelection,
  scroll = true,
}: {
  activeSlug: string;
  viewedGameweek: number;
  horizonSelection: HorizonSelection;
  scroll?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-navy-500">Best for</span>
      {HORIZONS.map((h) => (
        <Link
          key={h}
          href={`/ratings?game=${activeSlug}&gameweek=${viewedGameweek}&horizon=${h}`}
          scroll={scroll}
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            horizonSelection === h ? "bg-emerald-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:bg-navy-700"
          }`}
        >
          {h === 1 ? "This gameweek" : `Next ${h} gameweeks`}
        </Link>
      ))}
      <Link
        href={`/ratings?game=${activeSlug}&gameweek=${viewedGameweek}&horizon=live`}
        scroll={scroll}
        className={`rounded-full px-3 py-1 text-xs font-medium ${
          horizonSelection === "live" ? "bg-red-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:bg-navy-700"
        }`}
      >
        Live Gameweek
      </Link>
    </div>
  );
}
