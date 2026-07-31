import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getFanteamFootballSquads, type FanteamCompetitionGroup } from "@/lib/fanteamFootballSquads";
import GameSecondaryNav from "@/app/GameSecondaryNav";

// Same reasoning as games/[slug]/page.tsx and the dashboard - projected
// scores come from an RPC call Next's fetch Data Cache can otherwise
// serve stale.
export const dynamic = "force-dynamic";

function timeAgo(iso: string | null): string {
  if (!iso) return "Never synced";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function syncTone(status: "syncing" | "ok" | "error" | "never"): string {
  if (status === "ok") return "bg-emerald-950 text-emerald-400";
  if (status === "error") return "bg-red-950 text-red-400";
  if (status === "syncing") return "bg-sky-950 text-sky-400";
  return "bg-navy-800 text-navy-400";
}

function syncLabel(status: "syncing" | "ok" | "error" | "never"): string {
  if (status === "ok") return "Healthy";
  if (status === "error") return "Sync error";
  if (status === "syncing") return "Syncing…";
  return "Not yet synced";
}

function competitionStatusTone(status: FanteamCompetitionGroup["status"]): string {
  if (status === "running") return "bg-emerald-950 text-emerald-400";
  if (status === "upcoming") return "bg-sky-950 text-sky-400";
  return "bg-navy-800 text-navy-400";
}

export default async function FanteamFootballPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, slug, display_name").eq("slug", "fanteam").single();
  if (!game) redirect("/");

  const groups = await getFanteamFootballSquads(supabase, user.id);

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <Link href="/" className="text-sm text-navy-400 hover:text-sky-300">
          ← All games
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-white">{game.display_name}</h1>
        <p className="mt-1 text-sm text-navy-300">
          Synced automatically from your FanTeam account - choose a squad below to manage it.
        </p>

        <div className="mt-4">
          <GameSecondaryNav gameSlug={game.slug} gameDisplayName={game.display_name} />
        </div>

        {groups.length === 0 ? (
          <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-6">
            <p className="text-sm text-navy-300">
              No Football entries synced yet. Once a sync runs, any Upcoming or Running entry from your FanTeam
              account appears here automatically - nothing to create by hand.
            </p>
          </div>
        ) : (
          <div className="mt-8 flex flex-col gap-8">
            {groups.map((group) => (
              <section key={group.competitionId ?? group.competitionName}>
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">{group.competitionName}</h2>
                  {group.status && (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${competitionStatusTone(group.status)}`}>
                      {group.status}
                    </span>
                  )}
                  <span className="text-xs text-navy-500">
                    {group.squads.length} squad{group.squads.length === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.squads.map((squad) => (
                    <Link
                      key={squad.id}
                      href={`/squads/${squad.id}`}
                      className="group flex flex-col rounded-2xl border border-navy-700 bg-navy-900 p-5 transition-colors hover:border-sky-500 hover:bg-navy-800"
                    >
                      <div className="flex items-start justify-between">
                        <p className="font-medium text-white">{squad.name}</p>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${syncTone(squad.syncStatus)}`}>
                          {syncLabel(squad.syncStatus)}
                        </span>
                      </div>

                      <div className="mt-4">
                        <p className="text-3xl font-semibold text-sky-400">
                          {squad.projectedScore != null ? squad.projectedScore.toFixed(1) : "—"}
                        </p>
                        <p className="text-xs uppercase tracking-wide text-navy-400">Projected GW points</p>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-navy-300">
                        <span>{squad.captainName ? `Captain: ${squad.captainName}` : "Captain not set"}</span>
                        <span>{squad.currentRank != null ? `Rank #${squad.currentRank}` : "Not yet ranked"}</span>
                      </div>

                      <div className="mt-4 flex items-center justify-between">
                        <span className="text-xs text-navy-500">Last synced: {timeAgo(squad.lastSyncedAt)}</span>
                        <span className="text-sm font-medium text-sky-400 group-hover:text-sky-300">Manage squad →</span>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
