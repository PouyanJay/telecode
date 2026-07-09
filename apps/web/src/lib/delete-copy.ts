/**
 * The one consequence sentence for permanently deleting a session — shared by every surface that
 * offers the delete (session view, archived view, board card) so the wording can never drift
 * between them. Options tune the honest specifics: a `title` leads with the session's own name
 * (the archived view's framing), a `deviceName` names whose files stay untouched, and
 * `hasSegments` warns that a chained thread only loses its latest segment.
 */
export function sessionDeleteBody(
  options: { title?: string; deviceName?: string; hasSegments?: boolean } = {},
): string {
  const lead =
    options.title !== undefined
      ? `“${options.title}”, its encrypted history, and its titles will be permanently removed from your dashboard`
      : 'This permanently removes the session, its encrypted history, and its titles from your dashboard';
  const where = options.deviceName !== undefined ? ` on ${options.deviceName}` : ' on your machine';
  const segments = options.hasSegments
    ? ' This thread has earlier segments — only this (latest) segment is deleted.'
    : '';
  return `${lead} — on every device and browser. Files and code${where} are not touched.${segments}`;
}
