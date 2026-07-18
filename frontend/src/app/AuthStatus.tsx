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
      <Link href="/login" className="text-sm font-medium text-navy-300 hover:text-sky-300">
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="hidden text-navy-300 sm:inline">{user.email}</span>
      <form action={signOut}>
        <button className="font-medium text-navy-300 hover:text-sky-300">Sign out</button>
      </form>
    </div>
  );
}
