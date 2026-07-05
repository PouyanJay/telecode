<script lang="ts">
  /**
   * The house inline spinner: a 12px current-color arc for transient in-flight states ("Approving…").
   * Decorative — pair it with visible status text; it is aria-hidden and stops under reduced motion.
   */
  let { size = 12 }: { size?: number } = $props();
</script>

<span class="spinner" style="--spinner-size: {size}px" aria-hidden="true"></span>

<style>
  .spinner {
    display: inline-block;
    width: var(--spinner-size);
    height: var(--spinner-size);
    flex: none;
    border: 2px solid currentcolor;
    border-right-color: transparent;
    border-radius: var(--radius-full);
    animation: spin 0.6s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
