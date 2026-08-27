"use server";

import { createAuthServerClient } from "./supabaseServerClient";

/** Every real club name in a game's pool - for the team-filter dropdown,
 * which needs the full distinct list even though the pool table itself
 * only ever loads one page at a time. */
export async function listPoolTeams(gameSlug: string): Promise<string[]> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase.rpc("list_game_pool_teams", { p_game_slug: gameSlug });
  return ((data as { team_name: string }[]) ?? []).map((r) => r.team_name);
}
