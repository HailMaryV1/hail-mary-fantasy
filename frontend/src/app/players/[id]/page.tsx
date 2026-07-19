import Link from "next/link";
import { Fragment } from "react";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase";
import StatusPill from "../../StatusPill";
import { resolveStatusBadge } from "@/lib/playerStatus";

// See rankings/page.tsx for why this is needed - Supabase's .rpc() POSTs
// to a fixed URL regardless of parameters, so Next's fetch Data Cache can
// serve a stale horizon's response for a different horizon's request.
export const dynamic = "force-dynamic";

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

  const { data: statusRow } = await supabase
    .from("game_player_pool")
    .select("lineup, status")
    .eq("game_player_id", gamePlayerId)
    .maybeSingle<{ lineup: string | null; status: string | null }>();
  const statusBadge = resolveStatusBadge(statusRow?.lineup ?? null, statusRow?.status ?? null);
  // Only the heavily-discounted statuses (injured/suspended/benched/not in
  // squad/gameweek off) make the fixture-by-fixture breakdown below look
  // wrong at a glance (it shows the pre-discount per-fixture math, since
  // the multiplier applies once to the total - see compute_projections.py) -
  // a light discount (might start/expected) doesn't need this called out.
  const showStatusCaveat = statusBadge && statusBadge.tone !== "green";

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <Link
          href={`/rankings?game=${summary.game_slug}`}
          className="text-sm text-navy-400 hover:text-sky-300"
        >
          ← Back to rankings
        </Link>

        <h1 className="mt-3 flex items-center text-2xl font-semibold text-white">
          {summary.full_name}
          <StatusPill lineup={statusRow?.lineup} status={statusRow?.status} />
        </h1>
        <p className="mt-1 text-sm text-navy-300">
          {summary.team_name} · {summary.position} · £{Number(summary.price).toFixed(1)}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-navy-400">Planning horizon</span>
          <div className="flex gap-1 rounded-lg bg-navy-900 p-1">
            {HORIZONS.map((h) => (
              <Link
                key={h.key}
                href={`/players/${gamePlayerId}?horizon=${h.key}`}
                prefetch={false}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  h.key === activeHorizon.key
                    ? "bg-sky-500 text-navy-950"
                    : "text-navy-300 hover:text-white"
                }`}
              >
                {h.label}
              </Link>
            ))}
          </div>
          {!horizonSummary && (
            <span className="text-xs text-amber-400">
              No gameweek calendar published for this game yet - showing the latest single projection instead.
            </span>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <p className="text-xs uppercase tracking-wide text-navy-400">Hail Mary Score</p>
            <p className="mt-1 text-xl font-semibold text-sky-400">
              {Number(summary.hail_mary_score).toFixed(1)}
            </p>
            {horizonSummary && activeHorizon.gameweeks > 1 && (
              <p className="mt-0.5 text-xs text-navy-400">avg over {horizonSummary.gameweeks_included} gameweek{horizonSummary.gameweeks_included === 1 ? "" : "s"}</p>
            )}
          </div>
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <p className="text-xs uppercase tracking-wide text-navy-400">Points / 90</p>
            <p className="mt-1 text-xl font-semibold text-white">
              {Number(summary.points_per_90).toFixed(1)}
            </p>
            <p className="mt-0.5 text-xs text-navy-400">last season, shrinkage-adjusted</p>
          </div>
          <div className="col-span-2 rounded-xl border border-navy-700 bg-navy-900 p-4 sm:col-span-1">
            <p className="text-xs uppercase tracking-wide text-navy-400">{horizonSummary ? "Gameweeks" : "Period"}</p>
            <p className="mt-1 text-xl font-semibold text-white">
              {horizonSummary
                ? `GW${horizonSummary.start_gameweek}${activeHorizon.gameweeks > 1 ? ` – ${horizonSummary.start_gameweek + activeHorizon.gameweeks - 1}` : ""}`
                : `${formatDate(summary.period_start)} – ${formatDate(summary.period_end)}`}
            </p>
          </div>
        </div>

        <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-navy-400">
          How this score was built
        </h2>
        <p className="mt-1 text-sm text-navy-300">
          {activeHorizon.gameweeks > 1
            ? `Every fixture across the selected ${activeHorizon.gameweeks}-gameweek window, added up then averaged per gameweek.`
            : "Points/90 × fixture factor, per fixture. Fixture factor centers on 1.0 - above is a favourable fixture, below is tough."}
        </p>
        {showStatusCaveat && (
          <p className="mt-1 text-xs text-amber-400">
            The fixture breakdown below is the full-fitness projection - the Hail Mary Score above is
            discounted for this player&apos;s status ({statusBadge!.label}).
          </p>
        )}

        <div className="mt-3 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
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
                  <tr className="border-b border-navy-800 last:border-0">
                    {showGameweeks && (
                      <td className="px-4 py-3 text-navy-400">{fx.gameweek}</td>
                    )}
                    <td className="px-4 py-3 text-white">
                      {fx.is_home ? "vs" : "@"} {fx.opponent}
                      <span className="block text-xs font-normal text-navy-400">
                        {formatDate(fx.kickoff_at)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-navy-300">
                      {(Number(fx.attack_score) * 100).toFixed(0)}%
                    </td>
                    <td className="px-4 py-3 text-right text-navy-300">
                      {(Number(fx.clean_sheet_score) * 100).toFixed(0)}%
                    </td>
                    <td className="px-4 py-3 text-right text-navy-300">
                      {Number(fx.fixture_factor).toFixed(2)}×
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-sky-400">
                      +{Number(fx.contribution).toFixed(1)}
                    </td>
                  </tr>
                  {fx.stats && (
                    <tr className="border-b border-navy-800 bg-navy-950/60 last:border-0">
                      <td colSpan={showGameweeks ? 6 : 5} className="px-4 py-2">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-navy-400">
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
                  <td colSpan={showGameweeks ? 6 : 5} className="px-4 py-8 text-center text-navy-400">
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
