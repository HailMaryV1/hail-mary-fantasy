import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { STRATEGIES, type Strategy } from "@/lib/recommendationScoring";
import { runAskMaryAnalysis, CAPTAIN_HORIZONS } from "@/lib/askMaryEngine";
import GameweekPlanRow from "./GameweekPlanRow";
import AskMaryWatchlistButton from "./AskMaryWatchlistButton";
import GameSecondaryNav from "../GameSecondaryNav";

// RPC results depend on the chosen horizon/strategy/squad but Supabase's
// .rpc() POSTs to a fixed URL, so Next's fetch Data Cache could otherwise
// serve a stale response for different settings - same reasoning as
// rankings/transfers/compare pages.
export const dynamic = "force-dynamic";

type SquadPlayerForSummary = { game_player_id: number; game_players: { price: number } };

export default async function AskMaryPage({
  searchParams,
}: {
  searchParams: Promise<{ squad?: string; horizon?: string; strategy?: string }>;
}) {
  const { squad: squadParam, horizon: horizonParam, strategy: strategyParam } = await searchParams;

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Drives the Captain & Vice-Captain pick only - Mary's Recommendations
  // is always the sequential GW1/GW2/GW3 plan regardless of this setting,
  // so this control's job is just "which horizon to captain by."
  const captainHorizon = CAPTAIN_HORIZONS.find((h) => h.key === horizonParam) ?? CAPTAIN_HORIZONS[2];
  const activeStrategy = (STRATEGIES.find((s) => s.key === strategyParam)?.key ?? "balanced") as Strategy;

  const { data: fanteamGameRow } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", "fanteam").single();

  if (!fanteamGameRow) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          <h1 className="text-2xl font-semibold text-white">Ask Mary</h1>
          <p className="mt-4 text-sm text-red-400">FanTeam isn&apos;t configured on this platform yet.</p>
        </main>
      </div>
    );
  }
  const fanteamGame = fanteamGameRow;

  const { data: squadsRaw } = await supabase
    .from("squads")
    .select("id, name, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek")
    .eq("user_id", user.id)
    .eq("game_id", fanteamGame.id)
    .order("created_at", { ascending: false });

  const header = (
    <div>
      <div className="mb-4">
        <GameSecondaryNav gameSlug="fanteam" gameDisplayName={fanteamGame.display_name} />
      </div>
      <h1 className="text-2xl font-semibold text-white">Ask Mary</h1>
      <p className="mt-1 text-sm text-navy-300">Your personalised Hail Mary squad adviser</p>
    </div>
  );

  if (!squadsRaw || squadsRaw.length === 0) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-6">
            <p className="text-sm text-navy-300">
              You don&apos;t have a FanTeam squad yet - Ask Mary needs a saved squad to analyse.
            </p>
            <Link
              href="/squads/new?game=fanteam"
              className="mt-4 inline-block rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400"
            >
              Build a FanTeam squad
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const selectedSquad = squadsRaw.find((s) => s.id === Number(squadParam)) ?? squadsRaw[0];

  function askMaryUrl(overrides: Partial<{ squad: number; horizon: string; strategy: string }>) {
    const params = new URLSearchParams();
    params.set("squad", String(overrides.squad ?? selectedSquad.id));
    params.set("horizon", overrides.horizon ?? captainHorizon.key);
    params.set("strategy", overrides.strategy ?? activeStrategy);
    return `/ask-mary?${params.toString()}`;
  }

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("budget, squad_size")
    .eq("game_id", fanteamGame.id)
    .single();

  if (!rules) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <p className="mt-8 text-sm text-red-400">No FanTeam squad rules configured - can&apos;t validate a squad without them.</p>
        </main>
      </div>
    );
  }
  // Reassigned to a plain non-null const - TypeScript's control-flow
  // narrowing from the guard above doesn't carry into the nested
  // renderSquadSummary function declaration below.
  const squadRules = rules;

  // Lightweight pre-check before running the full analysis engine -
  // an incomplete squad still needs its own summary/warning UI, which
  // runAskMaryAnalysis (which assumes a valid squad) doesn't produce.
  const { data: squadPlayersForSummary } = await supabase
    .from("squad_players")
    .select("game_player_id, game_players(price)")
    .eq("squad_id", selectedSquad.id)
    .returns<SquadPlayerForSummary[]>();
  const squadPlayerCount = (squadPlayersForSummary ?? []).length;
  const totalPrice = (squadPlayersForSummary ?? []).reduce((sum, p) => sum + Number(p.game_players.price), 0);
  const preCheckBudgetRemaining = Number(rules.budget) - totalPrice;
  const squadValid = squadPlayerCount === rules.squad_size;

  // Squad selector + settings controls (shared across all states below).
  const squadSelector = squadsRaw.length > 1 && (
    <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-navy-900 p-1">
      {squadsRaw.map((s) => (
        <Link
          key={s.id}
          href={askMaryUrl({ squad: s.id })}
          prefetch={false}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${
            s.id === selectedSquad.id ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
          }`}
        >
          {s.name}
        </Link>
      ))}
    </div>
  );

  const settingsPanel = (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Analysis Settings</h2>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-navy-500">Captain planning horizon</p>
          <div className="mt-1 flex flex-wrap gap-1 rounded-lg bg-navy-950 p-1">
            {CAPTAIN_HORIZONS.map((h) => (
              <Link
                key={h.key}
                href={askMaryUrl({ horizon: h.key })}
                prefetch={false}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  h.key === captainHorizon.key ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
                }`}
              >
                {h.label}
              </Link>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-navy-500">Strategy</p>
          <div className="mt-1 flex flex-wrap gap-1 rounded-lg bg-navy-950 p-1">
            {STRATEGIES.map((s) => (
              <Link
                key={s.key}
                href={askMaryUrl({ strategy: s.key })}
                prefetch={false}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  s.key === activeStrategy ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
                }`}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  function renderSquadSummary(budgetRemaining: number, playerCount: number, freeTransfers: number) {
    return (
      <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Current Squad</h2>
        <p className="mt-2 text-sm text-navy-200">
          {selectedSquad.name} · £{budgetRemaining.toFixed(1)}m in the bank · {playerCount}/{squadRules.squad_size} players ·{" "}
          {freeTransfers} free transfer{freeTransfers === 1 ? "" : "s"}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`/squads/${selectedSquad.id}`} className="rounded-lg border border-navy-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800">
            Manage squad
          </Link>
        </div>
      </div>
    );
  }

  if (!squadValid) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-3xl">
          {header}
          {squadSelector}
          <div className="mt-4 flex flex-col gap-4">
            {renderSquadSummary(preCheckBudgetRemaining, squadPlayerCount, selectedSquad.free_transfers)}
            <div className="rounded-xl border border-amber-800 bg-amber-950/30 p-4">
              <p className="text-sm text-amber-300">
                {selectedSquad.name} has {squadPlayerCount} of the required {rules.squad_size} players. Finish
                building your squad before asking Mary for advice.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // No recordPredictionsFn here - viewing/exploring an analysis
  // shouldn't archive anything. Predictions are only recorded once, at
  // the moment the user presses Save Team on the squad page (see
  // squads/actions.ts's saveTeamForGameweek and migration 0043's
  // docstring) - that's the one point "what Mary suggested" is being
  // compared against a squad that's actually final, not mid-tinkering.
  const analysis = await runAskMaryAnalysis(supabase, selectedSquad, fanteamGame, activeStrategy, captainHorizon.gameweeks);

  if (!analysis) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <p className="mt-8 text-sm text-red-400">Couldn&apos;t run the analysis for this squad - try again shortly.</p>
        </main>
      </div>
    );
  }

  const { bestCaptain, viceCaptain, health, gameweekPlan, monitorList, hasCalendar, seasonStarted } = analysis;

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div>
          {header}
          {squadSelector}

          <div className="mt-4 flex flex-col gap-4">
            {settingsPanel}
            {renderSquadSummary(analysis.budgetRemaining, analysis.squadPlayers.length, selectedSquad.free_transfers)}

            {!hasCalendar && (
              <p className="text-xs text-amber-400">
                No gameweek calendar published for FanTeam yet - showing the latest single projection instead of a
                horizon-specific one.
              </p>
            )}

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Squad Health Check</h2>
              <div className="mt-2 rounded-xl border border-navy-700 bg-navy-900 p-4">
                <div className="flex items-center gap-3">
                  <span className="text-3xl font-bold text-sky-400">{health.rating}</span>
                  <span className="text-sm text-navy-400">/ 100 squad rating</span>
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
                {health.strengths.length === 0 && health.weaknesses.length === 0 && (
                  <p className="mt-3 text-sm text-navy-400">Not enough data yet to assess strengths or weaknesses in detail.</p>
                )}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">
                {seasonStarted ? "Mary's Gameweek Plan" : "Pre-Season Recommendations (Unlimited Transfers)"}
              </h2>
              <div className="mt-2 flex flex-col gap-3">
                {gameweekPlan.length === 0 ? (
                  <p className="text-sm text-navy-400">No gameweek calendar published yet to build a plan from.</p>
                ) : (
                  gameweekPlan.map((step) => (
                    <GameweekPlanRow key={step.offset} step={step} squadId={selectedSquad.id} gameId={fanteamGame.id} />
                  ))
                )}

                <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                  <h3 className="text-sm font-semibold text-white">Captain &amp; Vice-Captain - {captainHorizon.label}</h3>
                  {!bestCaptain ? (
                    <p className="mt-2 text-sm text-navy-400">Set a starting XI to get captaincy advice.</p>
                  ) : (
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <CaptainOption label="Captain" player={bestCaptain} />
                      <CaptainOption label="Vice-Captain" player={viceCaptain} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="flex flex-col gap-4">
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Players to Watch</h2>
            {monitorList.length === 0 ? (
              <p className="mt-2 text-xs text-navy-400">No new fixture-swing targets within your planning window right now.</p>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                {monitorList.map((p) => (
                  <div key={p.gamePlayerId} className="rounded-lg border border-navy-800 bg-navy-950 p-2">
                    <p className="text-sm font-medium text-white">{p.fullName}</p>
                    <p className="text-[11px] text-navy-400">
                      {p.position} · {p.teamName} · £{p.price.toFixed(1)}m · HMS {p.hailMaryScore != null ? p.hailMaryScore.toFixed(1) : "-"}
                    </p>
                    <p className="mt-0.5 text-[11px] text-emerald-400">Fixture swing begins GW{p.startsInGameweek}</p>
                    <div className="mt-1.5">
                      <AskMaryWatchlistButton
                        gameId={fanteamGame.id}
                        gamePlayerId={p.gamePlayerId}
                        defaultReasons={["fixture_swing"]}
                        notes={`Added from ASK MARY - positive fixture swing begins GW${p.startsInGameweek}.`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function CaptainOption({
  label,
  player,
}: {
  label: string;
  player: { full_name: string; team_name: string; score: number } | null;
}) {
  return (
    <div className="rounded-lg border border-navy-800 bg-navy-950 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-sky-400">{label}</p>
      {player ? (
        <>
          <p className="mt-1 text-sm font-medium text-white">{player.full_name}</p>
          <p className="text-[11px] text-navy-400">
            {player.team_name} · HMS {player.score.toFixed(1)}
          </p>
        </>
      ) : (
        <p className="mt-1 text-xs text-navy-500">Not available.</p>
      )}
    </div>
  );
}
