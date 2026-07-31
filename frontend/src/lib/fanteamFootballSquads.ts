import type { createAuthServerClient } from "./supabaseServerClient";

export type FanteamFootballSquadCard = {
  id: number;
  name: string;
  captainName: string | null;
  currentRank: number | null;
  projectedScore: number | null;
  lastSyncedAt: string | null;
  syncStatus: "syncing" | "ok" | "error" | "never";
};

export type FanteamCompetitionGroup = {
  competitionId: number | null;
  competitionName: string;
  status: "upcoming" | "running" | "ended" | null;
  squads: FanteamFootballSquadCard[];
};

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

/**
 * The provider-synchronisation read model for the dedicated FanTeam
 * Football page (/games/fanteam) - deliberately separate from
 * squadStatus.ts's getSquadStatuses, which has no business carrying
 * competition/rank/sync fields every other game doesn't have. Every
 * squad here was created by sync_provider_squads.py's
 * get_or_create_squad_link, never by hand - there is no manual-creation
 * path into this page's data at all.
 */
export async function getFanteamFootballSquads(supabase: Supabase, userId: string): Promise<FanteamCompetitionGroup[]> {
  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam").single();
  if (!game) return [];

  const { data: links } = await supabase
    .from("provider_squad_links")
    .select(
      `
      id, competition_id, last_synced_at, last_sync_status, sync_requested_at, current_rank,
      squads!inner(id, name, captain_game_player_id, game_id, user_id),
      provider_competitions(id, competition_name, status)
      `
    )
    .eq("provider", "fanteam_scoutgg")
    .eq("squads.game_id", game.id)
    .eq("squads.user_id", userId)
    .returns<
      {
        id: number;
        competition_id: number | null;
        last_synced_at: string | null;
        last_sync_status: "never" | "ok" | "error";
        sync_requested_at: string | null;
        current_rank: number | null;
        squads: { id: number; name: string; captain_game_player_id: number | null };
        provider_competitions: { id: number; competition_name: string; status: "upcoming" | "running" | "ended" | null } | null;
      }[]
    >();

  if (!links || links.length === 0) return [];

  const captainIds = [...new Set(links.map((l) => l.squads.captain_game_player_id).filter((id): id is number => id != null))];
  const captainNameById = new Map<number, string>();
  if (captainIds.length > 0) {
    const { data: captains } = await supabase
      .from("game_players")
      .select("id, players(full_name)")
      .in("id", captainIds)
      .returns<{ id: number; players: { full_name: string } }[]>();
    for (const c of captains ?? []) captainNameById.set(c.id, c.players.full_name);
  }

  const squadIds = links.map((l) => l.squads.id);
  const { data: starters } = await supabase
    .from("squad_players")
    .select("squad_id, game_player_id")
    .in("squad_id", squadIds)
    .eq("is_starting", true);

  const { data: horizonData } = await supabase.rpc("player_score_by_horizon", {
    p_game_slug: "fanteam",
    p_num_gameweeks: 1,
  });
  const scoreById = new Map<number, number>(
    ((horizonData ?? []) as { game_player_id: number; avg_score: number }[]).map((r) => [r.game_player_id, Number(r.avg_score)])
  );

  const startersBySquad = new Map<number, number[]>();
  for (const s of starters ?? []) {
    const list = startersBySquad.get(s.squad_id) ?? [];
    list.push(s.game_player_id);
    startersBySquad.set(s.squad_id, list);
  }

  const groups = new Map<string, FanteamCompetitionGroup>();
  for (const link of links) {
    const groupKey = link.provider_competitions ? `c${link.provider_competitions.id}` : `link${link.id}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        competitionId: link.provider_competitions?.id ?? null,
        competitionName: link.provider_competitions?.competition_name ?? link.squads.name,
        status: link.provider_competitions?.status ?? null,
        squads: [],
      });
    }

    const squadStarters = startersBySquad.get(link.squads.id) ?? [];
    const projectedScore = squadStarters.length > 0
      ? squadStarters.reduce((sum, gpid) => sum + (scoreById.get(gpid) ?? 0), 0)
      : null;

    const syncStatus: FanteamFootballSquadCard["syncStatus"] = link.sync_requested_at ? "syncing" : link.last_sync_status;

    groups.get(groupKey)!.squads.push({
      id: link.squads.id,
      name: link.squads.name,
      captainName: link.squads.captain_game_player_id != null ? captainNameById.get(link.squads.captain_game_player_id) ?? null : null,
      currentRank: link.current_rank,
      projectedScore,
      lastSyncedAt: link.last_synced_at,
      syncStatus,
    });
  }

  return [...groups.values()];
}
