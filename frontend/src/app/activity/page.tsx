import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";
import GameSecondaryNav from "../GameSecondaryNav";

// Reads searchParams and wants every visit to reflect whatever the
// twice-daily pipeline just wrote - same reasoning as every other page
// here that shouldn't serve a stale cached response.
export const dynamic = "force-dynamic";

const EVENT_TYPES = [
  { key: "player_added", label: "Player Added", tone: "emerald" },
  { key: "score_changed", label: "Score Changed", tone: "sky" },
  { key: "team_changed", label: "Team Changed", tone: "amber" },
  { key: "fixture_added", label: "Fixture Added", tone: "emerald" },
  { key: "fixture_rescheduled", label: "Fixture Rescheduled", tone: "red" },
] as const;

type EventKey = (typeof EVENT_TYPES)[number]["key"];

const TONE_CLASSES: Record<(typeof EVENT_TYPES)[number]["tone"], string> = {
  emerald: "bg-emerald-950 text-emerald-400",
  sky: "bg-sky-950 text-sky-400",
  amber: "bg-amber-950 text-amber-400",
  red: "bg-red-950 text-red-400",
};

// Most rows (fixture/odds/price imports) aren't tied to one game at all -
// only game-specific steps (score recompute, provider sync, golf live
// polling) stamp a game_id. Global rows get their own neutral label
// rather than being silently dropped by a per-game filter.
const GAME_LABEL_CLASSES: Record<string, string> = {
  fanteam: "border-sky-800 text-sky-300",
  dreamteam: "border-violet-800 text-violet-300",
  "nfl-fanteam": "border-orange-800 text-orange-300",
  "fanteam-golf": "border-lime-800 text-lime-300",
  cloudff: "border-fuchsia-800 text-fuchsia-300",
};
const GLOBAL_LABEL_CLASS = "border-navy-600 text-navy-400";

type ActivityRow = {
  id: number;
  event_type: string;
  summary: string;
  created_at: string;
  game_slug: string | null;
  game_display_name: string | null;
};

function formatTimestamp(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type: typeParam } = await searchParams;
  const activeType = EVENT_TYPES.find((t) => t.key === typeParam)?.key as EventKey | undefined;

  const supabase = createServerSupabaseClient();

  let query = supabase
    .from("activity_log")
    .select("id, event_type, summary, created_at, fantasy_games(slug, display_name)")
    .order("created_at", { ascending: false })
    .limit(150);
  if (activeType) query = query.eq("event_type", activeType);

  const { data: rawData, error } = await query.returns<
    { id: number; event_type: string; summary: string; created_at: string; fantasy_games: { slug: string; display_name: string } | null }[]
  >();
  const data: ActivityRow[] | undefined = rawData?.map((r) => ({
    id: r.id,
    event_type: r.event_type,
    summary: r.summary,
    created_at: r.created_at,
    game_slug: r.fantasy_games?.slug ?? null,
    game_display_name: r.fantasy_games?.display_name ?? null,
  }));

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        <div className="mb-4">
          <GameSecondaryNav gameSlug="fanteam" gameDisplayName="FanTeam" />
        </div>
        <h1 className="text-2xl font-semibold text-white">Activity</h1>
        <p className="mt-1 text-sm text-navy-300">
          New players, Hail Mary Score swings, club transfers, and fixture changes - everything the twice-daily
          refresh picks up, as it happens. This is a global feed across every game, not just FanTeam - most pipeline
          steps (fixtures, odds, prices) aren&apos;t tied to a single game at all. Each row below is labelled with the
          game it belongs to, or &quot;Global&quot; for steps that aren&apos;t game-specific.
        </p>

        <nav className="mt-6 flex flex-wrap gap-2">
          <Link
            href="/activity"
            prefetch={false}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              !activeType ? "bg-sky-500 text-navy-950" : "bg-navy-900 text-navy-300 hover:bg-navy-800 hover:text-white"
            }`}
          >
            All
          </Link>
          {EVENT_TYPES.map((t) => (
            <Link
              key={t.key}
              href={`/activity?type=${t.key}`}
              prefetch={false}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                t.key === activeType ? "bg-sky-500 text-navy-950" : "bg-navy-900 text-navy-300 hover:bg-navy-800 hover:text-white"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        {error && (
          <p className="mt-8 rounded-lg bg-red-950 p-4 text-sm text-red-300">Failed to load activity: {error.message}</p>
        )}

        {!error && (
          <div className="mt-6 flex flex-col gap-2">
            {(data ?? []).map((row) => {
              const eventDef = EVENT_TYPES.find((t) => t.key === row.event_type);
              return (
                <div key={row.id} className="flex items-start justify-between gap-3 rounded-xl border border-navy-700 bg-navy-900 p-3">
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        eventDef ? TONE_CLASSES[eventDef.tone] : "bg-navy-800 text-navy-400"
                      }`}
                    >
                      {eventDef?.label ?? row.event_type}
                    </span>
                    <span
                      className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        row.game_slug ? GAME_LABEL_CLASSES[row.game_slug] ?? GLOBAL_LABEL_CLASS : GLOBAL_LABEL_CLASS
                      }`}
                    >
                      {row.game_display_name ?? "Global"}
                    </span>
                    <p className="text-sm text-white">{row.summary}</p>
                  </div>
                  <span className="shrink-0 text-xs text-navy-400">{formatTimestamp(row.created_at)}</span>
                </div>
              );
            })}
            {(data ?? []).length === 0 && (
              <p className="mt-4 text-sm text-navy-400">
                No activity recorded yet{activeType ? " for this type" : ""} - the twice-daily refresh will start
                populating this as real changes happen.
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
