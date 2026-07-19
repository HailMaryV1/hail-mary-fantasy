import Link from "next/link";
import { notFound } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { findSellCandidatesForTarget, type SquadMember, type TransferCandidate } from "@/lib/transferMatching";
import Badge from "../../squads/Badge";
import TransferInConfirm from "./TransferInConfirm";

type PoolRow = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  price: number;
  hail_mary_score: number | null;
};

type SquadPlayerRow = {
  game_player_id: number;
  game_players: {
    price: number;
    players: { full_name: string; position: "GK" | "DEF" | "MID" | "FWD"; team_id: number; teams: { name: string } };
  };
};

type FixtureContributionRow = { gameweek: number; contribution: number };

/**
 * Given a watchlist target, analyse the user's actual squad and recommend
 * a real swap - Player Out / Budget Remaining / Expected Points Difference
 * over 1/3/5 gameweeks - rather than leaving "Transfer In" as a dead end.
 * Reuses lib/transferMatching.ts (same matching logic the transfers page
 * itself uses) and squads/actions.ts's makeTransfer to actually execute
 * it - no squad-mutation logic duplicated here.
 */
export default async function TransferInPage({
  searchParams,
}: {
  searchParams: Promise<{ player?: string; game?: string; squad?: string }>;
}) {
  const { player, game: gameIdParam, squad: squadIdParam } = await searchParams;
  const targetGamePlayerId = Number(player);
  const gameId = Number(gameIdParam);
  if (!Number.isInteger(targetGamePlayerId) || !Number.isInteger(gameId)) notFound();

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          <p className="text-sm text-navy-300">
            <Link href="/login" className="text-sky-400 hover:text-sky-300">
              Sign in
            </Link>{" "}
            to transfer players in.
          </p>
        </main>
      </div>
    );
  }

  const { data: game } = await supabase.from("fantasy_games").select("id, slug, display_name").eq("id", gameId).single();
  if (!game) notFound();

  const { data: targetRow } = await supabase
    .from("game_player_pool")
    .select("*")
    .eq("game_slug", game.slug)
    .eq("game_player_id", targetGamePlayerId)
    .returns<PoolRow[]>()
    .maybeSingle();
  if (!targetRow) notFound();

  const { data: squads } = await supabase.from("squads").select("id, name").eq("user_id", user.id).eq("game_id", gameId);

  if (!squads || squads.length === 0) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          <h1 className="text-2xl font-semibold text-white">Transfer in {targetRow.full_name}</h1>
          <p className="mt-4 text-sm text-navy-300">
            You don&apos;t have a {game.display_name} squad yet.{" "}
            <Link href={`/squads/new?game=${game.slug}`} className="text-sky-400 hover:text-sky-300">
              Build one first
            </Link>
            .
          </p>
        </main>
      </div>
    );
  }

  const squadId = squadIdParam ? Number(squadIdParam) : squads.length === 1 ? squads[0].id : null;

  if (squadId === null) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          <h1 className="text-2xl font-semibold text-white">Transfer in {targetRow.full_name}</h1>
          <p className="mt-4 text-sm text-navy-300">You have more than one {game.display_name} squad - which one?</p>
          <div className="mt-3 flex flex-col gap-2">
            {squads.map((s) => (
              <Link
                key={s.id}
                href={`/watchlist/transfer-in?player=${targetGamePlayerId}&game=${gameId}&squad=${s.id}`}
                className="rounded-lg border border-navy-700 bg-navy-900 px-4 py-2 text-sm text-white hover:bg-navy-800"
              >
                {s.name}
              </Link>
            ))}
          </div>
        </main>
      </div>
    );
  }

  const { data: squad } = await supabase.from("squads").select("id, name, user_id, game_id").eq("id", squadId).single();
  if (!squad || squad.user_id !== user.id || squad.game_id !== gameId) notFound();

  const { data: rules } = await supabase.from("game_squad_rules").select("budget, max_per_club").eq("game_id", gameId).single();
  if (!rules) notFound();

  const { data: squadPlayersRaw } = await supabase
    .from("squad_players")
    .select("game_player_id, game_players(price, players(full_name, position, team_id, teams(name)))")
    .eq("squad_id", squadId)
    .returns<SquadPlayerRow[]>();

  const alreadyOwned = (squadPlayersRaw ?? []).some((sp) => sp.game_player_id === targetGamePlayerId);

  const { data: scoreRows } = await supabase
    .from("game_player_pool")
    .select("game_player_id, hail_mary_score")
    .eq("game_slug", game.slug)
    .in(
      "game_player_id",
      (squadPlayersRaw ?? []).map((sp) => sp.game_player_id)
    );
  const scoreById = new Map((scoreRows ?? []).map((r) => [r.game_player_id, r.hail_mary_score != null ? Number(r.hail_mary_score) : 0]));

  const squadMembers: SquadMember[] = (squadPlayersRaw ?? []).map((sp) => ({
    gamePlayerId: sp.game_player_id,
    fullName: sp.game_players.players.full_name,
    teamId: sp.game_players.players.team_id,
    teamName: sp.game_players.players.teams.name,
    price: Number(sp.game_players.price),
    score: scoreById.get(sp.game_player_id) ?? 0,
    position: sp.game_players.players.position,
  }));

  const target: TransferCandidate = {
    gamePlayerId: targetRow.game_player_id,
    fullName: targetRow.full_name,
    teamId: targetRow.team_id,
    teamName: targetRow.team_name,
    price: Number(targetRow.price),
    score: targetRow.hail_mary_score != null ? Number(targetRow.hail_mary_score) : 0,
    position: targetRow.position,
  };

  const currentTotal = squadMembers.reduce((sum, p) => sum + p.price, 0);
  const budgetRemaining = Number(rules.budget) - currentTotal;
  const clubCounts = new Map<number, number>();
  squadMembers.forEach((p) => clubCounts.set(p.teamId, (clubCounts.get(p.teamId) ?? 0) + 1));

  const matches = alreadyOwned
    ? []
    : findSellCandidatesForTarget(squadMembers, target, budgetRemaining, clubCounts, rules.max_per_club);
  const bestOut = matches[0]?.candidate ?? null;

  let expectedDiff: { gw1: number; gw3: number; gw5: number } | null = null;
  if (bestOut) {
    const [targetFixtures, outFixtures] = await Promise.all([
      supabase.rpc("player_projection_fixtures_by_horizon", { p_game_player_id: target.gamePlayerId, p_num_gameweeks: 5 }),
      supabase.rpc("player_projection_fixtures_by_horizon", { p_game_player_id: bestOut.gamePlayerId, p_num_gameweeks: 5 }),
    ]);
    const targetRows = (targetFixtures.data as FixtureContributionRow[] | null) ?? [];
    const outRows = (outFixtures.data as FixtureContributionRow[] | null) ?? [];

    function sumWindows(fixtureRows: FixtureContributionRow[]) {
      const byGameweek = new Map<number, number>();
      for (const r of fixtureRows) byGameweek.set(r.gameweek, (byGameweek.get(r.gameweek) ?? 0) + Number(r.contribution));
      const gameweeks = Array.from(byGameweek.keys()).sort((a, b) => a - b);
      const sumFirst = (n: number) => gameweeks.slice(0, n).reduce((sum, gw) => sum + (byGameweek.get(gw) ?? 0), 0);
      return { gw1: sumFirst(1), gw3: sumFirst(3), gw5: sumFirst(5) };
    }

    const targetWindows = sumWindows(targetRows);
    const outWindows = sumWindows(outRows);
    expectedDiff = {
      gw1: targetWindows.gw1 - outWindows.gw1,
      gw3: targetWindows.gw3 - outWindows.gw3,
      gw5: targetWindows.gw5 - outWindows.gw5,
    };
  }

  const newBudgetRemaining = bestOut ? budgetRemaining + bestOut.price - target.price : null;

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <Link href="/watchlist" className="text-sm text-navy-400 hover:text-sky-300">
          ← Back to watchlist
        </Link>
        <h1 className="mt-3 text-2xl font-semibold text-white">Transfer in {targetRow.full_name}</h1>
        <p className="mt-1 text-sm text-navy-300">{squad.name}</p>

        {alreadyOwned ? (
          <p className="mt-6 text-sm text-amber-400">{targetRow.full_name} is already in this squad.</p>
        ) : !bestOut ? (
          <p className="mt-6 text-sm text-amber-400">
            No legal swap found - either no same-position player in your squad can afford this transfer, or it would
            break your club limit.
          </p>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 gap-4">
              <div className="rounded-xl border border-red-900 bg-navy-900 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-red-400">Player Out</p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge teamName={bestOut.teamName} size="sm" />
                  <p className="font-medium text-white">{bestOut.fullName}</p>
                </div>
                <p className="text-xs text-navy-400">
                  {bestOut.position} · {bestOut.teamName} · £{bestOut.price.toFixed(1)}m · {bestOut.score.toFixed(1)} pts
                </p>
              </div>
              <div className="rounded-xl border border-emerald-900 bg-navy-900 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-emerald-400">Player In</p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge teamName={target.teamName} size="sm" />
                  <p className="font-medium text-white">{target.fullName}</p>
                </div>
                <p className="text-xs text-navy-400">
                  {target.position} · {target.teamName} · £{target.price.toFixed(1)}m · {target.score.toFixed(1)} pts
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-navy-400">Budget remaining after swap</p>
              <p className={`mt-1 text-xl font-semibold ${(newBudgetRemaining ?? 0) < 0 ? "text-red-400" : "text-white"}`}>
                £{newBudgetRemaining?.toFixed(1)}m
              </p>
            </div>

            {expectedDiff && (
              <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-navy-400">Expected points difference</p>
                <div className="mt-2 grid grid-cols-3 gap-3 text-center">
                  {(
                    [
                      ["1 gameweek", expectedDiff.gw1],
                      ["3 gameweeks", expectedDiff.gw3],
                      ["5 gameweeks", expectedDiff.gw5],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <p className="text-xs text-navy-400">{label}</p>
                      <p className={`text-lg font-semibold ${value >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {value >= 0 ? "+" : ""}
                        {value.toFixed(1)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6">
              <TransferInConfirm squadId={squadId} outGamePlayerId={bestOut.gamePlayerId} inGamePlayerId={target.gamePlayerId} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
