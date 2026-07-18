import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import AuthStatus from "./AuthStatus";

export default async function NavBar() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex items-center justify-between border-b border-navy-700 bg-navy-900 px-6 py-3">
      <nav className="flex items-center gap-5 text-sm font-medium">
        <Link href="/" className="flex items-center gap-1.5 text-white hover:text-sky-300">
          Hail Mary<span className="text-sky-400">.</span>
        </Link>
        {user && (
          <>
            <Link href="/rankings" className="text-navy-300 hover:text-sky-300">
              Rankings
            </Link>
            <Link href="/squads" className="text-navy-300 hover:text-sky-300">
              My Squads
            </Link>
          </>
        )}
      </nav>
      <AuthStatus />
    </div>
  );
}
