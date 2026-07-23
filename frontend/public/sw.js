// Live golf score notifications - a plain static service worker, no
// build step/PWA plugin needed for something this small. Only handles
// the two events push notifications need: showing one when it arrives,
// and focusing/opening the team page when the user taps it.

self.addEventListener("push", (event) => {
  let payload = { title: "Hail Mary Golf", body: "A score changed." };
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
      icon: "/next.svg",
      tag: payload.tag,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = "/golf/team";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes("/golf/team") && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
