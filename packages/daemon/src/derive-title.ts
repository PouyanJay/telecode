import type { SessionMetaPayload, TitleSourceName } from '@telecode/protocol';

/**
 * A session title derived from its first prompt (ux Phase 6): ONE friendly phrase reading across the
 * whole prompt — all whitespace (newlines included) collapsed, capped at 10 words so the dashboard
 * row stays scannable, with a character bound behind it for pathological word lengths. An ellipsis
 * marks any truncation. `undefined` for a blank prompt (the caller then simply omits the title —
 * never an empty string, which the wire schema rejects). The title is prompt-derived CONTENT: it
 * must only ever travel sealed and never be logged.
 */
const MAX_TITLE_LENGTH = 80;
const MAX_TITLE_WORDS = 10;

export function deriveSessionTitle(prompt: string): string | undefined {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  const words = collapsed.split(' ');
  const phrase = words.slice(0, MAX_TITLE_WORDS).join(' ');
  // Build the ellipsis-inclusive candidate FIRST so the character cap bounds the final string — a
  // word-capped phrase sitting at the limit must not overshoot by its own ellipsis.
  const candidate = words.length > MAX_TITLE_WORDS ? `${phrase}…` : phrase;
  if (candidate.length <= MAX_TITLE_LENGTH) return candidate;
  return `${phrase.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * The launch's titled identity: a user-typed title wins verbatim (`user`); otherwise one is derived
 * from the prompt (`derived`); a whitespace-only prompt yields none at all (tightly-coupled sibling
 * of {@link deriveSessionTitle} — the precedence and the derivation change together).
 */
export function resolveLaunchTitle(
  userTitle: string | undefined,
  prompt: string,
): { title: string; titleSource: TitleSourceName } | undefined {
  if (userTitle !== undefined) return { title: userTitle, titleSource: 'user' };
  const derived = deriveSessionTitle(prompt);
  return derived !== undefined ? { title: derived, titleSource: 'derived' } : undefined;
}

/**
 * A sealed-meta patch for a session whose title is DERIVED (adopted/chained, ux Phase 6 T5): carry the
 * title (marked `derived`) and cwd only when present, so a single shape backs every derived-title emit
 * site. `title`/`cwd` are the fields a `session.meta` frame seals. An EMPTY title is dropped, not sent —
 * `basename('/')`/`basename('')` is `''`, which the wire schema (`title.min(1)`) rejects; an adopted
 * session at a root/blank cwd simply gets no title until its first prompt refines one.
 */
export function derivedMetaPatch(
  title: string | undefined,
  cwd: string | undefined,
): Pick<SessionMetaPayload, 'title' | 'titleSource' | 'cwd'> {
  return {
    ...(title !== undefined && title !== '' ? { title, titleSource: 'derived' as const } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}
