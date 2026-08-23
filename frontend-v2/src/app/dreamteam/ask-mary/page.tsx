import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { runAskMaryAnalysis } from "@/lib/dreamteamAskMaryEngine";
import { recordPredictions } from "@/lib/predictionActions";
import GameweekPlanRow from "./GameweekPlanRow";

// The recommendation depends on live squad/pool/fixture state that a
// server action changes elsewhere - same reasoning as every other
// data-driven page in this app (dreamteam/page.tsx, cloudff/captains).
export const dynamic = "force-dynamic";

type SquadRow = {
  id: number;
  name: string;
  free_transfers: number;
  goal_bonus_used_gameweek: number | null;
  twelfth_man_used_gameweek: number | null;
  max_captain_used_gameweek: number | null;
};

export default async function DreamTeamAskMaryPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name, slug").eq("slug", "dreamteam").maybeSingle();

  const { data: squad } = game
    ? await supabase
        .from("squads")
        .select("id, name, free_transfers, goal_bonus_used_gameweek, twelfth_man_used_gameweek, max_captain_used_gameweek")
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
        <Link href="/dreamteam" className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← Back to squad
        </Link>
        <Link href="/dreamteam/performance-lab" className="text-xs font-medium text-sky-400 hover:text-sky-300">
          Performance Lab →
        </Link>
      </div>
      <h1 className="mt-4 text-2xl font-semibold text-white">Ask Mary</h1>
      <p className="mt-1 text-sm text-navy-300">Your personalised Dream Team adviser</p>
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

  const { bestCaptain, viceCaptain, boosterAdvice, health, gameweekPlan, hasCalendar, seasonStarted, squadPlayers, rules, budgetRemaining } = analysis;
  const startingCount = squadPlayers.filter((p) => p.is_starting).length;
  const startingXIComplete = startingCount === rules.starting_size;

  // Same source of truth as the squad board's "Projected Points" stat
  // (player_projection_summary.hail_mary_score, which always resolves to
  // whichever gameweek is closest to now per player - see
  // dreamteam/page.tsx's own comment on this view).
  const { data: scoreRows } = await supabase
    .from("player_projection_summary")
    .select("game_player_id, hail_mary_score")
    .eq("game_slug", "dreamteam")
    .in(
      "game_player_id",
      squadPlayers.map((p) => p.game_player_id)
    )
    .returns<{ game_player_id: number; hail_mary_score: number | null }[]>();
  const scoreByGamePlayerId = new Map((scoreRows ?? []).map((r) => [r.game_player_id, Number(r.hail_mary_score ?? 0)]));
  const totalProjectedPoints = squadPlayers.reduce((sum, p) => sum + (scoreByGamePlayerId.get(p.game_player_id) ?? 0), 0);

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        {header}

        <div className="mt-6 flex flex-col gap-4">
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Current Squad</h2>
            <p className="mt-2 text-sm text-navy-200">
              {squad.name} · <span className="font-semibold text-sky-400">{totalProjectedPoints.toFixed(1)} pts projected</span> · £{budgetRemaining.toFixed(1)}m in the bank ·{" "}
              {squadPlayers.length}/{rules.squad_size} players · {seasonStarted ? `${squad.free_transfers} free transfer${squad.free_transfers === 1 ? "" : "s"}` : "Unlimited transfers (pre-season)"}
            </p>
            <Link href="/dreamteam" className="mt-3 inline-block rounded-lg border border-navy-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800">
              Manage squad
            </Link>
          </div>

          {!hasCalendar && (
            <p className="text-xs text-amber-400">No gameweek calendar published for Dream Team yet - showing the latest single projection instead of a horizon-specific one.</p>
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
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">{seasonStarted ? "Mary's Gameweek Plan" : "Pre-Season Recommendations (Unlimited Transfers)"}</h2>
            <div className="mt-2 flex flex-col gap-3">
              {gameweekPlan.length === 0 ? (
                <p className="text-sm text-navy-400">No gameweek calendar published yet to build a plan from.</p>
              ) : (
                gameweekPlan.map((step) => <GameweekPlanRow key={step.offset} step={step} squadId={squad.id} />)
              )}

              <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h3 className="text-sm font-semibold text-white">Captain &amp; Vice-Captain (Next Gameweek)</h3>
                {!bestCaptain ? (
                  <p className="mt-2 text-sm text-navy-400">Set a starting XI to get captaincy advice.</p>
                ) : (
                  <>
                    {!startingXIComplete && (
                      <p className="mt-2 text-xs text-amber-400">
                        Squad isn&apos;t fully set ({startingCount}/{rules.starting_size}) - this pick may change once it is.
                      </p>
                    )}
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <CaptainOption label="Captain" player={bestCaptain} />
                      <CaptainOption label="Vice-Captain" player={viceCaptain} />
                    </div>
                  </>
                )}
              </div>

              {boosterAdvice.length > 0 && (
                <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                  <h3 className="text-sm font-semibold text-white">Should you play a Booster?</h3>
                  <p className="mt-1 text-xs text-navy-500">Each of your 3 season Boosters can only be used once - ranked by projected value for this gameweek.</p>
                  <div className="mt-3 flex flex-col gap-2">
                    {boosterAdvice.map((b) => (
                      <div key={b.booster} className="rounded-lg border border-navy-800 bg-navy-950 p-2 text-sm">
                        <div className="flex items-center justify-between">
                          <span className={b.alreadyUsed ? "text-navy-500 line-through" : "text-white"}>{b.label}</span>
                          {!b.alreadyUsed && <span className="text-sky-400">+{b.expectedGain.toFixed(1)} pts</span>}
                        </div>
                        <p className="mt-0.5 text-[11px] text-navy-400">{b.alreadyUsed ? "Already used this season." : b.reasoning}</p>
                      </div>
                    ))}
                  </div>
                  <Link href="/dreamteam" className="mt-3 inline-block text-xs font-medium text-sky-400 hover:text-sky-300">
                    Set your Booster on the squad board →
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function CaptainOption({ label, player }: { label: string; player: { full_name: string; team_name: string; score: number; rating: number | null } | null }) {
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
