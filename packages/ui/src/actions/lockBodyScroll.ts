/**
 * Lock `document.body` scroll while an overlay is open, restoring the prior value on teardown. Call
 * inside a Svelte `$effect` (gated on the open flag) so the overlay's backdrop doesn't let the page
 * behind it scroll. Returns the restore function; SSR-safe (no-op without `document`).
 */
export function lockBodyScroll(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const previous = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => {
    document.body.style.overflow = previous;
  };
}
