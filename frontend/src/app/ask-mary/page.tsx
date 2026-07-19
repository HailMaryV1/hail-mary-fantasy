import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { findBuyCandidatesForOutgoing, type TransferCandidate } from "@/lib/transferMatching";
import { type FixtureDifficultyRow } from "@/lib/fixtureRuns";
import { deriveTeamFixtureRatings, type TeamFixtureRating } from "@/lib/fixtureSwing";
import { LINEUP_SECURITY_SCORES, INJURY_AVAILABILITY_SCORES, DEFAULT_SECURITY_SCORE } from "@/lib/playerStatus";
import {
  scoreMoveCandidates,
  STRATEGIES,
  type Strategy,
  type MoveCandidateInput,
  type MoveScore,
  type MoveReason,
} from "@/lib/recommendationScoring";
import { assessSquadHealth, type SquadHealthPlayer } from "@/lib/squadHealth";
import RecommendationCard from "./RecommendationCard";
import AskMaryWatchlistButton from "./AskMaryWatchlistButton";

// RPC results depend on the chosen horizon/strategy/squad but Supabase's
// .rpc() POSTs to a fixed URL, so Next's fetch Data Cache could otherwise
// serve a stale response for different settings - same reasoning as
// rankings/transfers/compare pages.
export const dynamic = "force-dynamic";

const HORIZONS = [
  { key: "1", label: "Next Gameweek", gameweeks: 1 },
  { key: "3", label: "Next 3 Gameweeks", gameweeks: 3 },
  { key: "5", label: "Next 5 Gameweeks", gameweeks: 5 },
] as const;

const TRANSFER_LIMITS = [
  { key: "1", label: "1 move", value: 1 as number | null },
  { key: "2", label: "2 moves", value: 2 as number | null },
  { key: "3", label: "3 moves", value: 3 as number | null },
  { key: "all", label: "Show all", value: null as number | null },
] as const;

// Below this Mary Move Score, a transfer isn't worth recommending - Ask
// Mary should say so rather than force a marginal move for its own sake.
const HOLD_SCORE_THRESHOLD = 55;

export type AskMaryRecommendation = {
  rank: number;
  label?: string;
  squadId: number;
  gameId: number;
  outGamePlayerId: number;
  outName: string;
  outTeam: string;
  outPrice: number;
  inGamePlayerId: number;
  inName: string;
  inTeam: string;
  inPrice: number;
  position: string;
  transferCost: number;
  moneyRemainingAfter: number;
  expectedPointsBefore: number;
  expectedPointsAfter: number;
  gain1: number | null;
  gain3: number | null;
  gain5: number | null;
  hailMaryScoreDiff: number;
  fixtureSwingDiff: number;
  risk: MoveScore["risk"];
  confidence: number;
  overall: number;
  reasons: MoveReason[];
  warnings: MoveReason[];
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

type SquadPlayerRow = {
  game_player_id: number;
  is_starting: boolean;
  game_players: {
    price: number;
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD"; team_id: number; teams: { name: string } };
  };
};

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

type HorizonRow = { game_player_id: number; avg_score: number };

function argmax(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

export default async function AskMaryPage({
  searchParams,
}: {
  searchParams: Promise<{ squad?: string; horizon?: string; strategy?: string; limit?: string }>;
}) {
  const { squad: squadParam, horizon: horizonParam, strategy: strategyParam, limit: limitParam } = await searchParams;

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const activeHorizon = HORIZONS.find((h) => h.key === horizonParam) ?? HORIZONS[2];
  const activeStrategy = (STRATEGIES.find((s) => s.key === strategyParam)?.key ?? "balanced") as Strategy;
  const activeLimit = TRANSFER_LIMITS.find((l) => l.key === limitParam) ?? TRANSFER_LIMITS[1];

  const { data: fanteamGameRow } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", "fanteam").single();

  if (!fanteamGameRow) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          <h1 className="text-2xl font-semibold text-white">Ask Mary</h1>
          <p className="mt-4 text-sm text-red-400">FanTeam isn&apos;t configured on this platform yet.</p>
        </main>
      </div>
    );
  }
  // Reassigned to a plain non-null const - TypeScript's control-flow
  // narrowing from the guard above doesn't carry into nested function
  // declarations (toRec, below), so closures over the original nullable
  // binding would still see it as possibly-null.
  const fanteamGame = fanteamGameRow;

  const { data: squadsRaw } = await supabase
    .from("squads")
    .select("id, name, free_transfers")
    .eq("user_id", user.id)
    .eq("game_id", fanteamGame.id)
    .order("created_at", { ascending: false });

  const header = (
    <div>
      <h1 className="text-2xl font-semibold text-white">Ask Mary</h1>
      <p className="mt-1 text-sm text-navy-300">Your personalised Hail Mary squad adviser</p>
    </div>
  );

  if (!squadsRaw || squadsRaw.length === 0) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-6">
            <p className="text-sm text-navy-300">
              You don&apos;t have a FanTeam squad yet - Ask Mary needs a saved squad to analyse.
            </p>
            <Link
              href="/squads/new?game=fanteam"
              className="mt-4 inline-block rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400"
            >
              Build a FanTeam squad
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const selectedSquad = squadsRaw.find((s) => s.id === Number(squadParam)) ?? squadsRaw[0];

  function askMaryUrl(overrides: Partial<{ squad: number; horizon: string; strategy: string; limit: string }>) {
    const params = new URLSearchParams();
    params.set("squad", String(overrides.squad ?? selectedSquad.id));
    params.set("horizon", overrides.horizon ?? activeHorizon.key);
    params.set("strategy", overrides.strategy ?? activeStrategy);
    params.set("limit", overrides.limit ?? activeLimit.key);
    return `/ask-mary?${params.toString()}`;
  }

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("budget, max_per_club, squad_size, starting_size")
    .eq("game_id", fanteamGame.id)
    .single();

  if (!rules) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <p className="mt-8 text-sm text-red-400">No FanTeam squad rules configured - can&apos;t validate a squad without them.</p>
        </main>
      </div>
    );
  }

  const { data: squadPlayersRaw } = await supabase
    .from("squad_players")
    .select("game_player_id, is_starting, game_players(price, players(full_name, position, team_id, teams(name)))")
    .eq("squad_id", selectedSquad.id)
    .returns<SquadPlayerRow[]>();

  const { data: pool } = await supabase.from("game_player_pool").select("*").eq("game_slug", "fanteam").returns<PoolRow[]>();
  const poolByGamePlayerId = new Map((pool ?? []).map((p) => [p.game_player_id, p]));

  const squadPlayers = (squadPlayersRaw ?? []).map((sp) => {
    const poolRow = poolByGamePlayerId.get(sp.game_player_id);
    return {
      game_player_id: sp.game_player_id,
      full_name: sp.game_players.players.full_name,
      position: sp.game_players.players.position,
      team_id: sp.game_players.players.team_id,
      team_name: sp.game_players.players.teams.name,
      price: Number(sp.game_players.price),
      is_starting: sp.is_starting,
      lineup: poolRow?.lineup ?? null,
      status: poolRow?.status ?? null,
      form: poolRow?.form != null ? Number(poolRow.form) : null,
    };
  });

  const budgetRemaining = Number(rules.budget) - squadPlayers.reduce((sum, p) => sum + p.price, 0);
  const clubCounts = new Map<number, number>();
  squadPlayers.forEach((p) => clubCounts.set(p.team_id, (clubCounts.get(p.team_id) ?? 0) + 1));
  const squadIds = new Set(squadPlayers.map((p) => p.game_player_id));
  const squadTeamsSet = new Set(squadPlayers.map((p) => p.team_name));
  const squadValid = squadPlayers.length === rules.squad_size;

  // Squad selector + settings controls (shared across all states below).
  const squadSelector = squadsRaw.length > 1 && (
    <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-navy-900 p-1">
      {squadsRaw.map((s) => (
        <Link
          key={s.id}
          href={askMaryUrl({ squad: s.id })}
          prefetch={false}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${
            s.id === selectedSquad.id ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
          }`}
        >
          {s.name}
        </Link>
      ))}
    </div>
  );

  const settingsPanel = (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Analysis Settings</h2>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-navy-500">Planning horizon</p>
          <div className="mt-1 flex flex-wrap gap-1 rounded-lg bg-navy-950 p-1">
            {HORIZONS.map((h) => (
              <Link
                key={h.key}
                href={askMaryUrl({ horizon: h.key })}
                prefetch={false}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  h.key === activeHorizon.key ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
                }`}
              >
                {h.label}
              </Link>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-navy-500">Strategy</p>
          <div className="mt-1 flex flex-wrap gap-1 rounded-lg bg-navy-950 p-1">
            {STRATEGIES.map((s) => (
              <Link
                key={s.key}
                href={askMaryUrl({ strategy: s.key })}
                prefetch={false}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  s.key === activeStrategy ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
                }`}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-navy-500">Transfer limit</p>
          <div className="mt-1 flex flex-wrap gap-1 rounded-lg bg-navy-950 p-1">
            {TRANSFER_LIMITS.map((l) => (
              <Link
                key={l.key}
                href={askMaryUrl({ limit: l.key })}
                prefetch={false}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  l.key === activeLimit.key ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const squadSummary = (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Current Squad</h2>
      <p className="mt-2 text-sm text-navy-200">
        {selectedSquad.name} · £{budgetRemaining.toFixed(1)}m in the bank · {squadPlayers.length}/{rules.squad_size} players ·{" "}
        {selectedSquad.free_transfers} free transfer{selectedSquad.free_transfers === 1 ? "" : "s"}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href={`/squads/${selectedSquad.id}/transfers`} className="rounded-lg border border-navy-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800">
          Edit squad
        </Link>
        <Link href={`/squads/${selectedSquad.id}/lineup`} className="rounded-lg border border-navy-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800">
          Starting XI
        </Link>
      </div>
    </div>
  );

  if (!squadValid) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-3xl">
          {header}
          {squadSelector}
          <div className="mt-4 flex flex-col gap-4">
            {squadSummary}
            <div className="rounded-xl border border-amber-800 bg-amber-950/30 p-4">
              <p className="text-sm text-amber-300">
                {selectedSquad.name} has {squadPlayers.length} of the required {rules.squad_size} players. Finish
                building your squad before asking Mary for advice.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Gameweek calendar / season timing - same pattern as squads/[id]/transfers/page.tsx.
  const { data: gwRow } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures!inner(kickoff_at)")
    .eq("game_id", fanteamGame.id)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek", { ascending: true })
    .limit(1)
    .maybeSingle();
  const currentGameweek: number | null = gwRow?.gameweek ?? null;
  const hasCalendar = currentGameweek !== null;
  const { seasonStarted, planningGameweek } = await getSeasonTiming(supabase, fanteamGame.id);

  async function getHorizonMap(gameweeks: number): Promise<Map<number, number>> {
    if (hasCalendar && !seasonStarted) {
      const { data } = await supabase.rpc("player_score_by_horizon", { p_game_slug: "fanteam", p_num_gameweeks: gameweeks });
      return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
    }
    if (hasCalendar && seasonStarted && planningGameweek !== null) {
      const { data } = await supabase.rpc("player_score_by_horizon_from", {
        p_game_slug: "fanteam",
        p_start_gameweek: planningGameweek,
        p_num_gameweeks: gameweeks,
      });
      return new Map(((data ?? []) as HorizonRow[]).map((r) => [r.game_player_id, Number(r.avg_score)]));
    }
    return new Map();
  }

  const [score1Map, score3Map, score5Map] = await Promise.all([getHorizonMap(1), getHorizonMap(3), getHorizonMap(5)]);
  const scoreMapByGameweeks = new Map([[1, score1Map], [3, score3Map], [5, score5Map]]);
  const scoreHMap = scoreMapByGameweeks.get(activeHorizon.gameweeks) ?? score5Map;

  function avgFor(map: Map<number, number>, gamePlayerId: number): number {
    if (map.size > 0) return map.get(gamePlayerId) ?? 0;
    const hms = poolByGamePlayerId.get(gamePlayerId)?.hail_mary_score;
    return hms != null ? Number(hms) : 0;
  }

  // Fixture ratings - same query shape as FixtureSwingPanel.tsx.
  const { data: fixturesRaw } = await supabase
    .from("game_fixture_gameweeks")
    .select(
      "gameweek, fixtures(id, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))"
    )
    .eq("game_id", fanteamGame.id)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek");
  const { data: difficultyRaw } = await supabase
    .from("team_fixture_difficulty")
    .select("fixture_id, team_id, attack_score, clean_sheet_score")
    .eq("game_id", fanteamGame.id);
  const difficultyByFixtureTeam = new Map((difficultyRaw ?? []).map((d) => [`${d.fixture_id}:${d.team_id}`, d]));

  const fixtureRows: FixtureDifficultyRow[] = [];
  for (const row of (fixturesRaw ?? []) as unknown as RawFixtureJoin[]) {
    const f = row.fixtures;
    if (!f) continue;
    for (const [teamId, teamName] of [
      [f.home_team_id, f.home.name],
      [f.away_team_id, f.away.name],
    ] as const) {
      const diff = difficultyByFixtureTeam.get(`${f.id}:${teamId}`);
      fixtureRows.push({
        teamName,
        gameweek: row.gameweek,
        attackScore: diff ? Number(diff.attack_score) : null,
        cleanSheetScore: diff ? Number(diff.clean_sheet_score) : null,
      });
    }
  }
  const ratings = deriveTeamFixtureRatings(fixtureRows);
  const ratingByTeam = new Map(ratings.map((r) => [r.teamName, r]));

  // Build one candidate move per current squad player (best legal
  // same-position replacement), reusing the exact matching logic the
  // transfers page and watchlist "Transfer In" flow already share.
  const poolCandidatesForMatching: TransferCandidate[] = (pool ?? []).map((p) => ({
    gamePlayerId: p.game_player_id,
    fullName: p.full_name,
    teamId: p.team_id,
    teamName: p.team_name,
    price: Number(p.price),
    score: avgFor(scoreHMap, p.game_player_id),
    position: p.position,
  }));

  type Move = { input: MoveCandidateInput; gain1: number | null; gain3: number | null; gain5: number | null; outPrice: number; inPrice: number };
  const moves: Move[] = [];

  for (const outPlayer of squadPlayers) {
    const outScoreH = avgFor(scoreHMap, outPlayer.game_player_id);
    const matches = findBuyCandidatesForOutgoing(
      poolCandidatesForMatching,
      {
        gamePlayerId: outPlayer.game_player_id,
        fullName: outPlayer.full_name,
        teamId: outPlayer.team_id,
        teamName: outPlayer.team_name,
        price: outPlayer.price,
        score: outScoreH,
        position: outPlayer.position,
      },
      squadIds,
      budgetRemaining,
      clubCounts,
      rules.max_per_club
    );
    const best = matches[0];
    if (!best) continue;
    const inCand = best.candidate;
    const inPoolRow = poolByGamePlayerId.get(inCand.gamePlayerId);
    const outPoolRow = poolByGamePlayerId.get(outPlayer.game_player_id);
    const outTeamRating = ratingByTeam.get(outPlayer.team_name);
    const inTeamRating = ratingByTeam.get(inCand.teamName);

    const gainAt = (map: Map<number, number>, gameweeks: number) =>
      (avgFor(map, inCand.gamePlayerId) - avgFor(map, outPlayer.game_player_id)) * gameweeks;

    moves.push({
      input: {
        outGamePlayerId: outPlayer.game_player_id,
        inGamePlayerId: inCand.gamePlayerId,
        outName: outPlayer.full_name,
        inName: inCand.fullName,
        outTeam: outPlayer.team_name,
        inTeam: inCand.teamName,
        position: outPlayer.position,
        expectedPointsGain: best.delta * activeHorizon.gameweeks,
        hailMaryScoreDiff: (inPoolRow?.hail_mary_score != null ? Number(inPoolRow.hail_mary_score) : 0) - (outPoolRow?.hail_mary_score != null ? Number(outPoolRow.hail_mary_score) : 0),
        fixtureSwingDiff: (inTeamRating?.swingValue ?? 0) - (outTeamRating?.swingValue ?? 0),
        priceDelta: inCand.price - outPlayer.price,
        incomingMinutesSecurity: LINEUP_SECURITY_SCORES[inPoolRow?.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE,
        outgoingMinutesSecurity: LINEUP_SECURITY_SCORES[outPlayer.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE,
        incomingInjuryAvailability: INJURY_AVAILABILITY_SCORES[inPoolRow?.status ?? ""] ?? DEFAULT_SECURITY_SCORE,
        incomingForm: inPoolRow?.form != null ? Number(inPoolRow.form) : null,
        outgoingForm: outPlayer.form,
        incomingIsConfirmedStarter: inPoolRow?.lineup === "confirmed_starting",
        hasFixtureData: !!outTeamRating && !!inTeamRating,
        hasStatusData: inPoolRow?.lineup != null && outPlayer.lineup != null,
      },
      gain1: gainAt(score1Map, 1),
      gain3: gainAt(score3Map, 3),
      gain5: gainAt(score5Map, 5),
      outPrice: outPlayer.price,
      inPrice: inCand.price,
    });
  }

  const scoresActive = scoreMoveCandidates(moves.map((m) => m.input), activeStrategy);
  const scoresDifferential = scoreMoveCandidates(moves.map((m) => m.input), "differential");
  const scoresSafe = scoreMoveCandidates(moves.map((m) => m.input), "safe");

  function toRec(i: number, score: MoveScore, rank: number, label?: string): AskMaryRecommendation {
    const m = moves[i];
    return {
      rank,
      label,
      squadId: selectedSquad.id,
      gameId: fanteamGame.id,
      outGamePlayerId: m.input.outGamePlayerId,
      outName: m.input.outName,
      outTeam: m.input.outTeam,
      outPrice: m.outPrice,
      inGamePlayerId: m.input.inGamePlayerId,
      inName: m.input.inName,
      inTeam: m.input.inTeam,
      inPrice: m.inPrice,
      position: m.input.position,
      transferCost: m.input.priceDelta,
      moneyRemainingAfter: budgetRemaining - m.input.priceDelta,
      expectedPointsBefore: avgFor(scoreHMap, m.input.outGamePlayerId) * activeHorizon.gameweeks,
      expectedPointsAfter: avgFor(scoreHMap, m.input.inGamePlayerId) * activeHorizon.gameweeks,
      gain1: m.gain1,
      gain3: m.gain3,
      gain5: m.gain5,
      hailMaryScoreDiff: m.input.hailMaryScoreDiff,
      fixtureSwingDiff: m.input.fixtureSwingDiff,
      risk: score.risk,
      confidence: score.confidence,
      overall: score.overall,
      reasons: score.reasons,
      warnings: score.warnings,
    };
  }

  const sortedIndices = scoresActive
    .map((s, i) => i)
    .sort((a, b) => scoresActive[b].overall - scoresActive[a].overall);

  const bestOverall = sortedIndices.length > 0 ? scoresActive[sortedIndices[0]].overall : 0;
  const hold = moves.length === 0 || bestOverall < HOLD_SCORE_THRESHOLD;

  const rankedMoves = sortedIndices
    .slice(0, activeLimit.value ?? sortedIndices.length)
    .map((idx, n) => toRec(idx, scoresActive[idx], n + 1));

  const categoryCards: AskMaryRecommendation[] = [];
  if (moves.length > 0) {
    const gain1Idx = argmax(moves.map((m) => m.gain1 ?? -Infinity));
    categoryCards.push(toRec(gain1Idx, scoresActive[gain1Idx], 0, "Best Immediate Move"));

    categoryCards.push(toRec(sortedIndices[0], scoresActive[sortedIndices[0]], 0, `Best ${activeHorizon.label} Move`));

    const valueRaw = moves.map((m) =>
      m.input.priceDelta <= 0 ? m.input.expectedPointsGain + 1 : m.input.expectedPointsGain / Math.max(m.input.priceDelta, 0.5)
    );
    const valueIdx = argmax(valueRaw);
    categoryCards.push(toRec(valueIdx, scoresActive[valueIdx], 0, "Best Value Move"));

    const diffIndices = moves.map((m, i) => i).filter((i) => !moves[i].input.incomingIsConfirmedStarter);
    if (diffIndices.length > 0) {
      const diffIdx = diffIndices.reduce((best, cur) => (scoresDifferential[cur].overall > scoresDifferential[best].overall ? cur : best));
      categoryCards.push(toRec(diffIdx, scoresDifferential[diffIdx], 0, "Best Differential Move"));
    }

    const safeIndices = moves
      .map((m, i) => i)
      .filter((i) => moves[i].input.incomingMinutesSecurity >= 0.85 && moves[i].input.incomingInjuryAvailability === 1);
    if (safeIndices.length > 0) {
      const safeIdx = safeIndices.reduce((best, cur) => (scoresSafe[cur].overall > scoresSafe[best].overall ? cur : best));
      categoryCards.push(toRec(safeIdx, scoresSafe[safeIdx], 0, "Best Safe Move"));
    }
  }

  // Squad health check - uses raw current Hail Mary Score, same basis
  // squads/[id]/captain/page.tsx already uses for captaincy ranking.
  const positionAverages: Record<string, number> = {};
  for (const pos of ["GK", "DEF", "MID", "FWD"]) {
    const vals = (pool ?? []).filter((p) => p.position === pos && p.hail_mary_score != null).map((p) => Number(p.hail_mary_score));
    positionAverages[pos] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  const healthPlayers: SquadHealthPlayer[] = squadPlayers.map((p) => ({
    gamePlayerId: p.game_player_id,
    fullName: p.full_name,
    position: p.position,
    teamName: p.team_name,
    price: p.price,
    score: poolByGamePlayerId.get(p.game_player_id)?.hail_mary_score != null ? Number(poolByGamePlayerId.get(p.game_player_id)!.hail_mary_score) : null,
    lineup: p.lineup,
    status: p.status,
    isStarting: p.is_starting,
  }));
  const health = assessSquadHealth(healthPlayers, positionAverages, rules.max_per_club, ratingByTeam, activeHorizon.gameweeks);

  // Captaincy - same "top score among starters" baseline as
  // squads/[id]/captain/CaptainPicker.tsx, extended with safest/differential
  // picks using the numeric security scores already established.
  const captaincyPool = squadPlayers
    .filter((p) => p.is_starting)
    .map((p) => ({ ...p, score: poolByGamePlayerId.get(p.game_player_id)?.hail_mary_score != null ? Number(poolByGamePlayerId.get(p.game_player_id)!.hail_mary_score) : 0 }))
    .sort((a, b) => b.score - a.score);
  const bestCaptain = captaincyPool[0] ?? null;
  const viceCaptain = captaincyPool[1] ?? null;
  const safestCaptain =
    captaincyPool
      .slice()
      .sort(
        (a, b) =>
          (LINEUP_SECURITY_SCORES[b.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE) - (LINEUP_SECURITY_SCORES[a.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE) ||
          b.score - a.score
      )[0] ?? null;
  const differentialCaptain = captaincyPool.find((p) => p.lineup !== "confirmed_starting") ?? null;

  // Mary's Gameweek Plan - built from the same fixture-run data as
  // /fixtures and the Fixture Swing Panel, not invented gameweek numbers.
  const roadmap: { label: string; text: string }[] = [];
  if (planningGameweek != null) {
    const top = sortedIndices.length > 0 ? toRec(sortedIndices[0], scoresActive[sortedIndices[0]], 1) : null;
    roadmap.push({
      label: `This Gameweek (GW${planningGameweek})`,
      text: !hold && top ? `Sell ${top.outName} and buy ${top.inName}.` : "Hold - no transfer creates a meaningful improvement right now.",
    });
    for (let offset = 1; offset < activeHorizon.gameweeks; offset++) {
      const gw = planningGameweek + offset;
      const decliningHere = Array.from(squadTeamsSet)
        .map((t) => ratingByTeam.get(t))
        .filter((r): r is TeamFixtureRating => !!r && r.swingDirection === "declining" && r.startsInGameweek === gw);
      const improvingHere = ratings.filter((r) => r.swingDirection === "improving" && r.startsInGameweek === gw && !squadTeamsSet.has(r.teamName));
      if (decliningHere.length > 0) {
        roadmap.push({ label: `Gameweek ${gw}`, text: `Review ${decliningHere.map((r) => r.teamName).join(", ")} assets before their difficult fixture run.` });
      } else if (improvingHere.length > 0) {
        roadmap.push({ label: `Gameweek ${gw}`, text: `${improvingHere.map((r) => r.teamName).join(", ")}'s favourable fixture swing begins - worth monitoring.` });
      } else {
        roadmap.push({ label: `Gameweek ${gw}`, text: "Hold unless a squad player's status changes." });
      }
    }
  }

  // Players to Monitor - clubs entering a good run within the horizon
  // that the squad doesn't already own, top scorer per club.
  const monitorList =
    planningGameweek != null
      ? ratings
          .filter(
            (r) =>
              r.swingDirection === "improving" &&
              r.startsInGameweek != null &&
              r.startsInGameweek >= planningGameweek &&
              r.startsInGameweek < planningGameweek + activeHorizon.gameweeks &&
              !squadTeamsSet.has(r.teamName)
          )
          .map((r) => {
            const teamPlayers = (pool ?? [])
              .filter((p) => p.team_name === r.teamName && !squadIds.has(p.game_player_id) && p.hail_mary_score != null)
              .sort((a, b) => Number(b.hail_mary_score) - Number(a.hail_mary_score));
            const top = teamPlayers[0];
            if (!top) return null;
            return {
              gamePlayerId: top.game_player_id,
              fullName: top.full_name,
              teamName: r.teamName,
              position: top.position,
              price: Number(top.price),
              hailMaryScore: top.hail_mary_score != null ? Number(top.hail_mary_score) : null,
              startsInGameweek: r.startsInGameweek,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x != null)
          .slice(0, 6)
      : [];

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div>
          {header}
          {squadSelector}

          <div className="mt-4 flex flex-col gap-4">
            {settingsPanel}
            {squadSummary}

            {!hasCalendar && (
              <p className="text-xs text-amber-400">
                No gameweek calendar published for FanTeam yet - showing the latest single projection instead of a
                horizon-specific one.
              </p>
            )}

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Squad Health Check</h2>
              <div className="mt-2 rounded-xl border border-navy-700 bg-navy-900 p-4">
                <div className="flex items-center gap-3">
                  <span className="text-3xl font-bold text-sky-400">{health.rating}</span>
                  <span className="text-sm text-navy-400">/ 100 squad rating</span>
                </div>
                {health.strengths.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-emerald-400">Strengths</p>
                    <ul className="mt-1 list-inside list-disc text-sm text-navy-200">
                      {health.strengths.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {health.weaknesses.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-amber-400">Weaknesses</p>
                    <ul className="mt-1 list-inside list-disc text-sm text-navy-200">
                      {health.weaknesses.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {health.priorityAreas.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-navy-400">Priority areas</p>
                    <ol className="mt-1 list-inside list-decimal text-sm text-navy-200">
                      {health.priorityAreas.map((p) => (
                        <li key={p.position}>
                          {p.position} - {p.reason}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {health.strengths.length === 0 && health.weaknesses.length === 0 && (
                  <p className="mt-3 text-sm text-navy-400">Not enough data yet to assess strengths or weaknesses in detail.</p>
                )}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Mary&apos;s Best Moves</h2>
              {hold ? (
                <div className="mt-2 rounded-xl border border-emerald-800 bg-emerald-950/30 p-4">
                  <p className="text-sm text-emerald-300">
                    Your squad is well positioned for the {activeHorizon.label.toLowerCase()}. No available transfer
                    creates a meaningful expected-points improvement right now.
                  </p>
                </div>
              ) : (
                <>
                  <div className="mt-2 flex flex-col gap-2">
                    {categoryCards.map((c, i) => (
                      <RecommendationCard key={`cat-${i}-${c.outGamePlayerId}-${c.inGamePlayerId}`} rec={c} gameId={fanteamGame.id} />
                    ))}
                  </div>
                  <p className="mt-4 text-xs font-medium uppercase tracking-wide text-navy-500">
                    Ranked moves ({activeStrategy} strategy)
                  </p>
                  <div className="mt-2 flex flex-col gap-2">
                    {rankedMoves.map((rec) => (
                      <RecommendationCard key={`${rec.outGamePlayerId}-${rec.inGamePlayerId}`} rec={rec} gameId={fanteamGame.id} />
                    ))}
                  </div>
                </>
              )}
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Captaincy</h2>
              <div className="mt-2 rounded-xl border border-navy-700 bg-navy-900 p-4">
                {!bestCaptain ? (
                  <p className="text-sm text-navy-400">Set a starting XI to get captaincy advice.</p>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <CaptainOption label="Best captain" player={bestCaptain} />
                    <CaptainOption label="Safest captain" player={safestCaptain} />
                    <CaptainOption label="Vice-captain" player={viceCaptain} />
                    <CaptainOption label="Differential captain" player={differentialCaptain} note={!differentialCaptain ? "Every starter is a confirmed starter right now." : undefined} />
                  </div>
                )}
                <p className="mt-3 text-xs text-navy-500">
                  Highest-ceiling captaincy isn&apos;t shown - the app doesn&apos;t yet track scoring variance/ceiling data,
                  so we&apos;re not going to guess at it.
                </p>
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Mary&apos;s Gameweek Plan</h2>
              {roadmap.length === 0 ? (
                <p className="mt-2 text-sm text-navy-400">No gameweek calendar published yet to build a roadmap from.</p>
              ) : (
                <div className="mt-2 flex flex-col gap-2">
                  {roadmap.map((r) => (
                    <div key={r.label} className="rounded-lg border border-navy-800 bg-navy-950 p-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-sky-400">{r.label}</p>
                      <p className="mt-1 text-sm text-navy-200">{r.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="flex flex-col gap-4">
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Players to Watch</h2>
            {monitorList.length === 0 ? (
              <p className="mt-2 text-xs text-navy-400">No new fixture-swing targets within your planning window right now.</p>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                {monitorList.map((p) => (
                  <div key={p.gamePlayerId} className="rounded-lg border border-navy-800 bg-navy-950 p-2">
                    <p className="text-sm font-medium text-white">{p.fullName}</p>
                    <p className="text-[11px] text-navy-400">
                      {p.position} · {p.teamName} · £{p.price.toFixed(1)}m · HMS {p.hailMaryScore != null ? p.hailMaryScore.toFixed(1) : "-"}
                    </p>
                    <p className="mt-0.5 text-[11px] text-emerald-400">Fixture swing begins GW{p.startsInGameweek}</p>
                    <div className="mt-1.5">
                      <AskMaryWatchlistButton
                        gameId={fanteamGame.id}
                        gamePlayerId={p.gamePlayerId}
                        defaultReasons={["fixture_swing"]}
                        notes={`Added from ASK MARY - positive fixture swing begins GW${p.startsInGameweek}.`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function CaptainOption({
  label,
  player,
  note,
}: {
  label: string;
  player: { full_name: string; team_name: string; score: number } | null;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-navy-800 bg-navy-950 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-sky-400">{label}</p>
      {player ? (
        <>
          <p className="mt-1 text-sm font-medium text-white">{player.full_name}</p>
          <p className="text-[11px] text-navy-400">
            {player.team_name} · HMS {player.score.toFixed(1)}
          </p>
        </>
      ) : (
        <p className="mt-1 text-xs text-navy-500">{note ?? "Not available."}</p>
      )}
    </div>
  );
}
