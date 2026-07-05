/**
 * The tab attention badge (approval-reliability T7): while N sessions await a decision, the document
 * title reads "(N) …" and the favicon swaps to its amber-dot variant — a backgrounded desktop tab
 * still signals without web push. Pure string logic here (unit-tested); the layout applies it.
 */
const BADGE_PREFIX = /^\(\d+\) /;

/** Apply (or clear) the "(N) " badge on a title. Idempotent — a stale badge never stacks. */
export function withAttentionCount(title: string, count: number): string {
  const base = title.replace(BADGE_PREFIX, '');
  return count > 0 ? `(${String(count)}) ${base}` : base;
}

/** Sync the document title + favicon with the awaiting count. Call from a layout effect. */
export function applyAttentionBadge(doc: Document, count: number): void {
  const badged = withAttentionCount(doc.title, count);
  if (doc.title !== badged) doc.title = badged;
  const icon = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) {
    const href = count > 0 ? '/favicon-attention.svg' : '/favicon.svg';
    if (!icon.href.endsWith(href)) icon.href = href;
  }
}
