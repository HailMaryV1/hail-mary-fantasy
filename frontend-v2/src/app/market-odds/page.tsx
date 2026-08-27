import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

export const dynamic = "force-dynamic";

/**
 * Homepage "Market Odds" card (2026-08-27 user request - "I need to be
 * able to access market odds direct from the hompage"). Real market
 * odds only ever exist per-game (dreamteam/cloudff/eflfantasy/market-
 * odds pages) - there's no single shared odds board - so this is a
 * chooser, not a page of its own data. FanTeam is the one game whose
 * market-odds route is scoped by squad id, not just slug (fanteam/[id]/
 * market-odds - real fixtures can differ league to league), so it needs
 * the user's own first real squad resolved server-side, same query
 * FanTeamHubPage (app/fanteam/page.tsx) already runs - falling back to
 * the FanTeam hub itself when they don't have one yet to pick from.
 */
export default async function MarketOddsHubPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: fanteamGame } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam").maybeSingle<{ id: number }>();
  let fanteamSquadId: number | null = null;
  if (fanteamGame) {
    const { data: squad } = await supabase
      .from("squads")
      .select("id")
      .eq("game_id", fanteamGame.id)
      .eq("user_id", user.id)
      .eq("is_archived", false)
      .order("created_at")
      .limit(1)
      .maybeSingle<{ id: number }>();
    fanteamSquadId = squad?.id ?? null;
  }

  const cards: { label: string; href: string }[] = [
    { label: "Dream Team", href: "/dreamteam/market-odds" },
    { label: "FanTeam", href: fanteamSquadId != null ? `/fanteam/${fanteamSquadId}/market-odds` : "/fanteam" },
    { label: "Cloud FF", href: "/cloudff/market-odds" },
    { label: "EFL Fantasy", href: "/eflfantasy/market-odds" },
  ];

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← Home
        </Link>

        <h1 className="mt-4 text-2xl font-semibold text-white">Market Odds</h1>
        <p className="mt-1 text-sm text-navy-300">Real bookmaker prices, one board per game.</p>

        <div className="mt-6 flex flex-col gap-2">
          {cards.map((c) => (
            <Link
              key={c.label}
              href={c.href}
              className="rounded-lg border border-navy-700 bg-navy-900 px-4 py-3 text-sm font-medium text-navy-100 transition-colors hover:border-sky-500 hover:text-white"
            >
              {c.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
