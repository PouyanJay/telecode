/**
 * A session id is a uuid — validated at the BFF trust boundary before anything is forwarded (the
 * relay re-validates authoritatively). One definition for every /api/sessions route.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: string): boolean {
  return UUID_RE.test(value);
}
