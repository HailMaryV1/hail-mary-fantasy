import Link from "next/link";
import TournamentBuilder from "./TournamentBuilder";

export default function GolfImportPage() {
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
          <TournamentBuilder />
        </div>
      </main>
    </div>
  );
}
