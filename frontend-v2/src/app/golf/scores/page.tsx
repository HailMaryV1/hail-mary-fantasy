import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { computeTeamTotal, type GolfOptimizerPlayer } from "@/lib/golfTeamOptimizer";
import GolfScoresTable, { type GolfScoreRow } from "./GolfScoresTable";

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
      href={`/golf/scores?tournament=${t.fanteam_tournament_id}`}
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
      <span className="text-xs font-medium text-sky-400">View scores →</span>
    </Link>
  );
}

type SquadRow = {
  id: number;
  name: string;
  golf_captain_game_player_id: number | null;
  squad_players: { game_player_id: number; game_players: { golfers: { full_name: string } } | null }[];
};

type PredictionRow = {
  game_player_id: number;
  full_name: string;
  price: number | null;
  expected_points: number | null;
  expected_floor: number | null;
  expected_ceiling: number | null;
  actual_points: number | null;
  points_difference: number | null;
};

type TeamGrade = {
  squadId: number;
  squadName: string;
  captainName: string | null;
  expectedTotal: number;
  actualTotal: number | null;
  diff: number | null;
  pending: boolean;
};

// Same captain-and-underdog-aware team total the Team Builder itself
// uses (computeTeamTotal), applied twice - once to the frozen expected
// points, once to whatever actuals have landed so far - so "how did my
// team do" always means the same thing here as it does everywhere else
// in the app, not a simpler re-derivation that could quietly disagree.
function gradeSquad(squad: SquadRow, predsByPlayer: Map<number, PredictionRow>): TeamGrade | null {
  const gamePlayerIds = squad.squad_players.map((sp) => sp.game_player_id);
  if (gamePlayerIds.length === 0) return null;
  const preds = gamePlayerIds.map((id) => predsByPlayer.get(id)).filter((p): p is PredictionRow => p != null);
  // No frozen prediction yet for every golfer on this team (registration
  // for this tournament hasn't closed) - nothing to grade yet.
  if (preds.length !== gamePlayerIds.length) return null;

  const nameByPlayer = new Map(squad.squad_players.map((sp) => [sp.game_player_id, sp.game_players?.golfers?.full_name ?? "Unknown"]));
  const asPlayers = (points: (p: PredictionRow) => number): GolfOptimizerPlayer[] =>
    preds.map((p) => ({
      gamePlayerId: p.game_player_id,
      fullName: nameByPlayer.get(p.game_player_id) ?? "Unknown",
      price: p.price != null ? Number(p.price) : 0,
      expectedPoints: points(p),
      floor: 0,
      ceiling: 0,
      makeCutProbability: null,
    }));

  const expectedResult = computeTeamTotal(
    asPlayers((p) => (p.expected_points != null ? Number(p.expected_points) : 0)),
    squad.golf_captain_game_player_id
  );

  const pending = preds.some((p) => p.actual_points == null);
  let actualTotal: number | null = null;
  let diff: number | null = null;
  if (!pending) {
    // Same captain the expected side used, so a real result can't
    // silently swap the armband onto a different golfer than the one
    // actually being judged.
    const actualResult = computeTeamTotal(
      asPlayers((p) => (p.actual_points != null ? Number(p.actual_points) : 0)),
      expectedResult.captainId
    );
    actualTotal = actualResult.total;
    diff = Math.round((actualResult.total - expectedResult.total) * 100) / 100;
  }

  return {
    squadId: squad.id,
    squadName: squad.name,
    captainName: nameByPlayer.get(expectedResult.captainId ?? -1) ?? null,
    expectedTotal: expectedResult.total,
    actualTotal,
    diff,
    pending,
  };
}

export default async function GolfScoresPage({ searchParams }: { searchParams: Promise<{ tournament?: string }> }) {
  const { tournament: tournamentParam } = await searchParams;
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

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

  // No tournament picked yet - same card-grid landing as /golf/rankings,
  // current/upcoming first then every past tournament.
  if (!tournamentParam) {
    const [current, ...past] = allTournaments;
    return (
      <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <Link href="/golf" className="text-sm font-medium text-navy-400 hover:text-sky-400">
            ← FanTeam Golf
          </Link>

          <h1 className="mt-4 text-2xl font-semibold text-white">Scores</h1>
          <p className="mt-1 text-sm text-navy-300">
            Pick a tournament to see the whole field&apos;s projected vs. actual points, refreshed by the twice-daily
            data pull - no live in-play tracking, just the latest confirmed scores.
          </p>

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
        </div>
      </div>
    );
  }

  const tournament = allTournaments.find((t) => t.fanteam_tournament_id === tournamentParam) ?? null;

  let rows: GolfScoreRow[] = [];
  let teamGrades: TeamGrade[] = [];
  if (tournament) {
    const [{ data: predRows }, { data: squads }] = await Promise.all([
      supabase
        .from("golf_tournament_predictions")
        .select(
          "game_player_id, price, expected_points, expected_floor, expected_ceiling, actual_points, points_difference, game_players(golfers(full_name))"
        )
        .eq("tournament_id", tournament.id)
        .returns<
          {
            game_player_id: number;
            price: number | null;
            expected_points: number | null;
            expected_floor: number | null;
            expected_ceiling: number | null;
            actual_points: number | null;
            points_difference: number | null;
            game_players: { golfers: { full_name: string } } | null;
          }[]
        >(),
      supabase
        .from("squads")
        .select("id, name, golf_captain_game_player_id, squad_players(game_player_id, game_players(golfers(full_name)))")
        .eq("user_id", user.id)
        .eq("golf_tournament_id", tournament.id)
        .returns<SquadRow[]>(),
    ]);

    rows = (predRows ?? [])
      .map((r) => ({
        gamePlayerId: r.game_player_id,
        fullName: r.game_players?.golfers?.full_name ?? "Unknown",
        price: r.price != null ? Number(r.price) : null,
        expectedPoints: r.expected_points != null ? Number(r.expected_points) : null,
        expectedFloor: r.expected_floor != null ? Number(r.expected_floor) : null,
        expectedCeiling: r.expected_ceiling != null ? Number(r.expected_ceiling) : null,
        actualPoints: r.actual_points != null ? Number(r.actual_points) : null,
        pointsDifference: r.points_difference != null ? Number(r.points_difference) : null,
      }))
      .sort((a, b) => (b.expectedPoints ?? -Infinity) - (a.expectedPoints ?? -Infinity));

    const predsByPlayer = new Map<number, PredictionRow>(
      (predRows ?? []).map((r) => [
        r.game_player_id,
        {
          game_player_id: r.game_player_id,
          full_name: r.game_players?.golfers?.full_name ?? "Unknown",
          price: r.price,
          expected_points: r.expected_points,
          expected_floor: r.expected_floor,
          expected_ceiling: r.expected_ceiling,
          actual_points: r.actual_points,
          points_difference: r.points_difference,
        },
      ])
    );
    teamGrades = (squads ?? [])
      .map((squad) => gradeSquad(squad, predsByPlayer))
      .filter((g): g is TeamGrade => g !== null)
      .sort((a, b) => (b.actualTotal ?? b.expectedTotal) - (a.actualTotal ?? a.expectedTotal));
  }

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <Link href="/golf/scores" className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← All tournaments
        </Link>

        <h1 className="mt-4 text-2xl font-semibold text-white">Scores</h1>
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
            Tournament imported, but no predictions frozen yet - that happens automatically once registration closes
            (the twice-daily refresh runs <code className="rounded bg-navy-800 px-1 py-0.5">scripts/capture_golf_predictions.py</code>).
          </p>
        )}

        {tournament && teamGrades.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Your teams</h2>
            <p className="mt-1 text-xs text-navy-500">
              Which of your saved teams for this tournament actually delivered, captain and underdog bonuses included.
            </p>
            <div className="mt-2 flex flex-col gap-2">
              {teamGrades.map((g) => (
                <div key={g.squadId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-navy-700 bg-navy-900 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-white">{g.squadName}</p>
                    {g.captainName && <p className="text-xs text-navy-400">Captain: {g.captainName}</p>}
                  </div>
                  <div className="text-right text-sm">
                    <span className="text-navy-400">Expected {g.expectedTotal.toFixed(1)}</span>
                    {g.pending ? (
                      <span className="ml-3 text-navy-500">Pending results</span>
                    ) : (
                      <>
                        <span className="ml-3 font-semibold text-white">Actual {g.actualTotal!.toFixed(1)}</span>
                        <span className={`ml-3 font-semibold ${g.diff! >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {g.diff! >= 0 ? "+" : ""}
                          {g.diff!.toFixed(1)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tournament && rows.length > 0 && <GolfScoresTable data={rows} />}
      </div>
    </div>
  );
}
