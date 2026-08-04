import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";
import TournamentBuilder from "./TournamentBuilder";

export const dynamic = "force-dynamic";

export default async function GolfImportPage() {
  const supabase = createServerSupabaseClient();
  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam-golf").maybeSingle<{ id: number }>();

  let existingTournaments: { id: number; fanteamTournamentId: string; name: string }[] = [];
  if (game) {
    const { data } = await supabase
      .from("golf_tournaments")
      .select("id, fanteam_tournament_id, name")
      .eq("game_id", game.id)
      .order("start_time", { ascending: false })
      .returns<{ id: number; fanteam_tournament_id: string; name: string }[]>();
    existingTournaments = (data ?? []).map((t) => ({ id: t.id, fanteamTournamentId: t.fanteam_tournament_id, name: t.name }));
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <Link href="/golf" className="text-sm text-navy-400 hover:text-sky-300">
          ← FanTeam Golf
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">Tournament Builder</h1>
        <p className="mt-1 text-sm text-navy-300">
          Import this week&apos;s field, add bookmaker odds, then compute Hail Mary Golf&apos;s picks - three steps,
          start to finish.
        </p>

        <div className="mt-6">
          <TournamentBuilder existingTournaments={existingTournaments} />
        </div>
      </main>
    </div>
  );
}
