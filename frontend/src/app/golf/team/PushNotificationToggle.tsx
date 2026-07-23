"use client";

import { useEffect, useState, useTransition } from "react";
import { subscribeToPush, unsubscribeFromPush } from "@/app/push/actions";

// Converts the VAPID public key (base64url, as generated for
// NEXT_PUBLIC_VAPID_PUBLIC_KEY) into the raw byte array
// pushManager.subscribe's applicationServerKey option requires - the
// browser Push API doesn't accept the string form directly.
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export default function PushNotificationToggle() {
  // Whether THIS browser currently has an active push subscription - a
  // per-device fact the browser's own Push API is the only true source
  // for (the server only knows which endpoints exist in push_
  // subscriptions, not which one belongs to the tab that's rendering
  // right now), so this is checked client-side on mount rather than
  // passed down as a server-rendered prop.
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setSubscribed(false);
      return;
    }
    navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => setSubscribed(!!subscription))
      .catch(() => setSubscribed(false));
  }, []);

  function handleEnable() {
    setError(null);
    startTransition(async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
          setError("This browser doesn't support push notifications.");
          return;
        }
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setError("Notification permission denied - enable it in your browser's site settings to try again.");
          return;
        }
        const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
        if (!publicKey) {
          setError("Push isn't configured yet.");
          return;
        }
        const registration = await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          // TS's DOM lib types Uint8Array's generic ArrayBufferLike more
          // strictly than PushSubscriptionOptionsInit's BufferSource
          // accepts as of this TS version - the value itself is a normal
          // Uint8Array, just a type-level mismatch.
          applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        });
        const json = subscription.toJSON();
        if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
          setError("Couldn't read the new subscription - try again.");
          return;
        }
        const result = await subscribeToPush({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        });
        if ("error" in result && result.error) setError(result.error);
        else setSubscribed(true);
      } catch {
        setError("Couldn't enable notifications - try again.");
      }
    });
  }

  function handleDisable() {
    setError(null);
    startTransition(async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await unsubscribeFromPush(subscription.endpoint);
          await subscription.unsubscribe();
        }
        setSubscribed(false);
      } catch {
        setError("Couldn't disable notifications - try again.");
      }
    });
  }

  if (subscribed === null) return null; // still checking this browser's own subscription state

  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        onClick={subscribed ? handleDisable : handleEnable}
        disabled={isPending}
        className={`rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${
          subscribed ? "bg-emerald-950 text-emerald-400 hover:bg-emerald-900" : "bg-navy-800 text-navy-300 hover:text-white"
        }`}
      >
        {isPending ? "..." : subscribed ? "🔔 Live score notifications on" : "🔕 Enable live score notifications"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
