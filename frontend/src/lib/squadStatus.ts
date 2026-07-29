import type { createAuthServerClient } from "./supabaseServerClient";

export type SquadStatus = {
  id: number;
  name: string;
  gameId: number;
  gameSlug: string;
  gameDisplayName: string;
  hasBench: boolean;
  budgetRemaining: number;
  freeTransfers: number;
  currentGameweek: number | null;
  nextGameweekScore: number | null;
  needsAttention: boolean;
  // A test squad created purely to analyse through Ask Mary (see
  // migration 0059) - never a real entry. Kept out of /squads' main
  // per-game groups and Performance Lab's grading.
  isScratch: boolean;
  scratchSourceSquadId: number | null;
};

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

/**
 * One place computing "what's the state of this squad" - used by both the
 * dashboard (Part 3) and the squads list (Part 4) so there's a single
 * source of truth instead of two divergent implementations. Reuses the
 * same budget calc as transfers/page.tsx and the same
 * player_score_by_horizon(slug, 1) call lineup/page.tsx already uses for
 * its best-XI suggestion - just summed over the squad's actual starters
 * here instead of an optimizer.
 */
export async function getSquadStatuses(supabase: Supabase, userId: string): Promise<SquadStatus[]> {
  const { data: squads } = await supabase
    .from("squads")
    .select("id, name, game_id, free_transfers, is_scratch, scratch_source_squad_id, fantasy_games(slug, display_name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (!squads || squads.length === 0) return [];

  const { data: rules } = await supabase
    .from("game_squad_rules")
    .select("game_id, squad_size, starting_size, budget");
  const rulesByGame = new Map((rules ?? []).map((r) => [r.game_id, r]));

  // Cache per-game horizon scores so two squads in the same game (e.g.
  // multiple FanTeam entries) don't trigger the same RPC call twice.
  const scoreCacheByGameSlug = new Map<string, Map<number, number>>();
  async function getScoreMap(gameSlug: string) {
    if (scoreCacheByGameSlug.has(gameSlug)) return scoreCacheByGameSlug.get(gameSlug)!;
    const { data: horizonData } = await supabase.rpc("player_score_by_horizon", {
      p_game_slug: gameSlug,
      p_num_gameweeks: 1,
    });
    const map = new Map<number, number>(
      ((horizonData ?? []) as { game_player_id: number; avg_score: number }[]).map((r) => [r.game_player_id, Number(r.avg_score)])
    );
    scoreCacheByGameSlug.set(gameSlug, map);
    return map;
  }

  const statuses: SquadStatus[] = [];
  for (const squad of squads) {
    const game = squad.fantasy_games as unknown as { slug: string; display_name: string };
    const rule = rulesByGame.get(squad.game_id);
    const hasBench = !!rule && rule.squad_size > rule.starting_size;

    const { data: squadPlayers } = await supabase
      .from("squad_players")
      .select("game_player_id, is_starting, game_players(price)")
      .eq("squad_id", squad.id)
      .returns<{ game_player_id: number; is_starting: boolean; game_players: { price: number } }[]>();

    const totalPrice = (squadPlayers ?? []).reduce((sum, p) => sum + Number(p.game_players.price), 0);
    const budgetRemaining = rule ? Number(rule.budget) - totalPrice : 0;

    const startingCount = (squadPlayers ?? []).filter((p) => p.is_starting).length;
    const needsAttention = hasBench && !!rule && startingCount !== rule.starting_size;

    const { data: gwRow } = await supabase
      .from("game_fixture_gameweeks")
      .select("gameweek, fixtures!inner(kickoff_at)")
      .eq("game_id", squad.game_id)
      .gte("fixtures.kickoff_at", new Date().toISOString())
      .order("gameweek", { ascending: true })
      .limit(1)
      .maybeSingle();
    const currentGameweek: number | null = gwRow?.gameweek ?? null;

    let nextGameweekScore: number | null = null;
    if (currentGameweek !== null) {
      const scoreById = await getScoreMap(game.slug);
      const starters = (squadPlayers ?? []).filter((p) => p.is_starting);
      if (starters.length > 0) {
        nextGameweekScore = starters.reduce((sum, p) => sum + (scoreById.get(p.game_player_id) ?? 0), 0);
      }
    }

    statuses.push({
      id: squad.id,
      name: squad.name,
      gameId: squad.game_id,
      gameSlug: game.slug,
      gameDisplayName: game.display_name,
      hasBench,
      budgetRemaining,
      freeTransfers: squad.free_transfers,
      currentGameweek,
      nextGameweekScore,
      needsAttention,
      isScratch: squad.is_scratch,
      scratchSourceSquadId: squad.scratch_source_squad_id,
    });
  }

  return statuses;
}
