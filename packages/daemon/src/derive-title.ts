import type { TitleSourceName } from '@telecode/protocol';

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
