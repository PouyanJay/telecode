/**
 * A `use:` action that keeps `data-clipped` ("true"/"false") on an overflow-hidden element, reflecting
 * whether its content actually exceeds its box — so CSS can apply an "there's more" treatment (e.g. a
 * bottom fade mask) ONLY when something is really cut off, never washing out short content. Watches
 * both box size (ResizeObserver) and subtree changes (content that mounts or upgrades asynchronously,
 * e.g. markdown code blocks re-rendering highlighted).
 */
export function clipIndicator(node: HTMLElement): { destroy(): void } {
  const update = (): void => {
    node.dataset.clipped = String(node.scrollHeight > node.clientHeight + 1);
  };
  const resize = new ResizeObserver(update);
  resize.observe(node);
  const mutations = new MutationObserver(update);
  mutations.observe(node, { childList: true, subtree: true });
  update();
  return {
    destroy(): void {
      resize.disconnect();
      mutations.disconnect();
    },
  };
}
