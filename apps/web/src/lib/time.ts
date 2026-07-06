/**
 * Compact relative timestamps for the session list and device rows ('just now', '5 min ago',
 * '2 hr ago', '3 d ago'). Pure (the clock is an injectable `now`) so it unit-tests directly and the
 * Svelte views stay thin renderers. A single source of truth keeps every surface phrasing identical.
 */
export function relativeTime(date: Date, now: number = Date.now()): string {
  const mins = Math.round((now - date.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}
