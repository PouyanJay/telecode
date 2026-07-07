/**
 * The auto name for a session's worktree branch (branch-launch Phase B): a readable slug of the
 * first prompt plus the session's short id — `telecode/fix-the-pairing-race-8f2a0c1e` beats the
 * bare-uuid label when the user later reads `git branch`. The slug alphabet (lowercase alphanumerics
 * joined by single dashes) is always a valid git ref segment, so no further ref validation is
 * needed; a prompt with no usable characters degrades to the plain short-id form.
 */
const MAX_SLUG_CHARS = 24;
const SHORT_ID_CHARS = 8;

export function deriveBranchName(prompt: string, sessionId: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, '');
  const shortId = sessionId.slice(0, SHORT_ID_CHARS);
  return slug === '' ? `telecode/${shortId}` : `telecode/${slug}-${shortId}`;
}
