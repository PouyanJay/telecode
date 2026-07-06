<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';

  type Props = HTMLInputAttributes & {
    /** The accessible label. Rendered visibly unless `hideLabel` is set (then it stays for screen readers). */
    label: string;
    /** Two-way bound value. */
    value?: string;
    /** Visually hide the label (still announced) — for compact inline renames where context is obvious. */
    hideLabel?: boolean;
    /** An error message; sets `aria-invalid` and wires `aria-describedby` to the message. */
    error?: string;
    /** Optional helper text shown under the field when there is no error. */
    hint?: string;
    /** Stable id root for label/describedby wiring (a random one is generated when omitted). */
    id?: string;
    /** Two-way bind to the underlying `<input>` element (e.g. to focus it after opening an inline editor). */
    ref?: HTMLInputElement | null;
  };

  let {
    label,
    value = $bindable(''),
    hideLabel = false,
    error,
    hint,
    id,
    ref = $bindable(null),
    ...rest
  }: Props = $props();

  const uid = $props.id();
  const fieldId = $derived(id ?? `input-${uid}`);
  const describedById = $derived(error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined);
</script>

<div class="field">
  <label for={fieldId} class:sr-only={hideLabel}>{label}</label>
  <input
    id={fieldId}
    class="input"
    class:has-error={Boolean(error)}
    bind:value
    bind:this={ref}
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={describedById}
    {...rest}
  />
  {#if error}
    <p id="{fieldId}-error" class="msg error" role="alert">{error}</p>
  {:else if hint}
    <p id="{fieldId}-hint" class="msg hint">{hint}</p>
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  label {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-secondary);
  }
  .input {
    height: 32px;
    padding: 0 var(--space-3);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    transition:
      border-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease);
  }
  .input::placeholder {
    color: var(--text-muted);
  }
  .input:hover:not(:disabled) {
    border-color: var(--text-muted);
  }
  .input:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-ring);
  }
  .input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .input.has-error {
    border-color: var(--danger);
  }
  .input.has-error:focus-visible {
    box-shadow: 0 0 0 3px var(--danger-soft);
  }
  .msg {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    margin: 0;
  }
  .msg.error {
    color: var(--danger);
  }
  .msg.hint {
    color: var(--text-muted);
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
  @media (prefers-reduced-motion: reduce) {
    .input {
      transition: none;
    }
  }
</style>
