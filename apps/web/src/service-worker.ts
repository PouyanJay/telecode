/// <reference lib="webworker" />

/**
 * Telecode's push service worker. The relay sends a notification (routing metadata only — a session id +
 * deep-link) when a session needs input; this displays it and, on click, focuses an existing tab on the
 * session (or opens one). SvelteKit builds this from `src/service-worker.ts`; the app registers it from
 * `$lib/push`.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

interface PushPayload {
  title?: string;
  body?: string;
  data?: { sessionId?: string; url?: string };
}

sw.addEventListener('push', (event) => {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    payload = {};
  }
  event.waitUntil(
    sw.registration.showNotification(payload.title ?? 'telecode', {
      body: payload.body ?? '',
      data: payload.data ?? {},
      // Collapse repeated pings for the same session into one notification.
      tag: payload.data?.sessionId,
    }),
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  const url = data?.url ?? '/';
  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Reuse an open tab if there is one (deep-link it to the session); otherwise open a new window.
      for (const client of clients) {
        const windowClient = client as WindowClient;
        void windowClient.navigate(url);
        return windowClient.focus();
      }
      return sw.clients.openWindow(url);
    }),
  );
});
