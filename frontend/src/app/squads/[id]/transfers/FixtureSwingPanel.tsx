import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { computeTeamGameweekRatios, type FixtureDifficultyRow } from "@/lib/fixtureRuns";
import { deriveTeamFixtureRatings, buildFixtureStrip, type TeamFixtureRating } from "@/lib/fixtureSwing";
import {
  computeSwingOpportunityScores,
  selectClubRecommendations,
  type SwingOpportunityInput,
  type SwingOpportunityScore,
} from "@/lib/swingOpportunity";
import Badge from "../../Badge";
import AddToWatchlistButton from "./AddToWatchlistButton";
import { getTeamColors } from "@/lib/teamColors";

type RawFixtureJoin = {
  gameweek: number;
  fixtures: {
    id: number;
    home_team_id: number;
    away_team_id: number;
    home: { name: string };
    away: { name: string };
  } | null;
};

type PoolRow = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  price: number;
  hail_mary_score: number | null;
  lineup: string | null;
  status: string | null;
  form: number | null;
};

type HorizonRow = { game_player_id: number; avg_score: number; gameweeks_included: number };

type SquadPlayerForSell = { game_player_id: number; team_name: string };

/**
 * "Which teams have good fixtures" is already answered by /fixtures
 * (detectFixtureRuns, untouched by this panel). This answers "which
 * players should I buy/sell because of that" - same fixture data, same
 * run detection, just turned into a recommendation instead of a ticker.
 */
export default async function FixtureSwingPanel({
  gameId,
  gameSlug,
  planningGameweek,
  squadPlayers,
}: {
  gameId: number;
  gameSlug: string;
  planningGameweek: number | null;
  squadPlayers: SquadPlayerForSell[];
}) {
  const supabase = await createAuthServerClient();

  // Same query shape fixtures/page.tsx already uses, plus opponent/
  // home-away captured for the 5-fixture strip (fixtures/page.tsx never
  // needed that, this panel does).
  const { data: fixturesRaw } = await supabase
    .from("game_fixture_gameweeks")
    .select(
      "gameweek, fixtures(id, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))"
    )
    .eq("game_id", gameId)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek");

  const { data: difficultyRaw } = await supabase
    .from("team_fixture_difficulty")
    .select("fixture_id, team_id, attack_score, clean_sheet_score")
    .eq("game_id", gameId);
  const difficultyByFixtureTeam = new Map(
    (difficultyRaw ?? []).map((d) => [`${d.fixture_id}:${d.team_id}`, d])
  );

  const rows: FixtureDifficultyRow[] = [];
  const stripMeta = new Map<string, { opponent: string; isHome: boolean }>();
  for (const row of (fixturesRaw ?? []) as unknown as RawFixtureJoin[]) {
    const f = row.fixtures;
    if (!f) continue;
    for (const [teamId, teamName, opponent, isHome] of [
      [f.home_team_id, f.home.name, f.away.name, true],
      [f.away_team_id, f.away.name, f.home.name, false],
    ] as const) {
      const diff = difficultyByFixtureTeam.get(`${f.id}:${teamId}`);
      rows.push({
        teamName,
        gameweek: row.gameweek,
        attackScore: diff ? Number(diff.attack_score) : null,
        cleanSheetScore: diff ? Number(diff.clean_sheet_score) : null,
      });
      // Double-gameweeks would overwrite this key with the second
      // fixture's opponent - harmless today since none exist in the
      // current calendar (confirmed earlier this session), and the strip
      // is illustrative, not authoritative.
      stripMeta.set(`${teamName}:${row.gameweek}`, { opponent, isHome });
    }
  }

  const ratings = deriveTeamFixtureRatings(rows);
  const ratingByTeam = new Map(ratings.map((r) => [r.teamName, r]));
  const gwRatios = computeTeamGameweekRatios(rows);

  const { data: pool } = await supabase
    .from("game_player_pool")
    .select("*")
    .eq("game_slug", gameSlug)
    .returns<PoolRow[]>();

  // Expected points over the next 5 gameweeks - the existing horizon RPC
  // genuinely accepts any N (confirmed by reading the SQL), just never
  // called with 5 anywhere else in the app until now.
  const { data: horizonRaw } =
    planningGameweek !== null
      ? await supabase.rpc("player_score_by_horizon_from", { p_game_slug: gameSlug, p_start_gameweek: planningGameweek, p_num_gameweeks: 5 })
      : await supabase.rpc("player_score_by_horizon", { p_game_slug: gameSlug, p_num_gameweeks: 5 });
  const horizonRows = horizonRaw as HorizonRow[] | null;
  const expectedPointsById = new Map((horizonRows ?? []).map((r) => [r.game_player_id, r.avg_score * r.gameweeks_included]));

  const candidates: SwingOpportunityInput[] = (pool ?? []).map((p) => ({
    gamePlayerId: p.game_player_id,
    fullName: p.full_name,
    teamId: p.team_id,
    teamName: p.team_name,
    position: p.position,
    price: Number(p.price),
    hailMaryScore: p.hail_mary_score != null ? Number(p.hail_mary_score) : null,
    expectedPointsNext5: expectedPointsById.get(p.game_player_id) ?? null,
    fixtureSwingValue: ratingByTeam.get(p.team_name)?.swingValue ?? 0,
    lineup: p.lineup,
    status: p.status,
    form: p.form != null ? Number(p.form) : null,
  }));

  const scores = candidates.length > 0 ? computeSwingOpportunityScores(candidates) : [];
  const scoreById = new Map(scores.map((s) => [s.gamePlayerId, s]));

  function candidatesForTeam(teamName: string) {
    return candidates.filter((c) => c.teamName === teamName);
  }
  function scoresForTeam(teamName: string): SwingOpportunityScore[] {
    return candidatesForTeam(teamName)
      .map((c) => scoreById.get(c.gamePlayerId))
      .filter((s): s is SwingOpportunityScore => !!s);
  }

  const improving = ratings
    .filter((r) => r.swingDirection === "improving")
    .sort((a, b) => (a.startsInGameweek ?? 999) - (b.startsInGameweek ?? 999));
  const declining = ratings
    .filter((r) => r.swingDirection === "declining")
    .sort((a, b) => (a.startsInGameweek ?? 999) - (b.startsInGameweek ?? 999));

  function candidateName(gamePlayerId: number) {
    return candidates.find((c) => c.gamePlayerId === gamePlayerId);
  }

  function recCard(score: SwingOpportunityScore, label: string) {
    const c = candidateName(score.gamePlayerId);
    if (!c) return null;
    return (
      <div key={`${label}-${score.gamePlayerId}`} className="rounded-lg border border-navy-800 bg-navy-950 p-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-sky-400">{label}</p>
        <p className="mt-0.5 text-sm font-medium text-white">{c.fullName}</p>
        <p className="text-[11px] text-navy-400">
          {c.position} · £{c.price.toFixed(1)}m · HMS {c.hailMaryScore != null ? c.hailMaryScore.toFixed(1) : "-"} · xPts5{" "}
          {c.expectedPointsNext5 != null ? c.expectedPointsNext5.toFixed(1) : "-"}
        </p>
        <div className="mt-1.5">
          <AddToWatchlistButton
            gameId={gameId}
            gamePlayerId={c.gamePlayerId}
            defaultReasons={label === "Best Differential" ? ["differential", "fixture_swing"] : ["fixture_swing"]}
          />
        </div>
      </div>
    );
  }

  function teamCard(rating: TeamFixtureRating, kind: "good" | "bad") {
    const strip = buildFixtureStrip(rating.teamName, gwRatios, stripMeta, 5);
    const teamScores = scoresForTeam(rating.teamName);

    let recs: (SwingOpportunityScore | null)[] = [];
    let recLabels: string[] = [];
    if (kind === "good") {
      const { bestOverall, bestValue, bestDifferential } = selectClubRecommendations(teamScores, candidatesForTeam(rating.teamName));
      recs = [bestOverall, bestValue, bestDifferential];
      recLabels = ["Best Overall", "Best Value", "Best Differential"];
    } else {
      const ownedIds = new Set(squadPlayers.filter((sp) => sp.team_name === rating.teamName).map((sp) => sp.game_player_id));
      const sellCandidates = teamScores.filter((s) => ownedIds.has(s.gamePlayerId)).sort((a, b) => a.overall - b.overall);
      recs = sellCandidates.slice(0, 3);
      recLabels = recs.map(() => "Consider selling");
    }

    return (
      <div
        key={rating.teamName}
        className={`rounded-xl border p-4 ${kind === "good" ? "border-emerald-900 bg-navy-900" : "border-red-900 bg-navy-900"}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge teamName={rating.teamName} size="sm" />
            <p className="font-medium text-white">{rating.teamName}</p>
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              kind === "good" ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
            }`}
          >
            {kind === "good" ? "↑ Improving" : "↓ Declining"}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
          <div>
            <p className="text-navy-400">Starts</p>
            <p className="font-medium text-white">{rating.startsInGameweek != null ? `GW${rating.startsInGameweek}` : "-"}</p>
          </div>
          <div>
            <p className="text-navy-400">Current → Upcoming</p>
            <p className="font-medium text-white">
              {rating.currentRating.toFixed(2)} → {rating.upcomingRating.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-navy-400">Swing</p>
            <p className={`font-medium ${rating.swingValue >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {rating.swingValue >= 0 ? "+" : ""}
              {rating.swingValue.toFixed(2)}
            </p>
          </div>
        </div>
        <div className="mt-2 flex gap-1">
          {strip.map((fx) => (
            <div
              key={fx.gameweek}
              title={`GW${fx.gameweek}: ${fx.isHome ? "vs" : "@"} ${fx.opponent}`}
              className={`flex-1 rounded px-1 py-1 text-center text-[9px] font-medium ${
                fx.ratio == null
                  ? "bg-navy-800 text-navy-400"
                  : fx.ratio >= 1.15
                    ? "bg-emerald-950 text-emerald-400"
                    : fx.ratio <= 0.85
                      ? "bg-red-950 text-red-400"
                      : "bg-navy-800 text-navy-300"
              }`}
            >
              {getTeamColors(fx.opponent).abbr}
            </div>
          ))}
          {strip.length === 0 && <p className="text-[10px] text-navy-500">No upcoming fixtures found.</p>}
        </div>
        {recs.some((r) => r != null) ? (
          <div className="mt-3 flex flex-col gap-2">
            {recs.map((r, i) => (r ? recCard(r, recLabels[i]) : null))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-navy-400">
            {kind === "good" ? "No differential pick available - every strong option here is already a confirmed starter." : "No squad players from this club to consider selling."}
          </p>
        )}
      </div>
    );
  }

  return (
    <aside className="flex flex-col gap-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-white">Upcoming Fixture Swings</h2>
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-400">Good swings</p>
        <div className="flex flex-col gap-3">
          {improving.map((r) => teamCard(r, "good"))}
          {improving.length === 0 && <p className="text-xs text-navy-400">No favourable swings detected right now.</p>}
        </div>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-red-400">Tough swings</p>
        <div className="flex flex-col gap-3">
          {declining.map((r) => teamCard(r, "bad"))}
          {declining.length === 0 && <p className="text-xs text-navy-400">No tough swings detected right now.</p>}
        </div>
      </div>
    </aside>
  );
}
