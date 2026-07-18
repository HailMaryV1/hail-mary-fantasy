import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import AuthStatus from "./AuthStatus";

export default async function NavBar() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-2 dark:border-zinc-800 dark:bg-black">
      <nav className="flex items-center gap-4 text-sm font-medium">
        <Link href="/" className="text-black hover:text-zinc-600 dark:text-zinc-50 dark:hover:text-zinc-300">
          Hail Mary
        </Link>
        {user && (
          <Link href="/squads" className="text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-white">
            My Squads
          </Link>
        )}
      </nav>
      <AuthStatus />
    </div>
  );
}
