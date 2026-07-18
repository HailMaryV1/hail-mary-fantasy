import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

type SquadRow = {
  id: number;
  name: string;
  created_at: string;
  game_id: number;
  fantasy_games: { display_name: string; slug: string };
};

type RulesRow = { game_id: number; squad_size: number; starting_size: number };

export default async function SquadsPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: squads } = await supabase
    .from("squads")
    .select("id, name, created_at, game_id, fantasy_games(display_name, slug)")
    .eq("user_id", user!.id)
    .order("created_at", { ascending: false })
    .returns<SquadRow[]>();

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("game_id, squad_size, starting_size")
    .returns<RulesRow[]>();
  const rulesByGame = new Map((rules ?? []).map((r) => [r.game_id, r]));

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black">
      <main className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">My Squads</h1>
          <div className="flex gap-2">
            <Link
              href="/squads/new?game=dreamteam"
              className="rounded-lg bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              + Dream Team squad
            </Link>
            <Link
              href="/squads/new?game=fanteam"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
            >
              + FanTeam squad
            </Link>
          </div>
        </div>

        {(!squads || squads.length === 0) && (
          <p className="mt-8 text-sm text-zinc-600 dark:text-zinc-400">
            No squads yet - build one above.
          </p>
        )}

        <div className="mt-6 flex flex-col gap-2">
          {squads?.map((squad) => {
            const hasBench = (rulesByGame.get(squad.game_id)?.squad_size ?? 0) > (rulesByGame.get(squad.game_id)?.starting_size ?? 0);
            return (
              <div
                key={squad.id}
                className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium text-black dark:text-zinc-50">{squad.name}</p>
                  <p className="text-xs text-zinc-500">{squad.fantasy_games.display_name}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {hasBench && (
                    <Link
                      href={`/squads/${squad.id}/lineup`}
                      className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-black hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-800"
                    >
                      Set starting XI
                    </Link>
                  )}
                  <Link
                    href={`/squads/${squad.id}/transfers`}
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-black hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-800"
                  >
                    Transfers
                  </Link>
                  <Link
                    href={`/squads/${squad.id}/captain`}
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-black hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-800"
                  >
                    Captain
                  </Link>
                  <Link
                    href={`/squads/${squad.id}/analysis`}
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-black hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-800"
                  >
                    Look ahead
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
