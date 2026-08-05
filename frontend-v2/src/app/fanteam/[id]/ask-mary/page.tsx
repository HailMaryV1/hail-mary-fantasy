import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { runAskMaryAnalysis } from "@/lib/fanteamAskMaryEngine";
import { recordPredictions } from "@/lib/predictionActions";
import GameweekPlanRow from "./GameweekPlanRow";

// The recommendation depends on live squad/pool/fixture state that a
// server action changes elsewhere - same reasoning as every other
// data-driven page in this app.
export const dynamic = "force-dynamic";

type SquadRow = {
  id: number;
  name: string;
  user_id: string;
  free_transfers: number;
  wildcard_1_used_gameweek: number | null;
  wildcard_2_used_gameweek: number | null;
  fantasy_games: { id: number; display_name: string; slug: string } | { id: number; display_name: string; slug: string }[];
};

export default async function FanTeamAskMaryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const squadId = Number(id);

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: squad } = await supabase
    .from("squads")
    .select("id, name, user_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek, fantasy_games(id, display_name, slug)")
    .eq("id", squadId)
    .single<SquadRow>();
  if (!squad || squad.user_id !== user.id) notFound();

  const game = Array.isArray(squad.fantasy_games) ? squad.fantasy_games[0] : squad.fantasy_games;
  if (!game || game.slug !== "fanteam") notFound();

  const header = (
    <div>
      <div className="flex items-center justify-between gap-2">
        <Link href={`/fanteam/${squadId}`} className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← Back to squad
        </Link>
        <Link href={`/fanteam/${squadId}/performance-lab`} className="text-xs font-medium text-sky-400 hover:text-sky-300">
          Performance Lab →
        </Link>
      </div>
      <h1 className="mt-4 text-2xl font-semibold text-white">Ask Mary</h1>
      <p className="mt-1 text-sm text-navy-300">Your personalised FanTeam adviser</p>
    </div>
  );

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
            {squad.name} doesn&apos;t have a full 15-player squad yet - Ask Mary needs a complete squad to analyse.
          </p>
        </main>
      </div>
    );
  }

  const { bestCaptain, viceCaptain, health, gameweekPlan, hasCalendar, seasonStarted, squadPlayers, rules, budgetRemaining } = analysis;
  const startingCount = squadPlayers.filter((p) => p.is_starting).length;
  const startingXIComplete = startingCount === rules.starting_size;

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        {header}

        <div className="mt-6 flex flex-col gap-4">
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Current Squad</h2>
            <p className="mt-2 text-sm text-navy-200">
              {squad.name} · £{budgetRemaining.toFixed(1)}m in the bank · {squadPlayers.length}/{rules.squad_size} players ·{" "}
              {seasonStarted ? `${squad.free_transfers} free transfer${squad.free_transfers === 1 ? "" : "s"}` : "Unlimited transfers (pre-season)"}
            </p>
            <Link href={`/fanteam/${squadId}`} className="mt-3 inline-block rounded-lg border border-navy-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800">
              Manage squad
            </Link>
          </div>

          {!hasCalendar && (
            <p className="text-xs text-amber-400">No gameweek calendar published for FanTeam yet - showing the latest single projection instead of a horizon-specific one.</p>
          )}

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Squad Health Check</h2>
            <div className="mt-2 rounded-xl border border-navy-700 bg-navy-900 p-4">
              <div className="flex items-center gap-3">
                <span className="text-3xl font-bold text-sky-400">{health.rating}</span>
                <span className="text-sm text-navy-400">/ 100 Starting XI Strength</span>
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
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">{seasonStarted ? "Mary's Gameweek Plan" : "Pre-Season Recommendations (Unlimited Transfers)"}</h2>
            <div className="mt-2 flex flex-col gap-3">
              {gameweekPlan.length === 0 ? (
                <p className="text-sm text-navy-400">No gameweek calendar published yet to build a plan from.</p>
              ) : (
                gameweekPlan.map((step) => <GameweekPlanRow key={step.offset} step={step} squadId={squadId} />)
              )}

              <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h3 className="text-sm font-semibold text-white">Captain &amp; Vice-Captain (Next Gameweek)</h3>
                {!bestCaptain ? (
                  <p className="mt-2 text-sm text-navy-400">Set a starting XI to get captaincy advice.</p>
                ) : (
                  <>
                    {!startingXIComplete && (
                      <p className="mt-2 text-xs text-amber-400">
                        Starting XI isn&apos;t fully set ({startingCount}/{rules.starting_size}) - this pick may change once it is.
                      </p>
                    )}
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <CaptainOption label="Captain" player={bestCaptain} />
                      <CaptainOption label="Vice-Captain" player={viceCaptain} />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function CaptainOption({ label, player }: { label: string; player: { full_name: string; team_name: string; score: number } | null }) {
  return (
    <div className="rounded-lg border border-navy-800 bg-navy-950 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-sky-400">{label}</p>
      {player ? (
        <>
          <p className="mt-1 text-sm font-medium text-white">{player.full_name}</p>
          <p className="text-[11px] text-navy-400">
            {player.team_name} · {player.score.toFixed(1)} pts projected
          </p>
        </>
      ) : (
        <p className="mt-1 text-xs text-navy-500">Not available.</p>
      )}
    </div>
  );
}
