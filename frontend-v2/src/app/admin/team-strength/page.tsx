import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { listPremierLeagueTeamStrength } from "@/lib/teamStrengthAdmin";
import TeamStrengthTable from "./TeamStrengthTable";

export const dynamic = "force-dynamic";

export default async function TeamStrengthAdminPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const rows = await listPremierLeagueTeamStrength();

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← Home
        </Link>

        <h1 className="mt-4 text-2xl font-semibold text-white">Team Strength</h1>
        <p className="mt-1 text-sm text-navy-300">
          Premier League fixture-difficulty fallback, adjustable by hand for when form shifts mid-season. Only used
          before real bookmaker odds are posted for a fixture - once they land, real odds always win. Blank reverts
          a team to the automated baseline shown alongside it.
        </p>

        <div className="mt-6">
          <TeamStrengthTable initialRows={rows} />
        </div>
      </div>
    </div>
  );
}
