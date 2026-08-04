import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

// See rankings/page.tsx for why this is needed - Supabase's .rpc() POSTs
// to a fixed URL regardless of parameters, so Next's fetch Data Cache can
// serve stale per-squad projected scores here.
export const dynamic = "force-dynamic";

export default async function GatewayPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: games } = await supabase.from("fantasy_games").select("id, slug, display_name").order("id");
  const { data: rulesRows } = await supabase.from("game_squad_rules").select("game_id");
  const configuredGameIds = new Set((rulesRows ?? []).map((r) => r.game_id));

  // Deliberately NOT getSquadStatuses (see lib/squadStatus.ts) - this page
  // only ever needs a per-game squad COUNT, but that helper does a full
  // sequential per-squad loop (budget calc + a real player_score_by_horizon
  // RPC call, one round trip at a time) meant for pages that actually show
  // that richer detail (games/[slug]/page.tsx, squads/page.tsx). Confirmed
  // live (2026-08-03) this was the real cause of a slow-feeling landing
  // page - 16 real squads meant ~40 sequential DB round trips, including
  // real scoring computation, just to render "3 squads" as plain text. One
  // cheap query, no RPC, no per-squad loop.
  const { data: squadGameIds } = await supabase.from("squads").select("game_id").eq("user_id", user.id);
  const squadCountByGameId = new Map<number, number>();
  for (const row of squadGameIds ?? []) {
    squadCountByGameId.set(row.game_id, (squadCountByGameId.get(row.game_id) ?? 0) + 1);
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold text-white">
          Hail Mary<span className="text-sky-400">.</span>
        </h1>
        <p className="mt-1 text-sm text-navy-300">Pick a game - each one keeps its own squads, rankings, and tools separate.</p>

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(games ?? []).map((g) => {
            const isConfigured = configuredGameIds.has(g.id);
            const squadCount = squadCountByGameId.get(g.id) ?? 0;
            return (
              <Link
                key={g.id}
                href={`/games/${g.slug}`}
                className="group flex flex-col justify-between rounded-2xl border border-navy-700 bg-navy-900 p-6 transition-colors hover:border-sky-500 hover:bg-navy-800"
              >
                <div>
                  <p className="text-lg font-semibold text-white">{g.display_name}</p>
                  {isConfigured ? (
                    <p className="mt-1 text-sm text-navy-300">
                      {squadCount > 0 ? `${squadCount} squad${squadCount === 1 ? "" : "s"}` : "No squads yet"}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-amber-400">Coming soon</p>
                  )}
                </div>
                <span className="mt-6 text-sm font-medium text-sky-400 group-hover:text-sky-300">Open →</span>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
