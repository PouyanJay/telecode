/**
 * How long an ask has been waiting, for an inbox card's timer pill. Null when the ask predates this
 * page (no client receive-time — claiming a duration would be a lie until the wire carries
 * timestamps, Phase 3 of the UX plan).
 */
export function waitingLabel(askedAt: number | undefined, now: number): string | null {
  if (askedAt === undefined) return null;
  const minutes = Math.floor(Math.max(0, now - askedAt) / 60_000);
  if (minutes < 1) return 'waiting <1 min';
  if (minutes < 60) return `waiting ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `waiting ${String(hours)} hr`
    : `waiting ${String(hours)} hr ${String(rest)} min`;
}
