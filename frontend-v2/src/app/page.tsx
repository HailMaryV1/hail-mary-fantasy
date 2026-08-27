import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getGameIcon } from "@/lib/gameIcons";

// Same reasoning as the original site's landing page: this route is
// per-user (redirects to /login when signed out), so it must never be
// served from Next's static/data cache.
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: games } = await supabase.from("fantasy_games").select("slug, display_name").order("id");

  return (
    <div className="flex min-h-screen flex-col items-center gap-10 bg-navy-950 px-6 py-14">
      <Image src="/logo.png" alt="Hail Mary" width={140} height={145} priority />

      <nav className="grid w-full max-w-4xl grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6">
        {(games ?? []).map((g) => {
          const icon = getGameIcon(g.slug);
          return (
            <Link
              key={g.slug}
              href={`/games/${g.slug}`}
              className="group relative aspect-square overflow-hidden rounded-2xl border border-navy-800 bg-navy-900 shadow-lg shadow-black/40 transition-all hover:-translate-y-1 hover:border-sky-500 hover:shadow-xl hover:shadow-sky-950/50"
            >
              {icon ? (
                <Image
                  src={icon}
                  alt={g.display_name}
                  fill
                  sizes="(max-width: 640px) 45vw, 280px"
                  className="object-cover transition-transform duration-300 group-hover:scale-105"
                  priority
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center px-2 text-center text-sm font-medium text-navy-200">
                  {g.display_name}
                </span>
              )}
            </Link>
          );
        })}
        {/* Static tile, not from the `games` query above - the Hail Mary
            Weekly Ratings page isn't a game with its own squad/players,
            it's a cross-game leaderboard browse view (see /ratings). */}
        <Link
          href="/ratings"
          className="group relative aspect-square overflow-hidden rounded-2xl border border-navy-800 bg-navy-900 shadow-lg shadow-black/40 transition-all hover:-translate-y-1 hover:border-sky-500 hover:shadow-xl hover:shadow-sky-950/50"
        >
          <span className="flex h-full w-full items-center justify-center px-2 text-center text-sm font-medium text-navy-200">
            Hail Mary Weekly Ratings
          </span>
        </Link>
        {/* Also static, and for a stronger reason than the ratings tile above:
            /fouls isn't a fantasy game at all, it's a betting-market tool with
            its own engine and no shared scoring model. It could never come from
            the `games` query. The second line says so, so the tile isn't
            mistaken for a fifth game. */}
        <Link
          href="/fouls"
          className="group relative aspect-square overflow-hidden rounded-2xl border border-navy-800 bg-navy-900 shadow-lg shadow-black/40 transition-all hover:-translate-y-1 hover:border-sky-500 hover:shadow-xl hover:shadow-sky-950/50"
        >
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
            <span className="text-sm font-medium text-navy-200">Fouls Board</span>
            <span className="text-[11px] leading-tight text-navy-400">
              Betting edge finder
            </span>
          </span>
        </Link>
        {/* 2026-08-27 user request - direct homepage access to real
            market odds, rather than only reachable from inside a game's
            own board. /market-odds is a chooser (real odds only ever
            exist per-game - see that page's own docstring). */}
        <Link
          href="/market-odds"
          className="group relative aspect-square overflow-hidden rounded-2xl border border-navy-800 bg-navy-900 shadow-lg shadow-black/40 transition-all hover:-translate-y-1 hover:border-sky-500 hover:shadow-xl hover:shadow-sky-950/50"
        >
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
            <span className="text-sm font-medium text-navy-200">Market Odds</span>
            <span className="text-[11px] leading-tight text-navy-400">Real bookmaker prices</span>
          </span>
        </Link>
        {/* 2026-08-27 user request - homepage access to the Premier
            League fixture-difficulty override page (admin/team-strength/
            page.tsx, "team difficulty viewer and adjustment section"). */}
        <Link
          href="/admin/team-strength"
          className="group relative aspect-square overflow-hidden rounded-2xl border border-navy-800 bg-navy-900 shadow-lg shadow-black/40 transition-all hover:-translate-y-1 hover:border-sky-500 hover:shadow-xl hover:shadow-sky-950/50"
        >
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
            <span className="text-sm font-medium text-navy-200">Team Strength</span>
            <span className="text-[11px] leading-tight text-navy-400">Fixture difficulty override</span>
          </span>
        </Link>
      </nav>
    </div>
  );
}
