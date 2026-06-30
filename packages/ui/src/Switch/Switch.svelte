<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';

  /**
   * An accessible on/off switch (ARIA `role="switch"`), styled from tokens — amber track when on. Used for
   * binary instance settings. A `label` is REQUIRED (the control carries no visible text) and becomes the
   * `aria-label`. `loading` shows an in-flight state and blocks input while a change round-trips. The
   * control is presentational — the parent wires the state + the action (e.g. `type="submit"` inside a
   * form, for progressive enhancement); it owns no business logic.
   */
  type Props = Omit<HTMLButtonAttributes, 'aria-label' | 'aria-checked' | 'role'> & {
    label: string;
    checked: boolean;
    loading?: boolean;
  };

  let { label, checked, loading = false, type = 'button', disabled, ...rest }: Props = $props();
</script>

<button
  class="switch"
  class:on={checked}
  class:loading
  role="switch"
  aria-checked={checked}
  aria-label={label}
  title={label}
  {type}
  disabled={disabled || loading}
  {...rest}
>
  <span class="track"><span class="thumb"></span></span>
</button>

<style>
  .switch {
    display: inline-flex;
    align-items: center;
    flex: none;
    /* Visual track is 40×24, but pad the button so the tap target clears the touch minimum without shifting
       the row (the track stays centered). */
    padding: var(--space-2);
    margin: calc(var(--space-2) * -1);
    border: none;
    background: none;
    cursor: pointer;
    border-radius: var(--radius-full);
  }
  .track {
    position: relative;
    display: block;
    width: 40px;
    height: 24px;
    border-radius: var(--radius-full);
    background: var(--bg-muted);
    border: 1px solid var(--border-strong);
    transition:
      background-color var(--dur) var(--ease),
      border-color var(--dur) var(--ease);
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: var(--radius-full);
    background: var(--text-secondary);
    box-shadow: var(--shadow-xs);
    transition:
      transform var(--dur) var(--ease),
      background-color var(--dur) var(--ease);
  }
  .switch.on .track {
    background: var(--accent);
    border-color: var(--accent);
  }
  .switch.on .thumb {
    transform: translateX(18px);
    background: var(--text-on-accent);
  }
  .switch:focus-visible {
    outline: none;
  }
  .switch:focus-visible .track {
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  .switch:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .switch.loading {
    cursor: progress;
  }

  @media (prefers-reduced-motion: reduce) {
    .track,
    .thumb {
      transition: none;
    }
  }
</style>
