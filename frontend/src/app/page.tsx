import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSquadStatuses } from "@/lib/squadStatus";

// See rankings/page.tsx for why this is needed - Supabase's .rpc() POSTs
// to a fixed URL regardless of parameters, so Next's fetch Data Cache can
// serve stale per-squad projected scores here.
export const dynamic = "force-dynamic";

function formatKickoff(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function daysUntil(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

export default async function DashboardPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950 px-6 text-center">
        <div>
          <h1 className="text-2xl font-semibold text-white">
            Hail Mary<span className="text-sky-400">.</span>
          </h1>
          <p className="mt-2 text-sm text-navy-300">Fantasy football intelligence for Dream Team and FanTeam.</p>
          <Link
            href="/login"
            className="mt-6 inline-block rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400"
          >
            Sign in to get started
          </Link>
        </div>
      </div>
    );
  }

  const statuses = await getSquadStatuses(supabase, user.id);

  // Earliest upcoming kickoff across every game the user has a squad in -
  // labeled as "next kickoff," not a precise transfer deadline we don't
  // actually have data for.
  const gameIds = Array.from(new Set((await supabase.from("squads").select("game_id").eq("user_id", user.id)).data?.map((s) => s.game_id) ?? []));
  let nextKickoff: { gameweek: number; kickoff_at: string } | null = null;
  if (gameIds.length > 0) {
    const { data: gwRows } = await supabase
      .from("game_fixture_gameweeks")
      .select("gameweek, fixtures!inner(kickoff_at)")
      .in("game_id", gameIds)
      .gte("fixtures.kickoff_at", new Date().toISOString())
      .order("gameweek", { ascending: true })
      .limit(1)
      .returns<{ gameweek: number; fixtures: { kickoff_at: string } }[]>();
    const row = gwRows?.[0];
    if (row) nextKickoff = { gameweek: row.gameweek, kickoff_at: row.fixtures.kickoff_at };
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold text-white">Dashboard</h1>

        {nextKickoff && (
          <div className="mt-4 rounded-xl border border-sky-800 bg-sky-950/30 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-sky-400">Next kickoff</p>
            <p className="mt-1 text-xl font-semibold text-white">
              GW{nextKickoff.gameweek} · {daysUntil(nextKickoff.kickoff_at)} day{daysUntil(nextKickoff.kickoff_at) === 1 ? "" : "s"} away
            </p>
            <p className="mt-0.5 text-xs text-navy-300">{formatKickoff(nextKickoff.kickoff_at)}</p>
          </div>
        )}

        {statuses.length === 0 ? (
          <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-6 text-center">
            <p className="text-sm text-navy-300">No squads yet.</p>
            <Link
              href="/squads/new?game=fanteam"
              className="mt-3 inline-block rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-navy-950 hover:bg-sky-400"
            >
              Build your first squad
            </Link>
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-3">
            {statuses.map((s) => (
              <div key={s.id} className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-white">{s.name}</p>
                    <p className="text-xs text-navy-400">{s.gameDisplayName}</p>
                  </div>
                  {s.needsAttention && (
                    <span className="rounded-full bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-400">
                      Starting XI not set
                    </span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-navy-300">
                  <span>£{s.budgetRemaining.toFixed(1)}m in the bank</span>
                  {s.hasBench && <span>{s.freeTransfers} free transfer{s.freeTransfers === 1 ? "" : "s"}</span>}
                  {s.nextGameweekScore != null && (
                    <span className="text-sky-400">Projected GW{s.currentGameweek}: {s.nextGameweekScore.toFixed(1)} pts</span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {s.hasBench && (
                    <Link
                      href={`/squads/${s.id}/lineup`}
                      className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
                    >
                      Set starting XI
                    </Link>
                  )}
                  <Link
                    href={`/squads/${s.id}/transfers`}
                    className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
                  >
                    Transfers
                  </Link>
                  <Link
                    href={`/squads/${s.id}/captain`}
                    className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
                  >
                    Captain
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
