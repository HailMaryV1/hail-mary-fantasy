"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { featuresForGame } from "@/lib/gameFeatures";

export default function GameSecondaryNav({ gameSlug, gameDisplayName }: { gameSlug: string; gameDisplayName: string }) {
  const pathname = usePathname();
  const features = featuresForGame(gameSlug);

  const links: { label: string; href: string }[] = [{ label: "My Teams", href: `/games/${gameSlug}` }];
  if (features.askMary) links.push({ label: "Ask Mary", href: "/ask-mary" });
  if (features.performanceLab) links.push({ label: "Performance Lab", href: "/performance-lab" });
  if (features.watchlist) links.push({ label: "Watchlist", href: "/watchlist" });
  if (features.rankings) links.push({ label: "Player Rankings", href: `/rankings?game=${gameSlug}` });
  if (features.hailMaryForm) links.push({ label: "Hail Mary Form", href: `/form?game=${gameSlug}` });
  // Not one of the 6 named links in the nav redesign, but Fixtures is a
  // real, working page - the old inline button row it's replacing linked
  // to it, so dropping it here would silently orphan it (no other nav
  // links to /fixtures once the top-level NavBar was cut down to games).
  if (features.fixtures) links.push({ label: "Fixtures", href: `/fixtures?game=${gameSlug}` });
  if (features.activity) links.push({ label: "Activity", href: "/activity" });

  return (
    <nav aria-label={`${gameDisplayName} navigation`} className="flex flex-wrap gap-1 border-b border-navy-800 pb-2 text-sm font-medium">
      {links.map((link) => {
        const linkPath = link.href.split("?")[0];
        // Each squad's own page (/squads/{id}) lives one level below the
        // game hub with no dedicated secondary-nav link of its own -
        // "My Teams" stays highlighted there since that's the flow it's
        // part of.
        const isMyTeams = linkPath === `/games/${gameSlug}`;
        const active = isMyTeams ? pathname === linkPath || pathname.startsWith("/squads/") : pathname.startsWith(linkPath);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-lg px-3 py-1.5 transition-colors ${
              active ? "bg-navy-800 text-sky-300" : "text-navy-300 hover:bg-navy-900 hover:text-white"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
