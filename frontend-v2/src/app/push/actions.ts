"use server";

import { createAuthServerClient } from "@/lib/supabaseServerClient";

type PushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * Upsert on endpoint (the browser-issued subscription URL - unique per
 * browser+origin registration), re-activating a previously-disabled
 * subscription on the same device rather than creating a duplicate row.
 * See migration 0054 - ported from the old frontend's golf-only version
 * (2026-08-18), now also the subscribe path for odds-swing alerts (see
 * scripts/detect_odds_swings.py). scripts/poll_golf_live_scores.py and
 * scripts/detect_odds_swings.py both write/read this same table directly
 * over DATABASE_URL for their own send loops.
 */
export async function subscribeToPush(subscription: PushSubscriptionInput) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to enable notifications." };

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      is_active: true,
    },
    { onConflict: "endpoint" }
  );
  if (error) return { error: error.message };

  return { success: true };
}

export async function unsubscribeFromPush(endpoint: string) {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to manage notifications." };

  // RLS already scopes this to auth.uid() = user_id - the explicit
  // .eq("user_id", ...) here is defense in depth, not the only guard.
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  return { success: true };
}
