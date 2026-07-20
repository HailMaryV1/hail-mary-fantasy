import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSquadStatuses } from "@/lib/squadStatus";
import SquadCardActions from "./SquadCardActions";

// See rankings/page.tsx for why this is needed - Supabase's .rpc() POSTs
// to a fixed URL regardless of parameters, so Next's fetch Data Cache can
// serve stale per-squad projected scores here.
export const dynamic = "force-dynamic";

export default async function SquadsPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const statuses = await getSquadStatuses(supabase, user!.id);

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-white">My Squads</h1>
          <div className="flex gap-2">
            <Link
              href="/squads/new?game=dreamteam"
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-navy-950 hover:bg-sky-400"
            >
              + Dream Team squad
            </Link>
            <Link
              href="/squads/new?game=fanteam"
              className="rounded-lg border border-navy-700 bg-navy-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
            >
              + FanTeam squad
            </Link>
          </div>
        </div>

        {statuses.length === 0 && (
          <p className="mt-8 text-sm text-navy-300">
            No squads yet - build one above.
          </p>
        )}

        <div className="mt-6 flex flex-col gap-3">
          {statuses.map((s) => (
            <div
              key={s.id}
              className="rounded-xl border border-navy-700 bg-navy-900 p-4"
            >
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
                <Link
                  href={`/squads/${s.id}/analysis`}
                  className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
                >
                  Look ahead
                </Link>
              </div>

              <SquadCardActions squadId={s.id} squadName={s.name} gameSlug={s.gameSlug} />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
