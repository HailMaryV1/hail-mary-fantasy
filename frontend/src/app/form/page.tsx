import { createServerSupabaseClient } from "@/lib/supabase";
import GameSecondaryNav from "../GameSecondaryNav";
import FormTable, { type FormPlayerRow } from "./FormTable";

// Same reasoning as rankings/page.tsx - avoids a stale cached response
// when switching games via searchParams.
export const dynamic = "force-dynamic";

const GAMES = [
  { slug: "fanteam", label: "FanTeam" },
  { slug: "dreamteam", label: "Dream Team" },
  { slug: "nfl-fanteam", label: "NFL FanTeam" },
] as const;

type PoolRow = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_name: string;
  price: number;
};

type PredictionRow = {
  game_player_id: number;
  gameweek: number;
  points_difference: number | null;
};

export default async function FormPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string }>;
}) {
  const { game: gameParam } = await searchParams;
  const activeGame = GAMES.find((g) => g.slug === gameParam) ?? GAMES[0];

  const supabase = createServerSupabaseClient();

  const { data: game } = await supabase
    .from("fantasy_games")
    .select("id, display_name")
    .eq("slug", activeGame.slug)
    .maybeSingle<{ id: number; display_name: string }>();

  let rows: FormPlayerRow[] = [];

  if (game) {
    const { data: pool } = await supabase
      .from("game_player_pool")
      .select("game_player_id, full_name, position, team_name, price")
      .eq("game_slug", activeGame.slug)
      .returns<PoolRow[]>();

    const { data: predictions } = await supabase
      .from("player_gameweek_predictions")
      .select("game_player_id, gameweek, points_difference")
      .eq("game_id", game.id)
      .not("points_difference", "is", null) // completed gameweeks only - also keeps this well under PostgREST's default row cap across a full season
      .returns<PredictionRow[]>();

    // Group each player's completed-gameweek diffs, most recent first -
    // the raw shape FormTable needs to compute any windowed average
    // client-side (see lib/hailMaryForm.ts's computeWindowedAverage) while
    // the badge itself always comes from the fixed 4-GW recency window.
    const diffsByPlayer = new Map<number, { gameweek: number; diff: number }[]>();
    for (const p of predictions ?? []) {
      if (p.points_difference === null) continue;
      const list = diffsByPlayer.get(p.game_player_id);
      const entry = { gameweek: p.gameweek, diff: p.points_difference };
      if (list) list.push(entry);
      else diffsByPlayer.set(p.game_player_id, [entry]);
    }

    rows = (pool ?? [])
      .map((p) => {
        const diffs = (diffsByPlayer.get(p.game_player_id) ?? [])
          .slice()
          .sort((a, b) => b.gameweek - a.gameweek)
          .map((d) => d.diff);
        return {
          game_player_id: p.game_player_id,
          full_name: p.full_name,
          position: p.position,
          team_name: p.team_name,
          price: Number(p.price),
          diffsMostRecentFirst: diffs,
        };
      })
      .filter((r) => r.diffsMostRecentFirst.length > 0); // no completed gameweeks yet = nothing to rank
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <div className="mb-4">
          <GameSecondaryNav gameSlug={activeGame.slug} gameDisplayName={activeGame.label} />
        </div>

        <h1 className="text-2xl font-semibold text-white">Hail Mary Form</h1>
        <p className="mt-1 text-sm text-navy-300">
          Who&apos;s beating or missing Mary&apos;s own predictions - not generic fantasy form.
        </p>

        <nav className="mt-6 flex gap-2">
          {GAMES.map((g) => (
            <a
              key={g.slug}
              href={`/form?game=${g.slug}`}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                g.slug === activeGame.slug ? "bg-sky-500 text-navy-950" : "bg-navy-900 text-navy-300 hover:bg-navy-800 hover:text-white"
              }`}
            >
              {g.label}
            </a>
          ))}
        </nav>

        {!game && (
          <p className="mt-8 text-sm text-navy-300">No data for {activeGame.label} yet.</p>
        )}

        {game && rows.length === 0 && (
          <p className="mt-8 text-sm text-navy-300">
            No completed gameweeks yet for {activeGame.label} - Hail Mary Form needs at least 2 completed gameweeks
            before any player gets a badge.
          </p>
        )}

        {game && rows.length > 0 && <FormTable data={rows} />}
      </main>
    </div>
  );
}
