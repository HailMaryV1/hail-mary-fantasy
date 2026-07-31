import Link from "next/link";
import { notFound } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { detectFixtureBlocks, type FixtureBlock } from "@/lib/fixtureBlocks";
import { deriveTeamFixtureRatings } from "@/lib/fixtureSwing";
import type { FixtureDifficultyRow } from "@/lib/fixtureRuns";
import { computeSwingOpportunityScores, type SwingOpportunityInput, type SwingOpportunityScore } from "@/lib/swingOpportunity";
import { findLegalReplacementsForOutgoing, type TransferCandidate } from "@/lib/transferMatching";
import ApplyReplacementButton from "../ApplyReplacementButton";

// How many gameweeks ahead of "now" count as the relevant lookahead window -
// the spec calls for "roughly 3-5 gameweeks"; 5 matches the horizon already
// used everywhere else in Ask Mary / the Fixture Swing Panel.
const ANALYSIS_WINDOW_GAMEWEEKS = 5;

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

/**
 * The upgraded fixture-lookahead page - rebuilt entirely on the shared
 * detectFixtureBlocks (fixtureBlocks.ts), which itself composes the one
 * real run-detector (fixtureRuns.ts's detectFixtureRuns) rather than
 * re-implementing streak detection. Replaces the old inline classify()
 * (fixed league-wide baseline, flat "next 3 fixtures" average, no
 * consecutiveness detection at all) with a real block view: separate
 * attack/clean-sheet outlook, explicit start/end gameweek, and - for
 * favourable blocks - player targets reusing the exact same scoring the
 * Fixture Swing Panel already uses (computeSwingOpportunityScores), and -
 * for difficult blocks - owned players reviewed against real legal
 * replacements (transferMatching.ts), never flagged as a sell purely
 * because of the fixture block.
 */
export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const squadId = Number(id);
  if (!Number.isInteger(squadId)) notFound();

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: squad } = await supabase
    .from("squads")
    .select("id, name, user_id, game_id, fantasy_games(slug, display_name)")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user?.id) notFound();

  const game = squad.fantasy_games as unknown as { slug: string; display_name: string };

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("budget, max_per_club")
    .eq("game_id", squad.game_id)
    .single();

  const header = (
    <div>
      <h1 className="text-2xl font-semibold text-white">{squad.name}: fixture lookahead</h1>
      <p className="mt-1 text-sm text-navy-300">{game.display_name} · favourable and difficult fixture blocks, next {ANALYSIS_WINDOW_GAMEWEEKS} gameweeks</p>
      <p className="mt-1 text-xs text-amber-400">
        Fixture dates are the real season calendar. Difficulty only shows once bookmaker odds exist for that match, so far-future
        fixtures may not qualify for a block yet.
      </p>
      <Link href={`/squads/${squadId}`} className="mt-2 inline-block text-xs font-medium text-sky-400 hover:text-sky-300">
        ← Back to squad
      </Link>
    </div>
  );

  if (!rules) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-3xl">
          {header}
          <p className="mt-8 text-sm text-red-400">No squad rules configured for this game.</p>
        </main>
      </div>
    );
  }

  const { data: gwRow } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures!inner(kickoff_at)")
    .eq("game_id", squad.game_id)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek", { ascending: true })
    .limit(1)
    .maybeSingle();
  const planningGameweek: number | null = gwRow?.gameweek ?? null;

  // Whole-league fixtures/difficulty - a block detector needs every team,
  // not just this squad's own, since "Teams to Target" spans the league.
  // Same query shape as FixtureSwingPanel.tsx.
  const { data: fixturesRaw } = await supabase
    .from("game_fixture_gameweeks")
    .select(
      "gameweek, fixtures(id, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))"
    )
    .eq("game_id", squad.game_id)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek");

  const { data: difficultyRaw } = await supabase
    .from("team_fixture_difficulty")
    .select("fixture_id, team_id, attack_score, clean_sheet_score")
    .eq("game_id", squad.game_id);
  const difficultyByFixtureTeam = new Map((difficultyRaw ?? []).map((d) => [`${d.fixture_id}:${d.team_id}`, d]));

  const rows: FixtureDifficultyRow[] = [];
  for (const row of (fixturesRaw ?? []) as unknown as RawFixtureJoin[]) {
    const f = row.fixtures;
    if (!f) continue;
    for (const [teamId, teamName] of [
      [f.home_team_id, f.home.name],
      [f.away_team_id, f.away.name],
    ] as const) {
      const diff = difficultyByFixtureTeam.get(`${f.id}:${teamId}`);
      rows.push({
        teamName,
        gameweek: row.gameweek,
        attackScore: diff ? Number(diff.attack_score) : null,
        cleanSheetScore: diff ? Number(diff.clean_sheet_score) : null,
      });
    }
  }

  const allBlocks = detectFixtureBlocks(rows);
  const relevantBlocks =
    planningGameweek != null
      ? allBlocks
          .filter((b) => b.startGameweek <= planningGameweek + ANALYSIS_WINDOW_GAMEWEEKS)
          .sort((a, b) => a.startGameweek - b.startGameweek)
      : [];
  const goodBlocks = relevantBlocks.filter((b) => b.kind === "good");
  const badBlocks = relevantBlocks.filter((b) => b.kind === "bad");

  // squad_players is intentionally just ids here - price/position/team/score
  // all come from game_player_pool below, the same source of truth every
  // other transfer-matching consumer (transfers/page.tsx, FixtureSwingPanel)
  // already reads from, rather than a second join query.
  const { data: squadPlayersRaw } = await supabase.from("squad_players").select("game_player_id").eq("squad_id", squadId);
  const squadIds = new Set((squadPlayersRaw ?? []).map((p) => p.game_player_id));

  const { data: pool } = await supabase.from("game_player_pool").select("*").eq("game_slug", game.slug).returns<PoolRow[]>();

  const { data: horizonRaw } =
    planningGameweek !== null
      ? await supabase.rpc("player_score_by_horizon_from", { p_game_slug: game.slug, p_start_gameweek: planningGameweek, p_num_gameweeks: 5 })
      : await supabase.rpc("player_score_by_horizon", { p_game_slug: game.slug, p_num_gameweeks: 5 });
  const horizonRows = horizonRaw as HorizonRow[] | null;
  const expectedPointsById = new Map((horizonRows ?? []).map((r) => [r.game_player_id, r.avg_score * r.gameweeks_included]));

  const ratings = deriveTeamFixtureRatings(rows);
  const ratingByTeam = new Map(ratings.map((r) => [r.teamName, r]));

  // TransferCandidate.score is the same "expected points over the next 5
  // gameweeks" number used everywhere else - it's what makes the difficult-
  // block replacement comparison a genuine projected-gain comparison, not a
  // fixture-only judgement.
  const poolCandidates: TransferCandidate[] = (pool ?? []).map((p) => ({
    gamePlayerId: p.game_player_id,
    fullName: p.full_name,
    teamId: p.team_id,
    teamName: p.team_name,
    price: Number(p.price),
    position: p.position,
    score: expectedPointsById.get(p.game_player_id) ?? 0,
  }));
  const candidateById = new Map(poolCandidates.map((c) => [c.gamePlayerId, c]));

  const squadMembers = poolCandidates.filter((c) => squadIds.has(c.gamePlayerId));
  const budgetRemaining = Number(rules.budget) - squadMembers.reduce((sum, m) => sum + m.price, 0);
  const clubCounts = new Map<number, number>();
  squadMembers.forEach((m) => clubCounts.set(m.teamId, (clubCounts.get(m.teamId) ?? 0) + 1));

  const swingInputs: SwingOpportunityInput[] = (pool ?? []).map((p) => ({
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
  const swingScores = swingInputs.length > 0 ? computeSwingOpportunityScores(swingInputs) : [];
  const swingScoreById = new Map(swingScores.map((s) => [s.gamePlayerId, s]));

  function bestTargetsForTeam(teamName: string, teamId: number): { scores: SwingOpportunityScore[]; clubLimitReached: boolean } {
    const clubLimitReached = rules!.max_per_club != null && (clubCounts.get(teamId) ?? 0) >= rules!.max_per_club;
    if (clubLimitReached) return { scores: [], clubLimitReached: true };
    const scores = swingScores
      .filter((s) => {
        const c = candidateById.get(s.gamePlayerId);
        return c && c.teamName === teamName && !squadIds.has(s.gamePlayerId);
      })
      .sort((a, b) => b.overall - a.overall)
      .slice(0, 3);
    return { scores, clubLimitReached: false };
  }

  function reviewForBlock(block: FixtureBlock) {
    return squadMembers
      .filter((m) => m.teamName === block.teamName)
      .map((member) => {
        const replacements = findLegalReplacementsForOutgoing(poolCandidates, member, squadIds, budgetRemaining, clubCounts, rules!.max_per_club);
        const best = replacements[0] ?? null;
        const potentialSell = best != null && best.delta > 0;
        return { member, best, potentialSell };
      });
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        {header}

        {planningGameweek == null && (
          <p className="mt-8 text-sm text-navy-300">No upcoming fixtures found on the calendar yet.</p>
        )}

        {planningGameweek != null && (
          <>
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-400">Teams to target</p>
                <p className="mt-1 text-sm text-white">
                  {goodBlocks.length === 0 ? "None detected in this window." : Array.from(new Set(goodBlocks.map((b) => b.teamName))).join(", ")}
                </p>
              </div>
              <div className="rounded-xl border border-red-900 bg-red-950/30 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-red-400">Teams to avoid</p>
                <p className="mt-1 text-sm text-white">
                  {badBlocks.length === 0 ? "None detected in this window." : Array.from(new Set(badBlocks.map((b) => b.teamName))).join(", ")}
                </p>
              </div>
            </div>

            <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-emerald-400">Favourable blocks</h2>
            <div className="mt-3 flex flex-col gap-3">
              {goodBlocks.length === 0 && <p className="text-sm text-navy-400">No team has 2+ consecutive favourable fixtures right now.</p>}
              {goodBlocks.map((block, i) => {
                const teamId = poolCandidates.find((c) => c.teamName === block.teamName)?.teamId ?? -1;
                const { scores: targets, clubLimitReached } = bestTargetsForTeam(block.teamName, teamId);
                return (
                  <div key={`${block.teamName}-${block.startGameweek}-${i}`} className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-white">{block.teamName}</p>
                      <span className="text-xs text-navy-400">
                        GW{block.startGameweek}–GW{block.endGameweek} · {block.length} gameweeks
                      </span>
                    </div>
                    <div className="mt-2 flex gap-2">
                      {block.attack && (
                        <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-400">
                          Attack: {block.attack.kind === "good" ? "Favourable" : block.attack.kind === "bad" ? "Tough" : "Mixed"}
                        </span>
                      )}
                      {block.cleanSheet && (
                        <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-400">
                          Clean sheet: {block.cleanSheet.kind === "good" ? "Favourable" : block.cleanSheet.kind === "bad" ? "Tough" : "Mixed"}
                        </span>
                      )}
                    </div>

                    <p className="mt-3 text-xs font-medium uppercase tracking-wide text-navy-400">Best player targets</p>
                    {clubLimitReached && (
                      <p className="mt-1 text-xs text-amber-400">
                        You&apos;re already at the club limit for {block.teamName} - no further targets can be legally added from this team.
                      </p>
                    )}
                    {!clubLimitReached && targets.length === 0 && <p className="mt-1 text-xs text-navy-400">No pool candidates found for this team.</p>}
                    {!clubLimitReached && targets.length > 0 && (
                      <div className="mt-1 flex flex-col gap-1">
                        {targets.map((s) => {
                          const c = candidateById.get(s.gamePlayerId);
                          if (!c) return null;
                          return (
                            <div key={s.gamePlayerId} className="flex items-center justify-between text-sm">
                              <span className="text-white">
                                {c.fullName} <span className="text-navy-500">({c.position})</span>
                              </span>
                              <span className="text-xs text-navy-400">
                                £{c.price.toFixed(1)}m · {c.score.toFixed(1)} pts/5gw · score {s.overall.toFixed(0)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-red-400">Difficult blocks</h2>
            <div className="mt-3 flex flex-col gap-3">
              {badBlocks.length === 0 && <p className="text-sm text-navy-400">No team has 2+ consecutive difficult fixtures right now.</p>}
              {badBlocks.map((block, i) => {
                const reviews = reviewForBlock(block);
                return (
                  <div key={`${block.teamName}-${block.startGameweek}-${i}`} className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-white">{block.teamName}</p>
                      <span className="text-xs text-navy-400">
                        GW{block.startGameweek}–GW{block.endGameweek} · {block.length} gameweeks
                      </span>
                    </div>
                    <div className="mt-2 flex gap-2">
                      {block.attack && (
                        <span className="rounded-full bg-red-950 px-2 py-0.5 text-xs font-medium text-red-400">
                          Attack: {block.attack.kind === "bad" ? "Tough" : block.attack.kind === "good" ? "Favourable" : "Mixed"}
                        </span>
                      )}
                      {block.cleanSheet && (
                        <span className="rounded-full bg-red-950 px-2 py-0.5 text-xs font-medium text-red-400">
                          Clean sheet: {block.cleanSheet.kind === "bad" ? "Tough" : block.cleanSheet.kind === "good" ? "Favourable" : "Mixed"}
                        </span>
                      )}
                    </div>

                    <p className="mt-3 text-xs font-medium uppercase tracking-wide text-navy-400">Players to review</p>
                    {reviews.length === 0 && <p className="mt-1 text-xs text-navy-400">No squad players from this club.</p>}
                    <div className="mt-1 flex flex-col gap-3">
                      {reviews.map(({ member, best, potentialSell }) => (
                        <div key={member.gamePlayerId} className="rounded-lg border border-navy-800 bg-navy-950 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-white">
                              {member.fullName} <span className="text-navy-500">({member.position})</span>
                            </span>
                            {potentialSell && (
                              <span className="rounded-full bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-400">Potential sell</span>
                            )}
                          </div>
                          {best ? (
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs text-navy-300">
                                Best legal replacement: {best.candidate.fullName} (£{best.candidate.price.toFixed(1)}m) ·{" "}
                                {best.delta >= 0 ? "+" : ""}
                                {best.delta.toFixed(1)} pts/5gw
                              </p>
                              {potentialSell && (
                                <ApplyReplacementButton squadId={squadId} outGamePlayerId={member.gamePlayerId} inGamePlayerId={best.candidate.gamePlayerId} />
                              )}
                            </div>
                          ) : (
                            <p className="mt-2 text-xs text-navy-400">No legal replacement currently available - fixtures alone are not a reason to sell.</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
