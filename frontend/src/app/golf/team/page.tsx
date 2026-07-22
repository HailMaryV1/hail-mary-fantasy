import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import GolfTeamBuilder from "./GolfTeamBuilder";
import type { GolfOptimizerPlayer } from "@/lib/golfTeamOptimizer";

export const dynamic = "force-dynamic";

type TournamentRow = { id: number; fanteam_tournament_id: string; name: string; event_number: number | null };

export default async function GolfTeamPage({
  searchParams,
}: {
  searchParams: Promise<{ tournament?: string }>;
}) {
  const { tournament: tournamentParam } = await searchParams;
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam-golf").maybeSingle<{ id: number }>();

  let tournament: TournamentRow | null = null;
  if (game) {
    let query = supabase.from("golf_tournaments").select("id, fanteam_tournament_id, name, event_number").eq("game_id", game.id);
    query = tournamentParam ? query.eq("fanteam_tournament_id", tournamentParam) : query.order("start_time", { ascending: false }).limit(1);
    const { data } = await query.returns<TournamentRow[]>();
    tournament = data?.[0] ?? null;
  }

  const { data: rules } = tournament
    ? await supabase.from("game_squad_rules").select("budget").eq("game_id", game!.id).maybeSingle<{ budget: number }>()
    : { data: null };

  let pool: GolfOptimizerPlayer[] = [];
  if (tournament) {
    const { data: entries } = await supabase
      .from("golf_tournament_entries")
      .select("game_player_id, price, lineup, status, game_players(golfers(full_name))")
      .eq("tournament_id", tournament.id)
      .returns<{ game_player_id: number; price: number; lineup: string | null; status: string | null; game_players: { golfers: { full_name: string } } }[]>();

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
        .in("game_player_id", entries.map((e) => e.game_player_id))
        .returns<{ game_player_id: number; hail_mary_score: number; inputs: Record<string, unknown> }[]>();
      for (const p of projRows ?? []) projByPlayer.set(p.game_player_id, p);
    }

    pool = (entries ?? [])
      .filter((e) => !(e.lineup === "refuted" || e.status === "not_play")) // withdrawn golfers can't be picked
      .map((e) => {
        const proj = projByPlayer.get(e.game_player_id);
        const inputs = proj?.inputs ?? {};
        return {
          gamePlayerId: e.game_player_id,
          fullName: e.game_players?.golfers?.full_name ?? "Unknown",
          price: Number(e.price),
          expectedPoints: proj ? Number(proj.hail_mary_score) : 0,
          floor: typeof inputs.floor === "number" ? inputs.floor : 0,
          ceiling: typeof inputs.ceiling === "number" ? inputs.ceiling : 0,
          makeCutProbability: typeof inputs.make_cut_probability === "number" ? inputs.make_cut_probability : null,
          explanation: typeof inputs.explanation === "string" ? inputs.explanation : null,
        };
      });
  }

  let watchedIds: number[] = [];
  if (user && game) {
    const { data: watched } = await supabase
      .from("watchlist_entries")
      .select("game_player_id")
      .eq("user_id", user.id)
      .eq("game_id", game.id)
      .returns<{ game_player_id: number }[]>();
    watchedIds = (watched ?? []).map((w) => w.game_player_id);
  }

  let savedTeams: { id: number; name: string; players: string[] }[] = [];
  if (tournament && user) {
    const { data: squads } = await supabase
      .from("squads")
      .select("id, name, squad_players(game_players(golfers(full_name)))")
      .eq("golf_tournament_id", tournament.id)
      .eq("user_id", user.id)
      .returns<{ id: number; name: string; squad_players: { game_players: { golfers: { full_name: string } } }[] }[]>();
    savedTeams = (squads ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      players: s.squad_players.map((sp) => sp.game_players?.golfers?.full_name ?? "Unknown"),
    }));
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <Link href="/golf" className="text-sm text-navy-400 hover:text-sky-300">
          ← FanTeam Golf
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">Team Builder</h1>
        <p className="mt-1 text-sm text-navy-300">
          {tournament ? `${tournament.name}${tournament.event_number ? ` · Gameweek ${tournament.event_number}` : ""}` : "No tournament imported yet."}
        </p>

        {!tournament && (
          <p className="mt-8 text-sm text-navy-300">
            <Link href="/golf/import" className="text-sky-400 hover:text-sky-300">Import a tournament</Link> first.
          </p>
        )}

        {tournament && pool.length === 0 && (
          <p className="mt-8 text-sm text-navy-300">
            No projections yet. Run{" "}
            <code className="rounded bg-navy-800 px-1 py-0.5">python3 scripts/compute_golf_projections.py {tournament.fanteam_tournament_id}</code>.
          </p>
        )}

        {tournament && pool.length > 0 && rules && (
          <GolfTeamBuilder
            tournamentId={tournament.id}
            pool={pool}
            budget={Number(rules.budget)}
            savedTeams={savedTeams}
            isLoggedIn={!!user}
            watchedIds={watchedIds}
          />
        )}
      </main>
    </div>
  );
}
