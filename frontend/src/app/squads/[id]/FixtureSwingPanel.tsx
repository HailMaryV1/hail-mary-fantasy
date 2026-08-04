import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { computeTeamGameweekRatios, type FixtureDifficultyRow } from "@/lib/fixtureRuns";
import { deriveTeamFixtureRatings, buildFixtureStrip, type TeamFixtureRating } from "@/lib/fixtureSwing";
import {
  computeSwingOpportunityScores,
  selectClubRecommendations,
  type SwingOpportunityInput,
  type SwingOpportunityScore,
} from "@/lib/swingOpportunity";
import SwingTeamRow, { type SwingRecPlayer } from "./SwingTeamRow";

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

  function toRecPlayer(score: SwingOpportunityScore, label: string): SwingRecPlayer | null {
    const c = candidateName(score.gamePlayerId);
    if (!c) return null;
    return {
      label,
      gamePlayerId: c.gamePlayerId,
      fullName: c.fullName,
      position: c.position,
      price: c.price,
      hailMaryScore: c.hailMaryScore,
      expectedPointsNext5: c.expectedPointsNext5,
    };
  }

  function buildRow(rating: TeamFixtureRating, kind: "good" | "bad") {
    const strip = buildFixtureStrip(rating.teamName, gwRatios, stripMeta, 5);
    const teamScores = scoresForTeam(rating.teamName);

    let recScores: (SwingOpportunityScore | null)[] = [];
    let recLabels: string[] = [];
    let noRecsMessage: string;
    if (kind === "good") {
      const { bestOverall, bestValue, bestDifferential } = selectClubRecommendations(teamScores, candidatesForTeam(rating.teamName));
      recScores = [bestOverall, bestValue, bestDifferential];
      recLabels = ["Best Overall", "Best Value", "Best Differential"];
      noRecsMessage = "No differential pick available - every strong option here is already a confirmed starter.";
    } else {
      const ownedIds = new Set(squadPlayers.filter((sp) => sp.team_name === rating.teamName).map((sp) => sp.game_player_id));
      const sellCandidates = teamScores.filter((s) => ownedIds.has(s.gamePlayerId)).sort((a, b) => a.overall - b.overall);
      recScores = sellCandidates.slice(0, 3);
      recLabels = recScores.map(() => "Consider selling");
      noRecsMessage = "No squad players from this club to consider selling.";
    }

    const recs = recScores
      .map((s, i) => (s ? toRecPlayer(s, recLabels[i]) : null))
      .filter((r): r is SwingRecPlayer => r != null);

    return (
      <SwingTeamRow
        key={rating.teamName}
        teamName={rating.teamName}
        kind={kind}
        startsInGameweek={rating.startsInGameweek}
        currentRating={rating.currentRating}
        upcomingRating={rating.upcomingRating}
        swingValue={rating.swingValue}
        strip={strip}
        recs={recs}
        noRecsMessage={noRecsMessage}
      />
    );
  }

  return (
    <aside className="flex flex-col gap-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-white">Upcoming Fixture Swings</h2>
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-400">Good swings</p>
        <div className="flex flex-col gap-2">
          {improving.map((r) => buildRow(r, "good"))}
          {improving.length === 0 && <p className="text-xs text-navy-400">No favourable swings detected right now.</p>}
        </div>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-red-400">Tough swings</p>
        <div className="flex flex-col gap-2">
          {declining.map((r) => buildRow(r, "bad"))}
          {declining.length === 0 && <p className="text-xs text-navy-400">No tough swings detected right now.</p>}
        </div>
      </div>
    </aside>
  );
}
