import { dev } from '$app/environment';
import type { Cookies } from '@sveltejs/kit';

/**
 * First-party session cookie helpers. The cookie is httpOnly + SameSite=Lax + same-origin (and Secure
 * outside dev), so it is never readable by JS and never sent cross-origin to the relay — the browser
 * presents a short-lived channel token to the relay instead (AD-1).
 */
const COOKIE_NAME = 'telecode_session';

export function setSessionCookie(cookies: Cookies, token: string, expiresAt: Date): void {
  cookies.set(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !dev,
    expires: expiresAt,
  });
}

export function getSessionToken(cookies: Cookies): string | undefined {
  return cookies.get(COOKIE_NAME);
}

export function clearSessionCookie(cookies: Cookies): void {
  cookies.delete(COOKIE_NAME, { path: '/' });
}
