import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

export const dynamic = "force-dynamic";

type TournamentRow = { fanteam_tournament_id: string; name: string; event_number: number | null; status: string; start_time: string };

const STATUS_LABEL: Record<string, string> = { upcoming: "Upcoming", live: "Live", completed: "Completed" };

export default async function GolfHubPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam-golf").maybeSingle<{ id: number }>();

  let tournaments: TournamentRow[] = [];
  if (game) {
    const { data } = await supabase
      .from("golf_tournaments")
      .select("fanteam_tournament_id, name, event_number, status, start_time")
      .eq("game_id", game.id)
      .order("start_time", { ascending: false })
      .returns<TournamentRow[]>();
    tournaments = data ?? [];
  }
  const current = tournaments[0] ?? null;

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← Back to main menu
        </Link>

        <h1 className="mt-4 text-2xl font-semibold text-white">FanTeam Golf</h1>
        <p className="mt-1 text-sm text-navy-300">
          A weekly tournament import, decomposed through Hail Mary Golf&apos;s own scoring model, into rankings and picks.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Link
            href="/golf/import"
            className="rounded-xl border border-navy-700 bg-navy-900 p-4 transition-colors hover:border-sky-500 hover:bg-navy-800"
          >
            <p className="text-sm font-semibold text-white">Tournament Builder</p>
            <p className="mt-1 text-xs text-navy-400">Import this week&apos;s field, add odds, compute picks - 3 steps</p>
          </Link>
          <Link
            href="/golf/team"
            className="rounded-xl border border-navy-700 bg-navy-900 p-4 transition-colors hover:border-sky-500 hover:bg-navy-800"
          >
            <p className="text-sm font-semibold text-white">Team Builder</p>
            <p className="mt-1 text-xs text-navy-400">Pick your 6 golfers under budget - captain, underdog, live swaps</p>
          </Link>
          <Link
            href="/golf/rankings"
            className="rounded-xl border border-navy-700 bg-navy-900 p-4 transition-colors hover:border-sky-500 hover:bg-navy-800"
          >
            <p className="text-sm font-semibold text-white">Player Rankings</p>
            <p className="mt-1 text-xs text-navy-400">Hail Mary Golf&apos;s per-golfer projections</p>
          </Link>
        </div>

        {current && (
          <p className="mt-6 text-sm text-navy-300">
            Current tournament: <span className="text-white">{current.name}</span>
            {current.event_number ? ` · Gameweek ${current.event_number}` : ""}
            {" · "}
            <Link href={`/golf/rankings?tournament=${current.fanteam_tournament_id}`} className="text-sky-400 hover:text-sky-300">
              View rankings →
            </Link>
          </p>
        )}
        {!current && <p className="mt-6 text-sm text-amber-400">No tournament imported yet - start with Tournament Builder above.</p>}

        {tournaments.length > 1 && (
          <div className="mt-8">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-navy-400">Past Tournaments</h2>
            <div className="mt-2 flex flex-col gap-2">
              {tournaments.slice(1).map((t) => (
                <Link
                  key={t.fanteam_tournament_id}
                  href={`/golf/rankings?tournament=${t.fanteam_tournament_id}`}
                  className="flex items-center justify-between rounded-lg border border-navy-700 bg-navy-900 px-4 py-3 transition-colors hover:border-sky-500 hover:bg-navy-800"
                >
                  <div>
                    <p className="text-sm font-medium text-white">{t.name}</p>
                    <p className="text-xs text-navy-400">
                      {t.event_number ? `Gameweek ${t.event_number} · ` : ""}
                      {STATUS_LABEL[t.status] ?? t.status}
                    </p>
                  </div>
                  <span className="text-xs font-medium text-sky-400">View rankings →</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
