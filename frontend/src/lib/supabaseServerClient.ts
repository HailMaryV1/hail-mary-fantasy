import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Cookie-aware Supabase client for Server Components/Actions that need
 * to know who's logged in. Separate from lib/supabase.ts (the plain
 * anon-key client the public rankings/player pages use) - those don't
 * need a session at all, this one exists specifically for auth.
 */
export async function createAuthServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component render, not an Action -
            // ignorable because proxy.ts refreshes the session on every request.
          }
        },
      },
    }
  );
}
