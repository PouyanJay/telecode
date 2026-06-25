import { browser, dev } from '$app/environment';

import { urlBase64ToUint8Array } from './push-key';

/**
 * Browser-side web-push enablement: register the service worker, request notification permission,
 * subscribe with the relay's VAPID public key, and hand the subscription to the relay (via the BFF
 * endpoint) so it can notify the user when a session needs input. The actual notification + deep-link is
 * handled by `src/service-worker.ts`. Push delivery can't be exercised in CI (no push service), so this
 * is verified manually; the pure {@link urlBase64ToUint8Array} conversion is unit-tested (`push-key`).
 */

/** Whether this browser can do web push at all (PWA capabilities present). */
export function pushSupported(): boolean {
  return (
    browser && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  );
}

/** Current permission, plus `unsupported` when the browser can't do push. */
export type PushState = 'unsupported' | 'default' | 'granted' | 'denied';

export function pushPermission(): PushState {
  return pushSupported() ? Notification.permission : 'unsupported';
}

/**
 * Enable push: prompt for permission, subscribe with the VAPID key, and register the subscription with
 * the relay. Returns the resulting permission state (`granted` on success). Idempotent — re-subscribing
 * an existing registration returns the same subscription, which the relay upserts.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushState> {
  if (!pushSupported() || !vapidPublicKey) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;

  const registration = await navigator.serviceWorker.register('/service-worker.js', {
    type: dev ? 'module' : 'classic',
  });
  await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const res = await fetch('/api/push-subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subscription.toJSON()),
  });
  return res.ok ? 'granted' : 'default';
}
