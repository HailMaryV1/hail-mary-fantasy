import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import GolfRankingsTable, { type GolfRankingRow } from "./GolfRankingsTable";
import { computeTop20MarketGaps } from "@/lib/golfValuePicks";

export const dynamic = "force-dynamic";

type TournamentRow = { id: number; fanteam_tournament_id: string; name: string; event_number: number | null; status: string };

export default async function GolfRankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tournament?: string }>;
}) {
  const { tournament: tournamentParam } = await searchParams;
  const supabase = createServerSupabaseClient();

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam-golf").maybeSingle<{ id: number }>();

  // Separate auth-aware client just for "who's logged in, what have they
  // starred" - the rest of this page's data is public and stays on the
  // anon client above.
  const authClient = await createAuthServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  let watched: { gamePlayerId: number; entryId: number }[] = [];
  if (user && game) {
    const { data } = await authClient
      .from("watchlist_entries")
      .select("id, game_player_id")
      .eq("user_id", user.id)
      .eq("game_id", game.id)
      .returns<{ id: number; game_player_id: number }[]>();
    watched = (data ?? []).map((w) => ({ gamePlayerId: w.game_player_id, entryId: w.id }));
  }

  let tournament: TournamentRow | null = null;
  if (game) {
    let query = supabase
      .from("golf_tournaments")
      .select("id, fanteam_tournament_id, name, event_number, status")
      .eq("game_id", game.id);
    query = tournamentParam
      ? query.eq("fanteam_tournament_id", tournamentParam)
      : query.order("start_time", { ascending: false }).limit(1);
    const { data } = await query.returns<TournamentRow[]>();
    tournament = data?.[0] ?? null;
  }

  let rows: GolfRankingRow[] = [];
  if (tournament) {
    const { data: entries } = await supabase
      .from("golf_tournament_entries")
      .select("game_player_id, price, lineup, status, game_players(golfers(id, full_name))")
      .eq("tournament_id", tournament.id)
      .returns<
        { game_player_id: number; price: number; lineup: string | null; status: string | null; game_players: { golfers: { id: number; full_name: string } } }[]
      >();

    const { data: oddsRows } = await supabase
      .from("golf_tournament_odds")
      .select("golfer_id, implied_probability")
      .eq("tournament_id", tournament.id)
      .eq("market", "top20")
      .returns<{ golfer_id: number; implied_probability: number | null }[]>();
    const marketGaps = computeTop20MarketGaps(
      (entries ?? []).map((e) => ({ gamePlayerId: e.game_player_id, golferId: e.game_players?.golfers?.id ?? -1, price: Number(e.price) })),
      (oddsRows ?? []).map((o) => ({ golferId: o.golfer_id, impliedProbability: o.implied_probability }))
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
        <Link href="/golf" className="text-sm text-navy-400 hover:text-sky-300">
          ← FanTeam Golf
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">Hail Mary Golf Rankings</h1>
        <p className="mt-1 text-sm text-navy-300">
          {tournament ? `${tournament.name}${tournament.event_number ? ` · Gameweek ${tournament.event_number}` : ""}` : "No tournament imported yet."}
        </p>

        {!tournament && (
          <p className="mt-8 text-sm text-navy-300">
            No golf tournament found. <Link href="/golf/import" className="text-sky-400 hover:text-sky-300">Import one</Link> first.
          </p>
        )}

        {tournament && rows.length === 0 && (
          <p className="mt-8 text-sm text-navy-300">
            Tournament imported, but no projections yet. Run{" "}
            <code className="rounded bg-navy-800 px-1 py-0.5">python3 scripts/compute_golf_projections.py {tournament.fanteam_tournament_id}</code>.
          </p>
        )}

        {tournament && rows.length > 0 && (
          <GolfRankingsTable data={rows} gameId={game!.id} watched={watched} isLoggedIn={!!user} />
        )}
      </main>
    </div>
  );
}
