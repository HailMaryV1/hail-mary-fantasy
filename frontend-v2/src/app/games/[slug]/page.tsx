import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { isSingleTeamGame, isTournamentGame } from "@/lib/gameConfig";

export const dynamic = "force-dynamic";

export default async function GameEntryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", slug).single();
  if (!game) notFound();

  // Tournament-scoped games (FanTeam Golf) have their own dedicated
  // route tree - they don't fit the squad-selector model below at all.
  if (isTournamentGame(slug)) redirect("/golf");

  // FanTeam football and Dream Team each get their own dedicated route
  // tree too (/fanteam, /dreamteam) rather than the generic squad-
  // selector below - every game keeps its own identity, projections, and
  // history separate, never a shared list mixing multiple games'
  // entities together (see gameConfig.ts's isTournamentGame comment for
  // the precedent this follows).
  //
  // 2026-08-27 site-wide rating consolidation: squad management (pitch
  // view, transfers, Ask Mary) is being removed game-by-game in favour of
  // a pure ratings/rankings tool - Dream Team's own homepage is now the
  // Target Score ratings hub (/ratings?game=dreamteam) rather than the
  // (now deleted) squad board. Each remaining game switches over the same
  // way as its own squad board is removed.
  if (slug === "dreamteam") redirect("/ratings?game=dreamteam");
  if (slug === "fanteam") redirect("/ratings?game=fanteam");
  if (slug === "cloudff") redirect("/ratings?game=cloudff");
  if (slug === "eflfantasy") redirect("/ratings?game=eflfantasy");

  const { data: squads } = await supabase
    .from("squads")
    .select("id, name")
    .eq("game_id", game.id)
    .eq("user_id", user.id)
    .eq("is_archived", false)
    .order("created_at");

  // Single-team games (Dream Team, Cloud FF): skip the selector entirely -
  // straight to the one squad that exists, or a build prompt if it
  // doesn't exist yet.
  if (isSingleTeamGame(slug)) {
    if (squads && squads.length > 0) redirect(`/squads/${squads[0].id}`);

    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-lg">
          <h1 className="mt-6 text-xl font-semibold text-white">{game.display_name}</h1>
          <p className="mt-2 text-sm text-navy-300">No squad yet.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-lg">
        <h1 className="mt-6 text-xl font-semibold text-white">{game.display_name}</h1>

        <div className="mt-6 flex flex-col gap-2">
          {(squads ?? []).map((s) => (
            <Link
              key={s.id}
              href={`/squads/${s.id}`}
              className="rounded-lg border border-navy-700 bg-navy-900 px-4 py-3 text-sm font-medium text-navy-100 transition-colors hover:border-sky-500 hover:text-white"
            >
              {s.name || `Squad #${s.id}`}
            </Link>
          ))}
          {(!squads || squads.length === 0) && <p className="text-sm text-navy-300">No squads yet.</p>}
        </div>

        <Link
          href={`/squads/new?game=${slug}`}
          className="mt-4 inline-block text-sm font-medium text-sky-400 hover:text-sky-300"
        >
          + New squad
        </Link>
      </main>
    </div>
  );
}
