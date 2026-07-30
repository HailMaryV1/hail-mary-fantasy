import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";
import { fetchEngineExplanation, fetchPlayerOptions } from "@/lib/engineExplainability";
import GameSecondaryNav from "../GameSecondaryNav";
import PlayerSearch from "./PlayerSearch";
import EngineExplanationCard from "./EngineExplanationCard";

// The projection engine recomputes on its own schedule (refresh_all.py) -
// force-dynamic so a re-run's fresh module_detail/reconciliation shows up
// immediately instead of a cached response, same reasoning as every other
// data-driven page in this app.
export const dynamic = "force-dynamic";

const GAME_DISPLAY_NAMES: Record<string, string> = { fanteam: "FanTeam", dreamteam: "Dream Team" };

export default async function AlgorithmExplainPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string; player?: string }>;
}) {
  const { game: gameParam, player: playerParam } = await searchParams;
  const gameSlug = gameParam === "dreamteam" ? "dreamteam" : "fanteam";
  const gamePlayerId = playerParam ? Number(playerParam) : null;

  const supabase = createServerSupabaseClient();

  const [players, explanation] = await Promise.all([
    fetchPlayerOptions(supabase, gameSlug),
    gamePlayerId ? fetchEngineExplanation(supabase, gameSlug, gamePlayerId) : Promise.resolve(null),
  ]);

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <div className="mb-4">
          <GameSecondaryNav gameSlug={gameSlug} gameDisplayName={GAME_DISPLAY_NAMES[gameSlug]} />
        </div>

        <h1 className="text-2xl font-semibold text-white">Engine Validation</h1>
        <p className="mt-1 text-sm text-navy-300">
          See exactly why the projection engine likes or dislikes any player - every module&apos;s raw rate, weight,
          and contribution, before you start relying on it for real decisions.
        </p>

        <div className="mt-4 flex flex-wrap gap-1 rounded-lg bg-navy-900 p-1">
          {(["fanteam", "dreamteam"] as const).map((slug) => (
            <Link
              key={slug}
              href={`/algorithm-explain?game=${slug}`}
              prefetch={false}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                slug === gameSlug ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
              }`}
            >
              {GAME_DISPLAY_NAMES[slug]}
            </Link>
          ))}
        </div>

        <div className="mt-4">
          <PlayerSearch players={players} gameSlug={gameSlug} selectedId={gamePlayerId} />
        </div>

        <div className="mt-6">
          {!gamePlayerId ? (
            <p className="text-sm text-navy-400">Search for a player above to see their full projection breakdown.</p>
          ) : !explanation ? (
            <p className="text-sm text-red-400">No projection found for this player yet - the engine hasn&apos;t run for them.</p>
          ) : (
            <EngineExplanationCard data={explanation} />
          )}
        </div>
      </main>
    </div>
  );
}
