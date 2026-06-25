/**
 * Decode a base64url-encoded VAPID public key into the `Uint8Array` that `pushManager.subscribe`
 * requires (it rejects the base64url string form). Pads, then maps the url-safe alphabet (`-`/`_`) back
 * to standard base64. Kept in its own SvelteKit-free module so the conversion is unit-testable in Node.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}
