import Link from "next/link";
import { notFound } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import TransferPlanner from "./TransferPlanner";

type SquadPlayerRow = {
  game_player_id: number;
  game_players: {
    price: number;
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD"; team_id: number; teams: { name: string } };
  };
};

type PoolPlayer = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  price: number;
  hail_mary_score: number | null;
};

type HorizonRow = { game_player_id: number; avg_score: number };

const HORIZONS = [
  { key: "short", label: "Short (1 GW)", gameweeks: 1 },
  { key: "medium", label: "Medium (2 GW avg)", gameweeks: 2 },
  { key: "long", label: "Long (3 GW avg)", gameweeks: 3 },
] as const;

export type Recommendation = {
  outGamePlayerId: number;
  outName: string;
  outTeam: string;
  outPrice: number;
  outScore: number;
  inGamePlayerId: number;
  inName: string;
  inTeam: string;
  inPrice: number;
  inScore: number;
  delta: number;
  position: string;
};

export default async function TransfersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ horizon?: string }>;
}) {
  const { id } = await params;
  const { horizon: horizonParam } = await searchParams;
  const squadId = Number(id);
  if (!Number.isInteger(squadId)) notFound();
  const activeHorizon = HORIZONS.find((h) => h.key === horizonParam) ?? HORIZONS[0];

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: squad } = await supabase
    .from("squads")
    .select(
      "id, name, user_id, game_id, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek, fantasy_games(slug, display_name)"
    )
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user?.id) notFound();

  const { data: gwRow } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures!inner(kickoff_at)")
    .eq("game_id", squad.game_id)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek", { ascending: true })
    .limit(1)
    .maybeSingle();
  const currentGameweek: number | null = gwRow?.gameweek ?? null;

  const wc1Active = squad.wildcard_1_used_gameweek === currentGameweek;
  const wc2Active = squad.wildcard_2_used_gameweek === currentGameweek;
  const wildcardActiveThisWeek = wc1Active || wc2Active;
  const wc1Available =
    currentGameweek !== null && currentGameweek >= 2 && currentGameweek <= 19 && squad.wildcard_1_used_gameweek === null;
  const wc2Available =
    currentGameweek !== null && currentGameweek >= 20 && currentGameweek <= 38 && squad.wildcard_2_used_gameweek === null;

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("budget, max_per_club")
    .eq("game_id", squad.game_id)
    .single();
  if (!rules) notFound();

  const game = squad.fantasy_games as unknown as { slug: string; display_name: string };

  const { data: squadPlayersRaw } = await supabase
    .from("squad_players")
    .select("game_player_id, game_players(price, players(full_name, position, team_id, teams(name)))")
    .eq("squad_id", squadId)
    .returns<SquadPlayerRow[]>();

  const squadPlayers = (squadPlayersRaw ?? []).map((sp) => ({
    game_player_id: sp.game_player_id,
    full_name: sp.game_players.players.full_name,
    position: sp.game_players.players.position,
    team_id: sp.game_players.players.team_id,
    team_name: sp.game_players.players.teams.name,
    price: Number(sp.game_players.price),
  }));

  const { data: pool } = await supabase
    .from("game_player_pool")
    .select("*")
    .eq("game_slug", game.slug)
    .returns<PoolPlayer[]>();

  const squadIds = new Set(squadPlayers.map((p) => p.game_player_id));
  const currentTotal = squadPlayers.reduce((sum, p) => sum + p.price, 0);
  const budgetRemaining = Number(rules.budget) - currentTotal;

  const clubCounts = new Map<number, number>();
  squadPlayers.forEach((p) => clubCounts.set(p.team_id, (clubCounts.get(p.team_id) ?? 0) + 1));

  // Score players over the selected horizon (same player_score_by_horizon
  // RPC the rankings page uses) instead of just next gameweek, so
  // recommendations reflect "best swap over the next N gameweeks" rather
  // than one week's fixture swing. Falls back to game_player_pool's latest
  // single projection for games with no published gameweek calendar yet
  // (Dream Team) - same fallback the rankings page uses.
  const { data: horizonData, error: horizonError } = await supabase
    .rpc("player_score_by_horizon", { p_game_slug: game.slug, p_num_gameweeks: activeHorizon.gameweeks })
    .returns<HorizonRow[]>();
  const horizonAvailable = !horizonError && horizonData && horizonData.length > 0;

  const scoreById = horizonAvailable
    ? new Map(horizonData!.map((r) => [r.game_player_id, r.avg_score]))
    : new Map((pool ?? []).map((p) => [p.game_player_id, p.hail_mary_score]));

  const recommendations: Recommendation[] = [];
  for (const outPlayer of squadPlayers) {
    const outScore = scoreById.get(outPlayer.game_player_id) ?? 0;
    const affordableBudget = budgetRemaining + outPlayer.price;

    const candidates = (pool ?? []).filter((p) => {
      if (squadIds.has(p.game_player_id)) return false;
      if (p.position !== outPlayer.position) return false;
      if (p.price > affordableBudget) return false;
      if (rules.max_per_club) {
        const clubCountWithoutOut = (clubCounts.get(p.team_id) ?? 0) - (p.team_id === outPlayer.team_id ? 1 : 0);
        if (clubCountWithoutOut + 1 > rules.max_per_club) return false;
      }
      return (scoreById.get(p.game_player_id) ?? 0) > outScore;
    });

    candidates.sort((a, b) => (scoreById.get(b.game_player_id) ?? 0) - (scoreById.get(a.game_player_id) ?? 0));
    const best = candidates[0];
    if (best) {
      const bestScore = scoreById.get(best.game_player_id) ?? 0;
      recommendations.push({
        outGamePlayerId: outPlayer.game_player_id,
        outName: outPlayer.full_name,
        outTeam: outPlayer.team_name,
        outPrice: outPlayer.price,
        outScore,
        inGamePlayerId: best.game_player_id,
        inName: best.full_name,
        inTeam: best.team_name,
        inPrice: Number(best.price),
        inScore: bestScore,
        delta: bestScore - outScore,
        position: outPlayer.position,
      });
    }
  }

  recommendations.sort((a, b) => b.delta - a.delta);

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black">
      <main className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">{squad.name}: transfers</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {game.display_name} · £{budgetRemaining.toFixed(1)}m in the bank
        </p>

        {currentGameweek === null ? (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
            Weekly transfer limits aren&apos;t enforced yet - no gameweek calendar exists for{" "}
            {game.display_name} until the season starts. This shows every improving swap available,
            not just what your remaining transfers this week would allow.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-zinc-100 px-3 py-1 font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              GW{currentGameweek} · {squad.free_transfers} free transfer{squad.free_transfers === 1 ? "" : "s"}
            </span>
            {wildcardActiveThisWeek && (
              <span className="rounded-full bg-green-100 px-3 py-1 font-medium text-green-700 dark:bg-green-950 dark:text-green-400">
                Wildcard active this gameweek - transfers are free
              </span>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Planning horizon
          </span>
          <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
            {HORIZONS.map((h) => (
              <Link
                key={h.key}
                href={`/squads/${squadId}/transfers?horizon=${h.key}`}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  h.key === activeHorizon.key
                    ? "bg-white text-black shadow-sm dark:bg-zinc-700 dark:text-white"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                {h.label}
              </Link>
            ))}
          </div>
          {!horizonAvailable && (
            <span className="text-xs text-amber-600 dark:text-amber-500">
              Gameweek calendar not published for {game.display_name} yet - showing latest single projection instead.
            </span>
          )}
        </div>

        <div className="mt-6">
          <TransferPlanner
            squadId={squadId}
            recommendations={recommendations}
            currentGameweek={currentGameweek}
            freeTransfers={squad.free_transfers}
            wildcardActiveThisWeek={wildcardActiveThisWeek}
            wc1Available={wc1Available}
            wc2Available={wc2Available}
          />
        </div>
      </main>
    </div>
  );
}
