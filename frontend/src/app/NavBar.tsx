import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import AuthStatus from "./AuthStatus";
import NavGameLinks from "./NavGameLinks";

export default async function NavBar() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: allGames } = user
    ? await supabase.from("fantasy_games").select("id, slug, display_name").order("id")
    : { data: null };

  // Only list games the frontend actually supports (a game_squad_rules
  // row exists) - same "is this game configured" signal app/page.tsx's
  // dashboard already uses. Cloud FF's backend/pipeline/provider sync run
  // for real today, but no page here can manage a Cloud FF squad yet, so
  // the nav link would just dead-end at "isn't set up yet".
  const { data: rulesRows } = user ? await supabase.from("game_squad_rules").select("game_id") : { data: null };
  const configuredGameIds = new Set((rulesRows ?? []).map((r) => r.game_id));
  const games = (allGames ?? []).filter((g) => configuredGameIds.has(g.id));

  return (
    <div className="flex items-center justify-between gap-3 border-b border-navy-700 bg-navy-900 px-6 py-3">
      {/* min-w-0 is required here - without it a flex item can't shrink
          below its content's natural width, so overflow-x-auto on this
          nav would never actually engage and the whole page would widen
          instead (found when adding the 5th link pushed mobile past
          375px - same overflow-vs-scroll flexbox gotcha as elsewhere in
          this session). */}
      <nav className="flex min-w-0 items-center gap-5 overflow-x-auto text-sm font-medium">
        <Link href="/" className="flex shrink-0 items-center gap-1.5 text-white transition-colors hover:text-sky-300">
          Hail Mary<span className="text-sky-400">.</span>
        </Link>
        {user && <NavGameLinks games={games ?? []} />}
      </nav>
      <div className="shrink-0">
        <AuthStatus />
      </div>
    </div>
  );
}
