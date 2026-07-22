import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";
import OddsImportForm from "./OddsImportForm";

export const dynamic = "force-dynamic";

export default async function OddsImportPage() {
  const supabase = createServerSupabaseClient();

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam-golf").maybeSingle<{ id: number }>();

  let tournaments: { id: number; name: string }[] = [];
  if (game) {
    const { data } = await supabase
      .from("golf_tournaments")
      .select("id, name")
      .eq("game_id", game.id)
      .order("start_time", { ascending: false })
      .returns<{ id: number; name: string }[]>();
    tournaments = data ?? [];
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        <Link href="/golf" className="text-sm text-navy-400 hover:text-sky-300">
          ← FanTeam Golf
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">Tournament Odds Import</h1>
        <p className="mt-1 text-sm text-navy-300">
          No golf odds API covers regular weekly Tour events at a reasonable cost, so this is manual: open a
          bookmaker or odds-comparison page (e.g. Oddschecker&apos;s Winner or Top 20 Finish page for this week&apos;s
          tournament), copy the player + odds column, and paste it below - one market at a time. Handles fractional
          (11/1), American (+1200), and decimal (12.0) odds, and averages multiple bookmaker quotes on the same line.
        </p>

        <OddsImportForm tournaments={tournaments} />
      </main>
    </div>
  );
}
