"use server";

import { revalidatePath } from "next/cache";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

type AddToWatchlistArgs = {
  gameId: number;
  gamePlayerId: number;
  reasons: string[];
  notes?: string;
};

/**
 * Upsert, merging reasons rather than overwriting - re-adding a player
 * already being watched for one reason (e.g. "Buy Target") with a second
 * click from a different context (e.g. "Fixture Swing") should combine
 * them, not lose the first one. Read-then-write since Postgres has no
 * clean single-statement "append distinct to array on conflict."
 */
export async function addToWatchlist({ gameId, gamePlayerId, reasons, notes }: AddToWatchlistArgs) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to use the watchlist." };

  const { data: existing } = await supabase
    .from("watchlist_entries")
    .select("watch_reasons, notes")
    .eq("user_id", user.id)
    .eq("game_id", gameId)
    .eq("game_player_id", gamePlayerId)
    .maybeSingle();

  const mergedReasons = Array.from(new Set([...(existing?.watch_reasons ?? []), ...reasons]));

  const { error } = await supabase.from("watchlist_entries").upsert(
    {
      user_id: user.id,
      game_id: gameId,
      game_player_id: gamePlayerId,
      watch_reasons: mergedReasons,
      notes: notes ?? existing?.notes ?? null,
    },
    { onConflict: "user_id,game_id,game_player_id" }
  );
  if (error) return { error: error.message };

  revalidatePath("/watchlist");
  return { success: true };
}

export async function removeFromWatchlist({ id }: { id: number }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to use the watchlist." };

  // RLS already scopes deletes to auth.uid() = user_id - the explicit
  // .eq("user_id", ...) here is defense in depth, not the only guard.
  const { error } = await supabase.from("watchlist_entries").delete().eq("id", id).eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/watchlist");
  return { success: true };
}

export async function updateWatchlistNotes({ id, notes }: { id: number; notes: string }) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to use the watchlist." };

  const { error } = await supabase.from("watchlist_entries").update({ notes }).eq("id", id).eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/watchlist");
  return { success: true };
}

export type SnapshotUpdate = {
  id: number;
  lastSeenScore: number | null;
  lastSeenLineup: string | null;
  lastSeenStatus: string | null;
  lastSeenSwingKind: string | null;
};

/**
 * Called from watchlist/page.tsx's own server-side render right after
 * computeWatchlistAlerts() reads the previous snapshot - persists the
 * freshly-computed state so the same change isn't re-alerted on the next
 * load. Not a client-triggered action (no revalidatePath needed - it
 * runs inline during the same render that will show the result).
 */
export async function reconcileWatchlistSnapshot(updates: SnapshotUpdate[]) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || updates.length === 0) return;

  await Promise.all(
    updates.map((u) =>
      supabase
        .from("watchlist_entries")
        .update({
          last_seen_score: u.lastSeenScore,
          last_seen_lineup: u.lastSeenLineup,
          last_seen_status: u.lastSeenStatus,
          last_seen_swing_kind: u.lastSeenSwingKind,
        })
        .eq("id", u.id)
        .eq("user_id", user.id)
    )
  );
}
