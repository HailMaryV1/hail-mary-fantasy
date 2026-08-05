import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { runAskMaryAnalysis } from "@/lib/eflfantasyAskMaryEngine";
import { recordPredictions } from "@/lib/predictionActions";
import GameweekPlanRow from "./GameweekPlanRow";
import ClubRecommendationCard from "./ClubRecommendationCard";

// The recommendation depends on live squad/pool/fixture state that a
// server action changes elsewhere - same reasoning as every other
// data-driven page in this app.
export const dynamic = "force-dynamic";

type SquadRow = { id: number; name: string };

export default async function EFLFantasyAskMaryPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name, slug").eq("slug", "eflfantasy").maybeSingle();

  const { data: squad } = game
    ? await supabase
        .from("squads")
        .select("id, name")
        .eq("game_id", game.id)
        .eq("user_id", user.id)
        .eq("is_archived", false)
        .order("created_at")
        .limit(1)
        .maybeSingle<SquadRow>()
    : { data: null };

  const header = (
    <div>
      <div className="flex items-center justify-between gap-2">
        <Link href="/eflfantasy" className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← Back to squad
        </Link>
        <Link href="/eflfantasy/performance-lab" className="text-xs font-medium text-sky-400 hover:text-sky-300">
          Performance Lab →
        </Link>
      </div>
      <h1 className="mt-4 text-2xl font-semibold text-white">Ask Mary</h1>
      <p className="mt-1 text-sm text-navy-300">Your personalised EFL Fantasy adviser</p>
    </div>
  );

  if (!game || !squad) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <p className="mt-8 text-sm text-navy-300">No squad yet.</p>
        </main>
      </div>
    );
  }

  // Strategy is hardcoded to balanced, same as every other game's Ask
  // Mary - not user-selectable.
  const analysis = await runAskMaryAnalysis(supabase, squad, game, "balanced", recordPredictions);

  if (!analysis) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <p className="mt-8 text-sm text-red-400">{squad.name} doesn&apos;t have a full squad yet - Ask Mary needs all 9 picks (7 players + 2 clubs) to analyse.</p>
        </main>
      </div>
    );
  }

  const { health, gameweekPlan, clubRecommendation, maxCaptainAdvice, oneClubUsedGameweek, hasCalendar, seasonStarted, squadPlayers, squadClubs } = analysis;

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        {header}

        <div className="mt-6 flex flex-col gap-4">
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Current Squad</h2>
            <p className="mt-2 text-sm text-navy-200">
              {squad.name} · {squadPlayers.length} players + {squadClubs.length} clubs · no budget in this game, transfers are always free
            </p>
            <Link href="/eflfantasy" className="mt-3 inline-block rounded-lg border border-navy-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800">
              Manage squad
            </Link>
          </div>

          {!hasCalendar && (
            <p className="text-xs text-amber-400">No gameweek calendar published for EFL Fantasy yet - showing the latest single projection instead of a horizon-specific one.</p>
          )}

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Squad Health Check</h2>
            <div className="mt-2 rounded-xl border border-navy-700 bg-navy-900 p-4">
              <div className="flex items-center gap-3">
                <span className="text-3xl font-bold text-sky-400">{health.rating}</span>
                <span className="text-sm text-navy-400">/ 100 Squad Strength</span>
              </div>
              {health.strengths.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-emerald-400">Strengths</p>
                  <ul className="mt-1 list-inside list-disc text-sm text-navy-200">
                    {health.strengths.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {health.weaknesses.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-amber-400">Weaknesses</p>
                  <ul className="mt-1 list-inside list-disc text-sm text-navy-200">
                    {health.weaknesses.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {health.priorityAreas.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-navy-400">Priority areas</p>
                  <ol className="mt-1 list-inside list-decimal text-sm text-navy-200">
                    {health.priorityAreas.map((p) => (
                      <li key={p.position}>
                        {p.position} - {p.reason}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {health.strengths.length === 0 && health.weaknesses.length === 0 && <p className="mt-3 text-sm text-navy-400">Not enough data yet to assess strengths or weaknesses in detail.</p>}
            </div>
          </div>

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">{seasonStarted ? "Mary's Gameweek Plan" : "Pre-Season Recommendations"}</h2>
            <div className="mt-2 flex flex-col gap-3">
              {gameweekPlan.length === 0 ? (
                <p className="text-sm text-navy-400">No gameweek calendar published yet to build a plan from.</p>
              ) : (
                gameweekPlan.map((step) => <GameweekPlanRow key={step.offset} step={step} squadId={squad.id} />)
              )}
            </div>
          </div>

          {clubRecommendation && (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Club Picks</h2>
              <div className="mt-2">
                <ClubRecommendationCard recommendation={clubRecommendation} squadId={squad.id} />
              </div>
            </div>
          )}

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Boosters</h2>
            <div className="mt-2 rounded-xl border border-navy-700 bg-navy-900 p-4">
              {maxCaptainAdvice && (
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-white">Max Captain</h3>
                    <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[10px] font-medium text-navy-300">{maxCaptainAdvice.usesRemaining} / 2 remaining</span>
                  </div>
                  <p className="mt-1 text-xs text-navy-400">{maxCaptainAdvice.reasoning}</p>
                </div>
              )}
              <div className="mt-3 border-t border-navy-800 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-white">One Club</h3>
                  <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[10px] font-medium text-navy-300">{oneClubUsedGameweek != null ? `Used GW${oneClubUsedGameweek}` : "Available"}</span>
                </div>
                <p className="mt-1 text-xs text-navy-400">Pick up to 7 players from one club for a single gameweek - no recommendation logic yet, this just tracks whether you&apos;ve used it.</p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
