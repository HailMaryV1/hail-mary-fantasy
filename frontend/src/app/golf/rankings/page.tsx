import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";
import GolfRankingsTable, { type GolfRankingRow } from "./GolfRankingsTable";
import { computeMarketGaps, pickBestMarket } from "@/lib/golfValuePicks";

export const dynamic = "force-dynamic";

type TournamentRow = {
  id: number;
  fanteam_tournament_id: string;
  name: string;
  event_number: number | null;
  status: string;
  start_time: string;
};

const STATUS_LABEL: Record<string, string> = { upcoming: "Upcoming", live: "Live", completed: "Completed" };
const STATUS_TONE: Record<string, string> = {
  upcoming: "bg-navy-800 text-navy-300",
  live: "bg-emerald-950 text-emerald-400",
  completed: "bg-navy-800 text-navy-500",
};

function TournamentCard({ t }: { t: TournamentRow }) {
  return (
    <Link
      href={`/golf/rankings?tournament=${t.fanteam_tournament_id}`}
      className="flex items-center justify-between rounded-lg border border-navy-700 bg-navy-900 px-4 py-3 transition-colors hover:border-sky-500 hover:bg-navy-800"
    >
      <div>
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-white">{t.name}</p>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_TONE[t.status] ?? "bg-navy-800 text-navy-400"}`}>
            {STATUS_LABEL[t.status] ?? t.status}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-navy-400">
          {t.event_number ? `Gameweek ${t.event_number} · ` : ""}
          {new Date(t.start_time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
        </p>
      </div>
      <span className="text-xs font-medium text-sky-400">View rankings →</span>
    </Link>
  );
}

export default async function GolfRankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tournament?: string }>;
}) {
  const { tournament: tournamentParam } = await searchParams;
  const supabase = createServerSupabaseClient();

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam-golf").maybeSingle<{ id: number }>();

  let allTournaments: TournamentRow[] = [];
  if (game) {
    const { data } = await supabase
      .from("golf_tournaments")
      .select("id, fanteam_tournament_id, name, event_number, status, start_time")
      .eq("game_id", game.id)
      .order("start_time", { ascending: false })
      .returns<TournamentRow[]>();
    allTournaments = data ?? [];
  }

  // No tournament picked yet - land on a card grid (current/upcoming
  // first, then every past tournament) rather than silently jumping into
  // whichever is most recent, so a past week's predictions stay a click
  // away instead of only reachable by guessing its URL param.
  if (!tournamentParam) {
    const [current, ...past] = allTournaments;
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-3xl">
          <Link href="/golf" className="text-sm text-navy-400 hover:text-sky-300">
            ← FanTeam Golf
          </Link>

          <h1 className="mt-3 text-2xl font-semibold text-white">Hail Mary Golf Rankings</h1>
          <p className="mt-1 text-sm text-navy-300">Pick a tournament to see what Mary predicted.</p>

          {allTournaments.length === 0 && (
            <p className="mt-8 text-sm text-navy-300">
              No golf tournament found. <Link href="/golf/import" className="text-sky-400 hover:text-sky-300">Import one</Link> first.
            </p>
          )}

          {current && (
            <section className="mt-6">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-navy-400">Current / Upcoming</h2>
              <div className="mt-2">
                <TournamentCard t={current} />
              </div>
            </section>
          )}

          {past.length > 0 && (
            <section className="mt-8">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-navy-400">Past Tournaments</h2>
              <div className="mt-2 flex flex-col gap-2">
                {past.map((t) => (
                  <TournamentCard key={t.fanteam_tournament_id} t={t} />
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
    );
  }

  const tournament = allTournaments.find((t) => t.fanteam_tournament_id === tournamentParam) ?? null;

  let rows: GolfRankingRow[] = [];
  if (tournament) {
    const { data: entries } = await supabase
      .from("golf_tournament_entries")
      .select("game_player_id, price, lineup, status, game_players(golfers(id, full_name))")
      .eq("tournament_id", tournament.id)
      .returns<
        { game_player_id: number; price: number; lineup: string | null; status: string | null; game_players: { golfers: { id: number; full_name: string } } }[]
      >();

    const { data: allOddsRows } = await supabase
      .from("golf_tournament_odds")
      .select("golfer_id, market, implied_probability")
      .eq("tournament_id", tournament.id)
      .returns<{ golfer_id: number; market: string; implied_probability: number | null }[]>();
    const bestMarket = pickBestMarket((allOddsRows ?? []).map((o) => ({ golferId: o.golfer_id, market: o.market, impliedProbability: o.implied_probability })));
    const marketGaps = computeMarketGaps(
      (entries ?? []).map((e) => ({ gamePlayerId: e.game_player_id, golferId: e.game_players?.golfers?.id ?? -1, price: Number(e.price) })),
      (allOddsRows ?? []).filter((o) => o.market === bestMarket).map((o) => ({ golferId: o.golfer_id, impliedProbability: o.implied_probability }))
    );

    const { data: algo } = await supabase
      .from("algorithm_versions")
      .select("id")
      .eq("family", "golf-v1")
      .order("revision", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: number }>();

    const projByPlayer = new Map<number, { hail_mary_score: number; inputs: Record<string, unknown> }>();
    if (algo && entries && entries.length > 0) {
      const { data: projRows } = await supabase
        .from("projections")
        .select("game_player_id, hail_mary_score, inputs")
        .eq("algorithm_version_id", algo.id)
        .eq("gameweek", tournament.event_number)
        .in("game_player_id", entries.map((e) => e.game_player_id))
        .returns<{ game_player_id: number; hail_mary_score: number; inputs: Record<string, unknown> }[]>();
      for (const p of projRows ?? []) projByPlayer.set(p.game_player_id, p);
    }

    rows = (entries ?? []).map((e) => {
      const proj = projByPlayer.get(e.game_player_id);
      const inputs = proj?.inputs ?? {};
      return {
        gamePlayerId: e.game_player_id,
        fullName: e.game_players?.golfers?.full_name ?? "Unknown",
        price: Number(e.price),
        lineup: e.lineup,
        status: e.status,
        expectedPoints: proj ? Number(proj.hail_mary_score) : null,
        floor: typeof inputs.floor === "number" ? inputs.floor : null,
        ceiling: typeof inputs.ceiling === "number" ? inputs.ceiling : null,
        makeCutProbability: typeof inputs.make_cut_probability === "number" ? inputs.make_cut_probability : null,
        value: typeof inputs.value === "number" ? inputs.value : null,
        explanation: typeof inputs.explanation === "string" ? inputs.explanation : null,
        marketGap: marketGaps.get(e.game_player_id) ?? null,
      };
    });
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <Link href="/golf/rankings" className="text-sm text-navy-400 hover:text-sky-300">
          ← All tournaments
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">Hail Mary Golf Rankings</h1>
        <p className="mt-1 text-sm text-navy-300">
          {tournament ? `${tournament.name}${tournament.event_number ? ` · Gameweek ${tournament.event_number}` : ""}` : "Tournament not found."}
        </p>

        {!tournament && (
          <p className="mt-8 text-sm text-navy-300">
            No golf tournament found. <Link href="/golf/import" className="text-sky-400 hover:text-sky-300">Import one</Link> first.
          </p>
        )}

        {tournament && rows.length === 0 && (
          <p className="mt-8 text-sm text-navy-300">
            Tournament imported, but no projections yet. Compute them from the{" "}
            <Link href="/golf/import" className="text-sky-400 hover:text-sky-300">Tournament Builder</Link>, or run{" "}
            <code className="rounded bg-navy-800 px-1 py-0.5">python3 scripts/compute_golf_projections.py {tournament.fanteam_tournament_id}</code>.
          </p>
        )}

        {tournament && rows.length > 0 && <GolfRankingsTable data={rows} />}
      </main>
    </div>
  );
}
