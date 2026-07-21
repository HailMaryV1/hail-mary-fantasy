import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";
import CourseHistoryImportForm from "./CourseHistoryImportForm";

export const dynamic = "force-dynamic";

export default async function CourseHistoryImportPage() {
  const supabase = createServerSupabaseClient();

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam-golf").maybeSingle<{ id: number }>();

  let tournaments: { id: number; name: string; course_id: number | null }[] = [];
  if (game) {
    const { data } = await supabase
      .from("golf_tournaments")
      .select("id, name, course_id")
      .eq("game_id", game.id)
      .order("start_time", { ascending: false })
      .returns<{ id: number; name: string; course_id: number | null }[]>();
    tournaments = data ?? [];
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        <Link href="/golf" className="text-sm text-navy-400 hover:text-sky-300">
          ← FanTeam Golf
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">Course History Import</h1>
        <p className="mt-1 text-sm text-navy-300">
          FanTeam&apos;s API has no course-specific history, only golfers&apos; global career stats. This imports real
          course history from{" "}
          <a href="https://datagolf.com/course-history-tool" target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300">
            DataGolf&apos;s Course History tool
          </a>{" "}
          - download the CSV export for the upcoming tournament&apos;s course each week and upload it here. This is a
          separate signal from course fit, not a replacement for it - a course a golfer has never played gets no
          fabricated history, only an honest gap.
        </p>

        <CourseHistoryImportForm tournaments={tournaments} />
      </main>
    </div>
  );
}
