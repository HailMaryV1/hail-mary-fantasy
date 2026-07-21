"use server";

import { revalidatePath } from "next/cache";
import { createServiceSupabaseClient } from "@/lib/supabaseServiceClient";

/**
 * Course history for Hail Mary Golf - manually sourced, not scraped.
 * DataGolf's Course History tool (datagolf.com/course-history-tool) is
 * exactly the signal FanTeam's own API doesn't have (course-specific
 * strokes-gained-vs-expectation, not just a golfer's global stats), but
 * DataGolf's API requires a paid "Scratch Plus" subscription - scraping
 * their site instead of paying for it isn't something to do without a
 * real API relationship with them. So the workflow is manual: the user
 * downloads that tool's CSV export for the upcoming tournament's course
 * and uploads it here, same "paste the real numbers in" pattern already
 * used for FanTeam's own scoring rules.
 *
 * Deliberately only matches against EXISTING golfers rows - never creates
 * one. DataGolf's course-history field is far broader than any single
 * FanTeam pool (most rows here are players who've never entered a
 * FanTeam contest at all), so creating golfers from this file would
 * pollute the golfers table with phantom rows that might later collide
 * ambiguously with a real FanTeam-sourced name variant. Unmatched rows
 * with real history (rounds_played > 0) are surfaced for review instead;
 * rows with zero rounds carry no signal either way and are skipped
 * entirely rather than stored as noise.
 */

function compact(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

function surnameKey(fullName: string): string {
  const parts = fullName.trim().split(" ");
  return compact(parts[parts.length - 1]);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "" || t.toLowerCase() === "null") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type CourseHistoryImportResult = {
  courseName: string;
  rowsWithHistory: number;
  skippedNoHistory: number;
  matched: number;
  unmatched: string[];
  tournamentLinked: string | null;
};

export async function importCourseHistory(
  courseName: string,
  csvText: string,
  tournamentId: number | null
): Promise<{ result?: CourseHistoryImportResult; error?: string }> {
  const trimmedCourse = courseName.trim();
  if (!trimmedCourse) return { error: "Course name is required." };

  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { error: "That doesn't look like a CSV - no data rows found." };

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const lowerHeader = header.map((h) => h.toLowerCase());
  const nameIdx = lowerHeader.indexOf("player_name");
  const roundsIdx = lowerHeader.indexOf("rounds_played");
  const trueSgIdx = lowerHeader.indexOf("historical_true_sg");
  const vsExpIdx = lowerHeader.indexOf("versus_expected");
  const chAdjIdx = lowerHeader.indexOf("ch_adjustment");
  const expAdjIdx = lowerHeader.indexOf("experience_adjustment");
  if (nameIdx === -1 || roundsIdx === -1) {
    return {
      error: "Couldn't find the expected columns (player_name, rounds_played, ...) - is this the DataGolf course-history CSV export?",
    };
  }

  const knownIdx = new Set([nameIdx, roundsIdx, trueSgIdx, vsExpIdx, chAdjIdx, expAdjIdx]);
  const yearCols = header.map((label, idx) => ({ idx, label })).filter(({ idx }) => !knownIdx.has(idx));

  const supabase = createServiceSupabaseClient();

  const { data: courseRow, error: courseError } = await supabase
    .from("golf_courses")
    .upsert({ name: trimmedCourse }, { onConflict: "name" })
    .select("id")
    .single();
  if (courseError || !courseRow) return { error: `Failed to upsert course: ${courseError?.message}` };
  const courseId = courseRow.id as number;

  const { data: golferRows } = await supabase.from("golfers").select("id, full_name");
  const golfers = (golferRows ?? []).map((g) => ({ id: g.id as number, full_name: g.full_name as string }));

  let matched = 0;
  let rowsWithHistory = 0;
  let skippedNoHistory = 0;
  const unmatched: string[] = [];

  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const rawName = (fields[nameIdx] ?? "").trim();
    if (!rawName) continue;

    const roundsPlayed = num(fields[roundsIdx]);
    if (!roundsPlayed) {
      skippedNoHistory += 1;
      continue;
    }
    rowsWithHistory += 1;

    // "Lastname, Firstname" -> "Firstname Lastname" to match golfers.full_name's convention.
    let fullName = rawName;
    const commaIdx = rawName.indexOf(",");
    if (commaIdx !== -1) {
      const last = rawName.slice(0, commaIdx).trim();
      const first = rawName.slice(commaIdx + 1).trim();
      fullName = `${first} ${last}`.trim();
    }

    const liveCompact = compact(fullName);
    const exact = golfers.filter((g) => compact(g.full_name) === liveCompact);
    let golferId: number | null = null;
    if (exact.length === 1) {
      golferId = exact[0].id;
    } else if (exact.length === 0) {
      const key = surnameKey(fullName);
      const fuzzy = golfers.filter((g) => surnameKey(g.full_name) === key);
      if (fuzzy.length === 1) golferId = fuzzy[0].id;
    }

    if (golferId) matched += 1;
    else unmatched.push(fullName);

    const yearFinishes: Record<string, string | null> = {};
    for (const { idx, label } of yearCols) {
      const v = (fields[idx] ?? "").trim();
      yearFinishes[label] = v === "" || v.toLowerCase() === "null" ? null : v;
    }

    await supabase.from("golf_course_history_entries").upsert(
      {
        course_id: courseId,
        golfer_id: golferId,
        raw_player_name: fullName,
        rounds_played: roundsPlayed,
        historical_true_sg: num(fields[trueSgIdx]),
        versus_expected: num(fields[vsExpIdx]),
        ch_adjustment: num(fields[chAdjIdx]),
        experience_adjustment: num(fields[expAdjIdx]),
        year_finishes: yearFinishes,
        source: "datagolf",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "course_id,raw_player_name" }
    );
  }

  let tournamentLinked: string | null = null;
  if (tournamentId) {
    const { data: t } = await supabase
      .from("golf_tournaments")
      .update({ course_id: courseId })
      .eq("id", tournamentId)
      .select("name")
      .single();
    tournamentLinked = (t?.name as string | undefined) ?? null;
  }

  revalidatePath("/golf");
  revalidatePath("/golf/course-history");

  return {
    result: { courseName: trimmedCourse, rowsWithHistory, skippedNoHistory, matched, unmatched, tournamentLinked },
  };
}
