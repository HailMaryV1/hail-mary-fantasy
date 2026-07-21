import { createClient } from "@supabase/supabase-js";

/**
 * PRIVILEGED - bypasses Row Level Security entirely, same trust level as
 * the Python pipeline's own DATABASE_URL connection. Every other client
 * in this app (lib/supabase.ts, lib/supabaseServerClient.ts,
 * lib/supabaseBrowserClient.ts) is the public anon key, RLS-gated -
 * reference tables like golfers/golf_tournaments/golf_tournament_entries
 * only have a "public read" policy (no insert/update/delete for
 * anon/authenticated, same as game_players/players/projections - see
 * migration 0007), so the golf tournament importer (the one place this
 * app writes reference data from a live user action rather than the
 * offline Python pipeline) needs this instead.
 *
 * SUPABASE_SERVICE_ROLE_KEY is deliberately NOT prefixed NEXT_PUBLIC_ -
 * never bundled to the browser. Only ever call this from a "use server"
 * action or route handler, never from a Client Component.
 */
export function createServiceSupabaseClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set - grab it from the Supabase dashboard (Project Settings > API > service_role secret) and add it to frontend/.env.local (and Vercel's env vars for production). Never prefix it NEXT_PUBLIC_."
    );
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
