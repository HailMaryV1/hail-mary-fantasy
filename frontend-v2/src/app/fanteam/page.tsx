import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

export const dynamic = "force-dynamic";

type SquadRow = { id: number; name: string };

export default async function FanTeamHubPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", "fanteam").maybeSingle();

  let squads: SquadRow[] = [];
  if (game) {
    const { data } = await supabase
      .from("squads")
      .select("id, name")
      .eq("game_id", game.id)
      .eq("user_id", user.id)
      .eq("is_archived", false)
      .order("created_at")
      .returns<SquadRow[]>();
    squads = data ?? [];
  }

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← Back to main menu
        </Link>

        <h1 className="mt-4 text-2xl font-semibold text-white">{game?.display_name ?? "FanTeam"}</h1>
        <p className="mt-1 text-sm text-navy-300">Pick a squad, or start a new one - FanTeam lets you hold several entries at once.</p>

        <div className="mt-6 flex flex-col gap-2">
          {squads.map((s) => (
            <Link
              key={s.id}
              href={`/fanteam/${s.id}`}
              className="rounded-xl border border-navy-700 bg-navy-900 px-4 py-3 text-sm font-medium text-navy-100 transition-colors hover:border-sky-500 hover:text-white"
            >
              {s.name || `Squad #${s.id}`}
            </Link>
          ))}
          {squads.length === 0 && <p className="text-sm text-navy-300">No squads yet.</p>}
        </div>

        <Link href="/squads/new?game=fanteam" className="mt-4 inline-block text-sm font-medium text-sky-400 hover:text-sky-300">
          + New squad
        </Link>
        <Link href="/fanteam/sync-setup" className="mt-2 block text-sm font-medium text-navy-400 hover:text-sky-400">
          Keep FanTeam syncing →
        </Link>
      </div>
    </div>
  );
}
