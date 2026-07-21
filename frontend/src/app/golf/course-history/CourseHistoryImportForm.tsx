"use client";

import { useRef, useState, useTransition } from "react";
import { importCourseHistory, type CourseHistoryImportResult } from "./actions";

export default function CourseHistoryImportForm({
  tournaments,
}: {
  tournaments: { id: number; name: string; course_id: number | null }[];
}) {
  const [courseName, setCourseName] = useState("");
  const [tournamentId, setTournamentId] = useState<string>("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [result, setResult] = useState<CourseHistoryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setFileName(null);
      setCsvText(null);
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!csvText) {
      setError("Choose the DataGolf course-history CSV file first.");
      return;
    }
    startTransition(async () => {
      const { result, error } = await importCourseHistory(courseName, csvText, tournamentId ? Number(tournamentId) : null);
      if (error) setError(error);
      else if (result) {
        setResult(result);
        setFileName(null);
        setCsvText(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    });
  }

  return (
    <div className="mt-8">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="text-xs uppercase tracking-wide text-navy-400">Course name</label>
          <input
            type="text"
            value={courseName}
            onChange={(e) => setCourseName(e.target.value)}
            placeholder="TPC Twin Cities"
            className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-navy-400">Link to tournament (optional)</label>
          <select
            value={tournamentId}
            onChange={(e) => setTournamentId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-400/40"
          >
            <option value="">Don&apos;t link - just store the course</option>
            {tournaments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.course_id ? " (already linked to a course)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-navy-400">DataGolf CSV export</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="mt-1 w-full text-sm text-navy-300 file:mr-3 file:rounded-lg file:border-0 file:bg-navy-800 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-navy-700"
          />
          {fileName && <p className="mt-1 text-xs text-navy-400">Selected: {fileName}</p>}
        </div>

        <button
          type="submit"
          disabled={isPending || !csvText || !courseName.trim()}
          className="self-start rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? "Importing..." : "Import course history"}
        </button>
      </form>

      {error && <p className="mt-4 rounded-lg bg-red-950 p-4 text-sm text-red-300">{error}</p>}

      {result && (
        <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
          <p className="text-sm font-semibold text-white">&ldquo;{result.courseName}&rdquo; course history imported</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Rows with history</dt>
              <dd className="text-white">{result.rowsWithHistory}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Matched to a golfer</dt>
              <dd className="text-white">{result.matched}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Unmatched</dt>
              <dd className={result.unmatched.length > 0 ? "text-amber-400" : "text-white"}>{result.unmatched.length}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-navy-400">Skipped (0 rounds)</dt>
              <dd className="text-navy-400">{result.skippedNoHistory}</dd>
            </div>
          </dl>
          {result.tournamentLinked && (
            <p className="mt-3 text-sm text-emerald-400">Linked to tournament &ldquo;{result.tournamentLinked}&rdquo;.</p>
          )}
          {result.unmatched.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber-950/60 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-amber-400">
                Real course history exists but no matching golfer found - only relevant if they&apos;re in an upcoming FanTeam
                pool
              </p>
              <p className="mt-1 text-sm text-amber-200">{result.unmatched.join(", ")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
