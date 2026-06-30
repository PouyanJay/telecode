/**
 * Operator authorization for instance-wide controls (e.g. the infrastructure scale toggles). These actions
 * affect the shared deployment for ALL users, so they are gated to an explicit allowlist of operator emails
 * (`TELECODE_OPERATOR_EMAILS`, comma-separated) — never to any signed-in user. The relay is the single
 * authority: it derives the email from the validated session and checks it here. An empty/unset allowlist
 * means "no operators" (the feature stays closed), so a misconfiguration fails safe.
 *
 * Matching is case-insensitive and trims surrounding whitespace (emails are case-insensitive in practice and
 * the env list is hand-edited).
 */
export function isOperator(
  email: string | null | undefined,
  operatorEmails: readonly string[],
): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (normalized === '') return false;
  return operatorEmails.some((candidate) => candidate.trim().toLowerCase() === normalized);
}
