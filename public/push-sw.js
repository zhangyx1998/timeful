/**
 * The push service worker — and deliberately nothing else.
 *
 * It exists so the browser has somewhere to deliver a push message when no
 * Timeful page is open, and that is the whole of its job. There is no fetch
 * handler and no cache: every page in this app is server-rendered, and a
 * service worker replaying stale HTML for capability URLs would be a bug
 * factory with no offline story to show for it. Plain JavaScript, because it
 * is served as a file straight from public/ and never enters a bundle.
 *
 * The payload is end-to-end encrypted to this browser (RFC 8291); by the time
 * `event.data` is readable here it has already been decrypted by the platform.
 * Shape: `{ title, body, url }`, produced by server/push/deliver.ts.
 */

self.addEventListener("install", function () {
  // A new version of this file should take over on next delivery, not wait
  // for every tab to close.
  self.skipWaiting();
});

self.addEventListener("push", function (event) {
  var payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch (error) {
    payload = null;
  }
  if (!payload || typeof payload.title !== "string") return;
  var url = typeof payload.url === "string" ? payload.url : "/";
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: typeof payload.body === "string" ? payload.body : "",
      icon: "/icons/icon-192.png",
      // One notification per event, newest text wins: a stack of "responses
      // changed" cards for the same event says nothing three times.
      tag: "timeful:" + url,
      data: { url: url },
    }),
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url =
    event.notification.data && typeof event.notification.data.url === "string"
      ? event.notification.data.url
      : "/";
  var target = new URL(url, self.location.origin).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (windows) {
        for (var i = 0; i < windows.length; i++) {
          // Focus a tab already on this event rather than opening a second.
          if (windows[i].url === target && "focus" in windows[i]) {
            return windows[i].focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});
