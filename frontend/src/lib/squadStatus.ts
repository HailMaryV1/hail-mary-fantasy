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
};

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;
type SquadPlayerRow = { game_player_id: number; is_starting: boolean; game_players: { price: number } };

/**
 * One place computing "what's the state of this squad" - used by both
 * games/[slug]/page.tsx and squads/page.tsx so there's a single source
 * of truth instead of two divergent implementations. Reuses the same
 * budget calc as transfers/page.tsx and the same
 * player_score_by_horizon(slug, 1) call lineup/page.tsx already uses for
 * its best-XI suggestion - just summed over the squad's actual starters
 * here instead of an optimizer.
 *
 * Archived squads (migration 0080 - a completed FanTeam Golf tournament
 * entry, nothing left to sync/project) are excluded entirely at the
 * query level, not just filtered out of the result - there's no live
 * status to compute for them at all. See scripts/archive_golf_squads.py
 * and /golf/algorithm-performance for where their historical data still
 * lives, unaffected by this.
 *
 * Confirmed live (2026-08-03): with 16 real squads, the previous version
 * of this function awaited one squad at a time in a for-loop, AND
 * re-fetched the same per-GAME data (current gameweek, projected scores)
 * once per squad even when several squads shared a game - ~40 sequential
 * round trips on every call. Restructured into two phases: fetch
 * per-game data (current gameweek, then - only for games that actually
 * have one - a scores RPC) ONCE per distinct game, all in parallel; then
 * build every squad's status in parallel too, since one squad's work
 * never depends on another's.
 */
export async function getSquadStatuses(supabase: Supabase, userId: string): Promise<SquadStatus[]> {
  const { data: squads } = await supabase
    .from("squads")
    .select("id, name, game_id, free_transfers, fantasy_games(slug, display_name)")
    .eq("user_id", userId)
    .eq("is_archived", false)
    .order("created_at", { ascending: false });

  if (!squads || squads.length === 0) return [];

  const { data: rules } = await supabase.from("game_squad_rules").select("game_id, squad_size, starting_size, budget");
  const rulesByGame = new Map((rules ?? []).map((r) => [r.game_id, r]));

  const gameSlugByGameId = new Map(squads.map((s) => [s.game_id, (s.fantasy_games as unknown as { slug: string }).slug]));
  const distinctGameIds = Array.from(gameSlugByGameId.keys());

  const gwByGameId = new Map<number, number | null>();
  await Promise.all(
    distinctGameIds.map(async (gameId) => {
      const { data: gwRow } = await supabase
        .from("game_fixture_gameweeks")
        .select("gameweek, fixtures!inner(kickoff_at)")
        .eq("game_id", gameId)
        .gte("fixtures.kickoff_at", new Date().toISOString())
        .order("gameweek", { ascending: true })
        .limit(1)
        .maybeSingle();
      gwByGameId.set(gameId, gwRow?.gameweek ?? null);
    })
  );

  // Only fetch a game's scores RPC when it actually has an upcoming
  // gameweek to project against (matches the original per-squad "skip
  // if no current gameweek" behaviour) - and only once per distinct
  // game slug even if several squads share it.
  const slugsNeedingScores = Array.from(
    new Set(distinctGameIds.filter((gid) => gwByGameId.get(gid) !== null).map((gid) => gameSlugByGameId.get(gid)!))
  );
  const scoreMapBySlug = new Map<string, Map<number, number>>();
  await Promise.all(
    slugsNeedingScores.map(async (slug) => {
      const { data: horizonData } = await supabase.rpc("player_score_by_horizon", {
        p_game_slug: slug,
        p_num_gameweeks: 1,
      });
      const map = new Map<number, number>(
        ((horizonData ?? []) as { game_player_id: number; avg_score: number }[]).map((r) => [r.game_player_id, Number(r.avg_score)])
      );
      scoreMapBySlug.set(slug, map);
    })
  );

  const statuses = await Promise.all(
    squads.map(async (squad) => {
      const game = squad.fantasy_games as unknown as { slug: string; display_name: string };
      const rule = rulesByGame.get(squad.game_id);
      const hasBench = !!rule && rule.squad_size > rule.starting_size;

      const { data: squadPlayers } = await supabase
        .from("squad_players")
        .select("game_player_id, is_starting, game_players(price)")
        .eq("squad_id", squad.id)
        .returns<SquadPlayerRow[]>();

      const totalPrice = (squadPlayers ?? []).reduce((sum, p) => sum + Number(p.game_players.price), 0);
      const budgetRemaining = rule ? Number(rule.budget) - totalPrice : 0;

      const startingCount = (squadPlayers ?? []).filter((p) => p.is_starting).length;
      const needsAttention = hasBench && !!rule && startingCount !== rule.starting_size;

      const currentGameweek = gwByGameId.get(squad.game_id) ?? null;

      let nextGameweekScore: number | null = null;
      if (currentGameweek !== null) {
        const scoreById = scoreMapBySlug.get(game.slug);
        const starters = (squadPlayers ?? []).filter((p) => p.is_starting);
        if (starters.length > 0 && scoreById) {
          nextGameweekScore = starters.reduce((sum, p) => sum + (scoreById.get(p.game_player_id) ?? 0), 0);
        }
      }

      return {
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
      };
    })
  );

  return statuses;
}
