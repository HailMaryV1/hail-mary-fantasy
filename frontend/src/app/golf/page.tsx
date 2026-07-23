import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type TournamentRow = { fanteam_tournament_id: string; name: string; event_number: number | null; status: string };

const SINGLE_GAMEWEEK_LINKS: { label: string; href: string; description: string }[] = [
  { label: "Import Tournament", href: "/golf/import", description: "Paste this week's FanTeam contest URL" },
  { label: "Course History", href: "/golf/course-history", description: "Upload DataGolf's course-history CSV for the week's course" },
  { label: "Tournament Odds", href: "/golf/odds", description: "Paste bookmaker win/top-10/top-20 odds for the week's field" },
  { label: "Player Rankings", href: "/golf/rankings", description: "Hail Mary Golf's per-golfer projections" },
  { label: "Team Builder", href: "/golf/team", description: "Optimised teams, player picker, saved teams" },
  { label: "Live Scores", href: "/golf/live", description: "Your saved teams' live points, updating every ~5 minutes during play" },
  {
    label: "Algorithm Performance",
    href: "/golf/algorithm-performance",
    description: "Frozen pre-tournament predictions graded against real results",
  },
];

const COMING_SOON_LINKS: { label: string; description: string }[] = [];

export default async function GolfLandingPage() {
  const supabase = createServerSupabaseClient();
  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam-golf").maybeSingle<{ id: number }>();

  let tournament: TournamentRow | null = null;
  if (game) {
    const { data } = await supabase
      .from("golf_tournaments")
      .select("fanteam_tournament_id, name, event_number, status")
      .eq("game_id", game.id)
      .order("start_time", { ascending: false })
      .limit(1)
      .returns<TournamentRow[]>();
    tournament = data?.[0] ?? null;
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <Link href="/" className="text-sm text-navy-400 hover:text-sky-300">
          ← Hail Mary
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">FanTeam Golf</h1>
        <p className="mt-1 text-sm text-navy-300">
          A weekly tournament import, decomposed through Hail Mary Golf&apos;s own scoring model, into rankings and
          optimised teams - not a re-display of FanTeam&apos;s own numbers.
        </p>

        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Single Gameweek</h2>
            <span className="rounded-full bg-emerald-950 px-2.5 py-1 text-xs font-semibold text-emerald-400">Active</span>
          </div>
          {tournament ? (
            <p className="mt-1 text-sm text-navy-300">
              Current tournament: <span className="text-white">{tournament.name}</span>
              {tournament.event_number ? ` · Gameweek ${tournament.event_number}` : ""}
              {" · "}
              <Link href={`/golf/rankings?tournament=${tournament.fanteam_tournament_id}`} className="text-sky-400 hover:text-sky-300">
                View rankings →
              </Link>
            </p>
          ) : (
            <p className="mt-1 text-sm text-amber-400">No tournament imported yet - start below.</p>
          )}

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {SINGLE_GAMEWEEK_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="group flex flex-col justify-between rounded-xl border border-navy-700 bg-navy-900 p-4 transition-colors hover:border-sky-500 hover:bg-navy-800"
              >
                <div>
                  <p className="text-sm font-semibold text-white">{l.label}</p>
                  <p className="mt-1 text-xs text-navy-400">{l.description}</p>
                </div>
                <span className="mt-3 text-xs font-medium text-sky-400 group-hover:text-sky-300">Open →</span>
              </Link>
            ))}
            {COMING_SOON_LINKS.map((l) => (
              <div key={l.label} className="flex flex-col justify-between rounded-xl border border-navy-800 bg-navy-900/50 p-4 opacity-60">
                <div>
                  <p className="text-sm font-semibold text-white">{l.label}</p>
                  <p className="mt-1 text-xs text-navy-400">{l.description}</p>
                </div>
                <span className="mt-3 text-xs font-medium text-navy-500">Coming soon</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Season Game</h2>
            <span className="rounded-full bg-navy-800 px-2.5 py-1 text-xs font-semibold text-navy-300">Coming Soon</span>
          </div>
          <div className="mt-4 rounded-xl border border-navy-800 bg-navy-900/50 p-6 opacity-70">
            <p className="text-sm font-semibold text-white">FanTeam Golf Season Game</p>
            <p className="mt-1 text-sm text-navy-400">
              A persistent, transfer-based golf squad across the whole tour season - on the roadmap, structured for
              cleanly once it&apos;s built (golf_tournaments already tracks each event&apos;s game_scope for exactly
              this), but not started yet.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
