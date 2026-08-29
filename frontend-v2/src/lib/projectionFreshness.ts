import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

/**
 * "When were this game's projections last actually recomputed" - real user
 * request 2026-08-21 ("so i know im using fresh data not stale data").
 * Reads game_projection_freshness (migration 0131), a max(updated_at) per
 * game - see that migration's docstring for why projections.created_at
 * can't answer this (it never moves once a row exists; upsert_projection's
 * own update path is what bumps updated_at).
 */
export async function getProjectionFreshness(supabase: Supabase, gameSlug: string): Promise<string | null> {
  const { data } = await supabase.from("game_projection_freshness").select("last_updated").eq("game_slug", gameSlug).maybeSingle<{ last_updated: string }>();
  return data?.last_updated ?? null;
}

/**
 * "Updated 12 min ago" below ~48h old (the case that actually matters for
 * spotting a stale/broken pipeline run), falling back to an absolute date
 * once it's old enough that the exact minute stops being the useful part.
 */
export function formatFreshness(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `Updated ${days}d ago`;
  // Explicit timeZone: this renders server-side (see getProjectionFreshness's
  // Supabase server client above), with no guarantee the server's own
  // default TZ is the UK's - see playerCard.ts's KICKOFF_TIMEZONE for the
  // same class of bug, caught for real on 2026-08-29.
  return `Updated ${new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}`;
}
