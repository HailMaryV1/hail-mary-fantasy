import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import AuthStatus from "./AuthStatus";

export default async function NavBar() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex items-center justify-between gap-3 border-b border-navy-700 bg-navy-900 px-6 py-3">
      {/* min-w-0 is required here - without it a flex item can't shrink
          below its content's natural width, so overflow-x-auto on this
          nav would never actually engage and the whole page would widen
          instead (found when adding the 5th link pushed mobile past
          375px - same overflow-vs-scroll flexbox gotcha as elsewhere in
          this session). */}
      <nav className="flex min-w-0 items-center gap-5 overflow-x-auto text-sm font-medium">
        <Link href="/" className="flex shrink-0 items-center gap-1.5 text-white hover:text-sky-300">
          Hail Mary<span className="text-sky-400">.</span>
        </Link>
        {user && (
          <>
            <Link href="/rankings" className="shrink-0 text-navy-300 hover:text-sky-300">
              Rankings
            </Link>
            <Link href="/fixtures" className="shrink-0 text-navy-300 hover:text-sky-300">
              Fixtures
            </Link>
            <Link href="/watchlist" className="shrink-0 text-navy-300 hover:text-sky-300">
              Watchlist
            </Link>
            <Link href="/squads" className="shrink-0 text-navy-300 hover:text-sky-300">
              My Squads
            </Link>
          </>
        )}
      </nav>
      <div className="shrink-0">
        <AuthStatus />
      </div>
    </div>
  );
}
