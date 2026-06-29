<script lang="ts">
  import type { PermissionModeName } from '@telecode/protocol';

  import { PERMISSION_MODES } from '$lib/settings';

  /**
   * The permission-mode segmented control, shared by the launch drawer and Settings (enterprise-ui §4 —
   * extract before you duplicate). Real radio inputs back the segments, so keyboard arrow-selection and
   * focus come for free; the selected mode's hint sits below. `value` is bindable; `onselect` fires on a
   * change so a consumer can persist it.
   */
  let {
    value = $bindable(),
    onselect,
    name = 'permission-mode',
  }: {
    value: PermissionModeName;
    onselect?: (value: PermissionModeName) => void;
    name?: string;
  } = $props();

  function select(next: PermissionModeName): void {
    value = next;
    onselect?.(next);
  }

  const hint = $derived(PERMISSION_MODES.find((mode) => mode.value === value)?.hint ?? '');
</script>

<fieldset class="field">
  <legend class="label">Permission mode</legend>
  <div class="seg">
    {#each PERMISSION_MODES as option (option.value)}
      <label class="opt" class:on={value === option.value}>
        <input
          class="sr-only"
          type="radio"
          {name}
          value={option.value}
          checked={value === option.value}
          onchange={() => select(option.value)}
        />
        {option.label}
      </label>
    {/each}
  </div>
  <p class="hint">{hint}</p>
</fieldset>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border: none;
    padding: 0;
    margin: 0;
  }
  .label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .seg {
    display: flex;
    gap: var(--space-1);
  }
  .opt {
    flex: 1;
    padding: var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    text-align: center;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .opt:hover {
    background: var(--bg-muted);
  }
  .opt.on {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent);
  }
  /* The radio still drives focus + keyboard; the ring rides the visible segment. */
  .opt:has(:focus-visible) {
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .hint {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: var(--lh-sm);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
