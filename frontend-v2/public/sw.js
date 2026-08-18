// Push notifications - a plain static service worker, no build step/PWA
// plugin needed for something this small. Only handles the two events
// push notifications need: showing one when it arrives, and focusing/
// opening the app when the user taps it. Ported from the old frontend's
// golf-only version (2026-08-18) - generalized since notifications now
// also cover odds-swing alerts (scripts/detect_odds_swings.py), not just
// live golf scores, so this no longer hardcodes a golf-specific URL.

self.addEventListener("push", (event) => {
  let payload = { title: "Hail Mary", body: "Something changed." };
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/logo.png",
      tag: payload.tag,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
