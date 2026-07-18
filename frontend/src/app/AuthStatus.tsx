import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { signOut } from "./login/actions";

export default async function AuthStatus() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <Link
        href="/login"
        className="text-sm font-medium text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-white"
      >
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-zinc-600 dark:text-zinc-400">{user.email}</span>
      <form action={signOut}>
        <button className="font-medium text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-white">
          Sign out
        </button>
      </form>
    </div>
  );
}
