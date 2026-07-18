import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";
import PlayerTable, { type ProjectionRow } from "../PlayerTable";

// Supabase's .rpc() always POSTs to the same URL regardless of parameters
// (they're in the body, not the URL) - Next's fetch Data Cache can key
// purely by URL and end up serving one horizon's cached RPC response for
// a different horizon's request. force-dynamic disables fetch caching
// for every request in this page, not just route-level rendering (which
// searchParams usage already forces on its own) - confirmed necessary by
// reproducing the bug: server logs showed a genuine fresh GET per click,
// yet the score stayed frozen at the previous horizon's value.
export const dynamic = "force-dynamic";

type FullProjectionRow = ProjectionRow & {
  period_start?: string;
  period_end?: string;
};

type HorizonRow = {
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

const GAMES = [
  { slug: "dreamteam", label: "Dream Team" },
  { slug: "fanteam", label: "FanTeam" },
] as const;

const HORIZONS = [
  { key: "short", label: "Short (1 GW)", gameweeks: 1 },
  { key: "medium", label: "Medium (2 GW avg)", gameweeks: 2 },
  { key: "long", label: "Long (3 GW avg)", gameweeks: 3 },
] as const;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string; horizon?: string }>;
}) {
  const { game: gameParam, horizon: horizonParam } = await searchParams;
  const activeGame = GAMES.find((g) => g.slug === gameParam) ?? GAMES[0];
  const activeHorizon = HORIZONS.find((h) => h.key === horizonParam) ?? HORIZONS[0];

  const supabase = createServerSupabaseClient();

  // Gameweek-based horizon averaging only works for games with a real
  // published calendar (currently FanTeam - see migration 0016). Try it
  // first; an empty result means this game doesn't support it yet.
  const { data: horizonData, error: horizonError } = await supabase
    .rpc("player_score_by_horizon", { p_game_slug: activeGame.slug, p_num_gameweeks: activeHorizon.gameweeks })
    .returns<HorizonRow[]>();

  const horizonAvailable = !horizonError && horizonData && horizonData.length > 0;

  let data: FullProjectionRow[] | null = null;
  let error = horizonAvailable ? null : null;

  if (horizonAvailable) {
    data = horizonData!.map((r) => ({
      game_player_id: r.game_player_id,
      full_name: r.full_name,
      position: r.position,
      team_name: r.team_name,
      price: r.price,
      hail_mary_score: r.avg_score,
      points_per_90: r.points_per_90,
    }));
  } else {
    // Fall back to the single latest-computed projection (Dream Team,
    // or any game without a gameweek calendar yet).
    const fallback = await supabase
      .from("player_projection_summary")
      .select("*")
      .eq("game_slug", activeGame.slug)
      .order("hail_mary_score", { ascending: false })
      .limit(1000)
      .returns<FullProjectionRow[]>();
    data = fallback.data;
    error = fallback.error;
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold text-white">
          Hail Mary Score
        </h1>
        <p className="mt-1 text-sm text-navy-300">
          Player rankings, algorithm v1
        </p>

        <nav className="mt-6 flex gap-2">
          {GAMES.map((g) => (
            <Link
              key={g.slug}
              href={`/rankings?game=${g.slug}&horizon=${activeHorizon.key}`}
              prefetch={false}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                g.slug === activeGame.slug
                  ? "bg-sky-500 text-navy-950"
                  : "bg-navy-900 text-navy-300 hover:bg-navy-800 hover:text-white"
              }`}
            >
              {g.label}
            </Link>
          ))}
        </nav>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-navy-400">
            Planning horizon
          </span>
          <div className="flex gap-1 rounded-lg bg-navy-900 p-1">
            {HORIZONS.map((h) => (
              <Link
                key={h.key}
                href={`/rankings?game=${activeGame.slug}&horizon=${h.key}`}
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
          {!horizonAvailable && (
            <span className="text-xs text-amber-400">
              Gameweek calendar not published for {activeGame.label} yet - showing latest single projection instead.
            </span>
          )}
        </div>

        {error && (
          <p className="mt-8 rounded-lg bg-red-950 p-4 text-sm text-red-300">
            Failed to load projections: {error.message}
          </p>
        )}

        {!error && (!data || data.length === 0) && (
          <p className="mt-8 text-sm text-navy-300">
            No projections found for {activeGame.label} yet. Run{" "}
            <code className="rounded bg-navy-800 px-1 py-0.5">
              compute_projections.py
            </code>{" "}
            for this game first.
          </p>
        )}

        {data && data.length > 0 && (
          <>
            <p className="mt-8 text-xs text-navy-400">
              {horizonAvailable
                ? `Gameweek ${horizonData![0].start_gameweek}${activeHorizon.gameweeks > 1 ? ` – ${horizonData![0].start_gameweek + activeHorizon.gameweeks - 1}` : ""} average`
                : data[0].period_start && data[0].period_end
                  ? `${formatDate(data[0].period_start)} – ${formatDate(data[0].period_end)}`
                  : null}
            </p>
            <PlayerTable data={data} horizon={activeHorizon.key} />
          </>
        )}
      </main>
    </div>
  );
}
