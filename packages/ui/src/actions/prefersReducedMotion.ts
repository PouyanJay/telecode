/**
 * Whether the viewer asked for reduced motion, evaluated once at call time. Svelte's `fly`/`fade`/
 * `scale` take a static config object, so overlay primitives read this when building their transition
 * config rather than reacting to a live MediaQueryList. SSR-safe (returns false without `window`).
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}
