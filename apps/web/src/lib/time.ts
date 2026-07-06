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

/** A calendar-day key in the display timezone, for the "is this today?" split. */
function dayKey(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'short',
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).format(date);
}

/**
 * An absolute wall-clock time for the segment crumb and lineage strip (ux Phase 3): "2:14 PM" while the
 * instant is today (in the viewer's timezone), "Jun 27 · 2:14 PM" once it isn't — a crumb must never
 * read "2:14 PM" about yesterday. `timeZone` is injectable for deterministic tests; the UI omits it
 * (viewer-local). Newer ICU emits a narrow no-break space before AM/PM — normalized to a plain space so
 * every runtime renders identically.
 */
export function clockTime(date: Date, now: number = Date.now(), timeZone?: string): string {
  const tz = timeZone !== undefined ? { timeZone } : {};
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', ...tz })
    .format(date)
    .replace(/\u202f/g, ' ');
  if (dayKey(date, timeZone) === dayKey(new Date(now), timeZone)) return time;
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...tz }).format(
    date,
  );
  return `${day} · ${time}`;
}
