import Link from "next/link";
import ImportForm from "./ImportForm";

export default function GolfImportPage() {
  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <Link href="/golf" className="text-sm text-navy-400 hover:text-sky-300">
          ← FanTeam Golf
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">Import a tournament</h1>
        <p className="mt-1 text-sm text-navy-300">
          Paste the current FanTeam Golf contest URL - a new one drops every week. Safe to re-run against the same
          tournament any time (prices/stats update in place, nothing duplicates).
        </p>

        <div className="mt-6">
          <ImportForm />
        </div>
      </main>
    </div>
  );
}
