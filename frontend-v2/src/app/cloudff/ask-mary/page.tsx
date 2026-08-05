import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { runAskMaryAnalysis } from "@/lib/cloudffAskMaryEngine";
import { recordPredictions } from "@/lib/predictionActions";
import GameweekPlanRow from "./GameweekPlanRow";

// The recommendation depends on live squad/pool/fixture state that a
// server action changes elsewhere - same reasoning as every other
// data-driven page in this app.
export const dynamic = "force-dynamic";

type SquadRow = { id: number; name: string };

export default async function CloudFFAskMaryPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name, slug").eq("slug", "cloudff").maybeSingle();

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
        <Link href="/cloudff" className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← Back to squad
        </Link>
        <Link href="/cloudff/performance-lab" className="text-xs font-medium text-sky-400 hover:text-sky-300">
          Performance Lab →
        </Link>
      </div>
      <h1 className="mt-4 text-2xl font-semibold text-white">Ask Mary</h1>
      <p className="mt-1 text-sm text-navy-300">Your personalised Cloud FF adviser</p>
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
  // Mary - not user-selectable. predictions.strategy is NOT NULL with no
  // default, so every archived recommendation still needs a real value.
  const analysis = await runAskMaryAnalysis(supabase, squad, game, "balanced", recordPredictions);

  if (!analysis) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <p className="mt-8 text-sm text-red-400">
            {squad.name} doesn&apos;t have a full squad yet - Ask Mary needs {"11"} players to analyse.
          </p>
        </main>
      </div>
    );
  }

  const { captainsByMatchDay, health, gameweekPlan, hasCalendar, seasonStarted, squadPlayers, rules, budgetRemaining } = analysis;

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        {header}

        <div className="mt-6 flex flex-col gap-4">
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Current Squad</h2>
            <p className="mt-2 text-sm text-navy-200">
              {/* Floating-point summation of several 1-decimal prices can
                  leave a tiny epsilon (e.g. -1.4e-14) even when the real
                  bank is exactly £0 - normalize before display so it
                  never renders as "£-0.0m". */}
              {squad.name} · £{(Math.abs(budgetRemaining) < 0.05 ? 0 : budgetRemaining).toFixed(1)}m in the bank · {squadPlayers.length}/{rules.squad_size} players · transfers are always free
            </p>
            <Link href="/cloudff" className="mt-3 inline-block rounded-lg border border-navy-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800">
              Manage squad
            </Link>
          </div>

          {!hasCalendar && (
            <p className="text-xs text-amber-400">No gameweek calendar published for Cloud FF yet - showing the latest single projection instead of a horizon-specific one.</p>
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

              <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h3 className="text-sm font-semibold text-white">Captain by Match-Day</h3>
                <p className="mt-1 text-xs text-navy-500">Cloud FF captains are per match-day, not per gameweek - only players with a real fixture that day are eligible.</p>
                {captainsByMatchDay.length === 0 ? (
                  <p className="mt-2 text-sm text-navy-400">No upcoming fixtures found for this squad&apos;s players yet.</p>
                ) : (
                  <div className="mt-3 flex flex-col gap-2">
                    {captainsByMatchDay.map((day) => (
                      <div key={day.matchDate} className="rounded-lg border border-navy-800 bg-navy-950 p-2 text-sm">
                        <span className="text-navy-400">{new Date(`${day.matchDate}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}:</span>{" "}
                        {day.captain ? (
                          <span className="text-white">
                            {day.captain.full_name}
                            {day.autoPicked && <span className="text-navy-500"> (auto-pick)</span>}
                          </span>
                        ) : (
                          <span className="text-navy-500">No eligible player</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <Link href="/cloudff/captains" className="mt-3 inline-block text-xs font-medium text-sky-400 hover:text-sky-300">
                  Manage match-day captains →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
