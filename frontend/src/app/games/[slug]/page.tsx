import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSquadStatuses } from "@/lib/squadStatus";

export const dynamic = "force-dynamic";

// Which of the app's game-scoped tools actually work for each game today -
// deliberately explicit rather than assuming every game has every
// feature. Dream Team has no live scrape source (a longstanding,
// documented gap elsewhere in this app) so Ask Mary/Performance Lab/
// Watchlist/Activity would just be empty or misleading there. NFL
// FanTeam has no data model yet at all.
const GAME_FEATURES: Record<string, { rankings: boolean; fixtures: boolean; watchlist: boolean; activity: boolean; askMary: boolean; performanceLab: boolean }> = {
  fanteam: { rankings: true, fixtures: true, watchlist: true, activity: true, askMary: true, performanceLab: true },
  dreamteam: { rankings: true, fixtures: true, watchlist: false, activity: false, askMary: false, performanceLab: false },
};

export default async function GameHubPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, slug, display_name").eq("slug", slug).single();
  if (!game) notFound();

  const { data: rules } = await supabase.from("game_squad_rules").select("game_id").eq("game_id", game.id).maybeSingle();

  const header = (
    <div>
      <Link href="/" className="text-sm text-navy-400 hover:text-sky-300">
        ← All games
      </Link>
      <h1 className="mt-2 text-2xl font-semibold text-white">{game.display_name}</h1>
    </div>
  );

  if (!rules) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-6">
            <p className="text-sm text-navy-300">
              {game.display_name} isn&apos;t set up yet - squad rules, player data, and scoring haven&apos;t been built
              for this game. It&apos;ll show up here properly once that&apos;s ready.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const features = GAME_FEATURES[game.slug] ?? { rankings: false, fixtures: false, watchlist: false, activity: false, askMary: false, performanceLab: false };
  const allStatuses = await getSquadStatuses(supabase, user.id);
  const statuses = allStatuses.filter((s) => s.gameSlug === game.slug);

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        {header}

        <div className="mt-4 flex flex-wrap gap-2">
          {features.rankings && (
            <Link href={`/rankings?game=${game.slug}`} className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800">
              Rankings
            </Link>
          )}
          {features.fixtures && (
            <Link href={`/fixtures?game=${game.slug}`} className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800">
              Fixtures
            </Link>
          )}
          {features.watchlist && (
            <Link href="/watchlist" className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800">
              Watchlist
            </Link>
          )}
          {features.activity && (
            <Link href="/activity" className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800">
              Activity
            </Link>
          )}
          {features.askMary && (
            <Link href="/ask-mary" className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800">
              Ask Mary
            </Link>
          )}
          {features.performanceLab && (
            <Link href="/performance-lab" className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800">
              Performance Lab
            </Link>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Your squads</h2>
          <Link
            href={`/squads/new?game=${game.slug}`}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-navy-950 hover:bg-sky-400"
          >
            + New squad
          </Link>
        </div>

        {statuses.length === 0 ? (
          <p className="mt-4 text-sm text-navy-300">No {game.display_name} squads yet - build one above.</p>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {statuses.map((s) => (
              <div key={s.id} className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-white">{s.name}</p>
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
                    <Link href={`/squads/${s.id}/lineup`} className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800">
                      Set starting XI
                    </Link>
                  )}
                  <Link href={`/squads/${s.id}/transfers`} className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800">
                    Transfers
                  </Link>
                  <Link href={`/squads/${s.id}/captain`} className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800">
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
