import Link from "next/link";
import { Fragment } from "react";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase";

type SummaryRow = {
  game_slug: string;
  full_name: string;
  position: string;
  team_name: string;
  price: number;
  hail_mary_score: number;
  points_per_90: number;
  period_start: string;
  period_end: string;
};

type HorizonSummaryRow = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_name: string;
  price: number;
  avg_score: number;
  points_per_90: number;
  gameweeks_included: number;
  start_gameweek: number;
};

type FixtureRow = {
  fixture_id: number;
  kickoff_at: string;
  opponent: string;
  is_home: boolean;
  attack_score: number;
  clean_sheet_score: number;
  fixture_factor: number;
  contribution: number;
};

type HorizonFixtureRow = FixtureRow & { projection_id: number; gameweek: number; stats: StatBreakdown | null };

type StatBreakdown = Record<string, { projected: number; points_each: number; contribution: number }>;

const HORIZONS = [
  { key: "short", label: "Short (1 GW)", gameweeks: 1 },
  { key: "medium", label: "Medium (2 GW avg)", gameweeks: 2 },
  { key: "long", label: "Long (3 GW avg)", gameweeks: 3 },
] as const;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function formatStatLabel(stat: string) {
  return stat.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export default async function PlayerDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ horizon?: string }>;
}) {
  const { id } = await params;
  const { horizon: horizonParam } = await searchParams;
  const gamePlayerId = Number(id);
  if (!Number.isInteger(gamePlayerId)) notFound();
  const activeHorizon = HORIZONS.find((h) => h.key === horizonParam) ?? HORIZONS[0];

  const supabase = createServerSupabaseClient();

  const { data: gamePlayer } = await supabase
    .from("game_players")
    .select("fantasy_games(slug)")
    .eq("id", gamePlayerId)
    .maybeSingle<{ fantasy_games: { slug: string } }>();
  if (!gamePlayer) notFound();
  const gameSlug = gamePlayer.fantasy_games.slug;

  // Prefer the horizon-aware path (next upcoming gameweek onward, matching
  // exactly what the rankings page's Short/Medium/Long toggle showed) -
  // only available for games with a published gameweek calendar (query
  // returns empty for Dream Team, which has none). Falls back to the
  // single latest-computed projection otherwise.
  const { data: horizonSummaryRows } = await supabase
    .rpc("player_score_by_horizon", { p_game_slug: gameSlug, p_num_gameweeks: activeHorizon.gameweeks })
    .eq("game_player_id", gamePlayerId)
    .returns<HorizonSummaryRow[]>();
  const horizonSummary = horizonSummaryRows?.[0] ?? null;

  let summary: SummaryRow | null = null;
  let horizonFixtures: HorizonFixtureRow[] | null = null;
  let fixtures: FixtureRow[] | null = null;

  if (horizonSummary) {
    summary = {
      game_slug: gameSlug,
      full_name: horizonSummary.full_name,
      position: horizonSummary.position,
      team_name: horizonSummary.team_name,
      price: horizonSummary.price,
      hail_mary_score: horizonSummary.avg_score,
      points_per_90: horizonSummary.points_per_90,
      period_start: "",
      period_end: "",
    };
    const { data } = await supabase
      .rpc("player_projection_fixtures_by_horizon", { p_game_player_id: gamePlayerId, p_num_gameweeks: activeHorizon.gameweeks })
      .returns<HorizonFixtureRow[]>();
    horizonFixtures = data;
  } else {
    const { data: summaryRow } = await supabase
      .from("player_projection_summary")
      .select("*")
      .eq("game_player_id", gamePlayerId)
      .maybeSingle<SummaryRow>();
    if (!summaryRow) notFound();
    summary = summaryRow;

    const { data } = await supabase
      .from("player_projection_fixtures")
      .select("*")
      .eq("game_player_id", gamePlayerId)
      .order("kickoff_at")
      .returns<FixtureRow[]>();
    fixtures = data;
  }

  const displayFixtures: HorizonFixtureRow[] = horizonFixtures ?? (fixtures ?? []).map((fx) => ({ ...fx, projection_id: fx.fixture_id, gameweek: 0, stats: null }));
  const showGameweeks = horizonFixtures !== null;

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black">
      <main className="mx-auto max-w-2xl">
        <Link
          href={`/?game=${summary.game_slug}`}
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          ← Back to rankings
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-black dark:text-zinc-50">
          {summary.full_name}
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {summary.team_name} · {summary.position} · £{Number(summary.price).toFixed(1)}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Planning horizon</span>
          <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
            {HORIZONS.map((h) => (
              <Link
                key={h.key}
                href={`/players/${gamePlayerId}?horizon=${h.key}`}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  h.key === activeHorizon.key
                    ? "bg-white text-black shadow-sm dark:bg-zinc-700 dark:text-white"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                {h.label}
              </Link>
            ))}
          </div>
          {!horizonSummary && (
            <span className="text-xs text-amber-600 dark:text-amber-500">
              No gameweek calendar published for this game yet - showing the latest single projection instead.
            </span>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-xs uppercase tracking-wide text-zinc-500">Hail Mary Score</p>
            <p className="mt-1 text-xl font-semibold text-black dark:text-zinc-50">
              {Number(summary.hail_mary_score).toFixed(1)}
            </p>
            {horizonSummary && activeHorizon.gameweeks > 1 && (
              <p className="mt-0.5 text-xs text-zinc-500">avg over {horizonSummary.gameweeks_included} gameweek{horizonSummary.gameweeks_included === 1 ? "" : "s"}</p>
            )}
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-xs uppercase tracking-wide text-zinc-500">Points / 90</p>
            <p className="mt-1 text-xl font-semibold text-black dark:text-zinc-50">
              {Number(summary.points_per_90).toFixed(1)}
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">last season, shrinkage-adjusted</p>
          </div>
          <div className="col-span-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950 sm:col-span-1">
            <p className="text-xs uppercase tracking-wide text-zinc-500">{horizonSummary ? "Gameweeks" : "Period"}</p>
            <p className="mt-1 text-xl font-semibold text-black dark:text-zinc-50">
              {horizonSummary
                ? `GW${horizonSummary.start_gameweek}${activeHorizon.gameweeks > 1 ? ` – ${horizonSummary.start_gameweek + activeHorizon.gameweeks - 1}` : ""}`
                : `${formatDate(summary.period_start)} – ${formatDate(summary.period_end)}`}
            </p>
          </div>
        </div>

        <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          How this score was built
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {activeHorizon.gameweeks > 1
            ? `Every fixture across the selected ${activeHorizon.gameweeks}-gameweek window, added up then averaged per gameweek.`
            : "Points/90 × fixture factor, per fixture. Fixture factor centers on 1.0 - above is a favourable fixture, below is tough."}
        </p>

        <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
                {showGameweeks && <th className="px-4 py-3 font-medium">GW</th>}
                <th className="px-4 py-3 font-medium">Fixture</th>
                <th className="px-4 py-3 text-right font-medium">Attack</th>
                <th className="px-4 py-3 text-right font-medium">Clean sheet</th>
                <th className="px-4 py-3 text-right font-medium">Factor</th>
                <th className="px-4 py-3 text-right font-medium">Points added</th>
              </tr>
            </thead>
            <tbody>
              {displayFixtures.map((fx) => (
                <Fragment key={fx.projection_id + "-" + fx.fixture_id}>
                  <tr
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                  >
                    {showGameweeks && (
                      <td className="px-4 py-3 text-zinc-500">{fx.gameweek}</td>
                    )}
                    <td className="px-4 py-3 text-black dark:text-zinc-50">
                      {fx.is_home ? "vs" : "@"} {fx.opponent}
                      <span className="block text-xs font-normal text-zinc-500">
                        {formatDate(fx.kickoff_at)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                      {(Number(fx.attack_score) * 100).toFixed(0)}%
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                      {(Number(fx.clean_sheet_score) * 100).toFixed(0)}%
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                      {Number(fx.fixture_factor).toFixed(2)}×
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-black dark:text-zinc-50">
                      +{Number(fx.contribution).toFixed(1)}
                    </td>
                  </tr>
                  {fx.stats && (
                    <tr className="border-b border-zinc-100 bg-zinc-50 last:border-0 dark:border-zinc-900 dark:bg-zinc-900/40">
                      <td colSpan={showGameweeks ? 6 : 5} className="px-4 py-2">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                          {Object.entries(fx.stats)
                            .filter(([, s]) => Math.abs(s.contribution) > 0.01)
                            .sort(([, a], [, b]) => Math.abs(b.contribution) - Math.abs(a.contribution))
                            .map(([stat, s]) => (
                              <span key={stat}>
                                {formatStatLabel(stat)}: {s.projected.toFixed(2)} × {s.points_each}pt = {s.contribution >= 0 ? "+" : ""}{s.contribution.toFixed(2)}
                              </span>
                            ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {displayFixtures.length === 0 && (
                <tr>
                  <td colSpan={showGameweeks ? 6 : 5} className="px-4 py-8 text-center text-zinc-500">
                    No fixtures in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
