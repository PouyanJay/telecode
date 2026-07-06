import type { SessionMetaPayload, TitleSourceName } from '@telecode/protocol';

/**
 * A session title derived from its first prompt (ux Phase 6): the first non-empty line, whitespace
 * collapsed, truncated to a bounded single line so the dashboard row stays scannable. `undefined` for a
 * blank prompt (the caller then simply omits the title — never an empty string, which the wire schema
 * rejects). The title is prompt-derived CONTENT: it must only ever travel sealed and never be logged.
 */
const MAX_TITLE_LENGTH = 80;

export function deriveSessionTitle(prompt: string): string | undefined {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line !== '');
  if (firstLine === undefined) return undefined;
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
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
