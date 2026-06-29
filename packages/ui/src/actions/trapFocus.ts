/**
 * Confine keyboard focus to a node while it's mounted (modal/drawer requirement, enterprise-ui §3/§4):
 * Tab/Shift+Tab cycle within the node, focus moves to the first focusable element on mount, and the
 * previously-focused element is restored on destroy. Pair with `{#if open}` so the action lives exactly
 * as long as the overlay; Escape-to-close and backdrop dismissal are handled by the consumer.
 */
export function trapFocus(node: HTMLElement) {
  const previous = document.activeElement as HTMLElement | null;
  const selector =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
    'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function focusable(): HTMLElement[] {
    return Array.from(node.querySelectorAll<HTMLElement>(selector)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  node.addEventListener('keydown', onKeydown);
  (focusable()[0] ?? node).focus();

  return {
    destroy(): void {
      node.removeEventListener('keydown', onKeydown);
      previous?.focus();
    },
  };
}
