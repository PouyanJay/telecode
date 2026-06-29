<script lang="ts">
  import { page } from '$app/stores';

  import { isActive } from '$lib/nav';

  /**
   * The phone navigation (enterprise-ui §2 — the PWA is the mobile story): a bottom tab bar with a center
   * launch FAB, shown only below the sidebar breakpoint. Real `<a href>` tabs mirror the sidebar's routes;
   * the FAB opens the same launch drawer. Targets are ≥44px and the bar clears the home indicator via the
   * bottom safe-area inset.
   */
  let { onlaunch }: { onlaunch: () => void } = $props();

  const path = $derived($page.url.pathname);
</script>

<nav class="mobilenav" aria-label="Primary">
  <a class="mtab" href="/" aria-current={isActive(path, '/') ? 'page' : undefined}>
    <svg class="mi" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M2 4h11M2 7.5h11M2 11h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
    <span>Sessions</span>
  </a>
  <a class="mtab" href="/devices" aria-current={isActive(path, '/devices') ? 'page' : undefined}>
    <svg class="mi" viewBox="0 0 15 15" fill="none" aria-hidden="true"><rect x="1.6" y="2.6" width="11.8" height="8" rx="1.3" stroke="currentColor" stroke-width="1.3" /><path d="M5.2 13h4.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
    <span>Devices</span>
  </a>

  <button class="fab" type="button" onclick={onlaunch} aria-label="Launch session">
    <svg width="22" height="22" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
  </button>

  <a class="mtab" href="/activate" aria-current={isActive(path, '/activate') ? 'page' : undefined}>
    <svg class="mi" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M7.5 1.6l5 2.2v3.2c0 3-2.1 5-5 5.9-2.9-.9-5-2.9-5-5.9V3.8l5-2.2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>
    <span>Pair</span>
  </a>
  <a class="mtab" href="/settings" aria-current={isActive(path, '/settings') ? 'page' : undefined}>
    <svg class="mi" viewBox="0 0 15 15" fill="none" aria-hidden="true"><circle cx="7.5" cy="7.5" r="2.1" stroke="currentColor" stroke-width="1.3" /><path d="M7.5 1.4v2M7.5 11.6v2M13.6 7.5h-2M3.4 7.5h-2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
    <span>Settings</span>
  </a>
</nav>

<style>
  .mobilenav {
    display: none;
  }

  @media (max-width: 640px) {
    .mobilenav {
      grid-row: 3;
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-around;
      gap: var(--space-1);
      padding: var(--space-2) var(--space-2) calc(var(--space-2) + env(safe-area-inset-bottom));
      border-top: 1px solid var(--border);
      background: var(--surface);
    }
  }

  .mtab {
    flex: 1;
    max-width: 5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: var(--space-1);
    min-height: 44px;
    justify-content: center;
    color: var(--text-muted);
    text-decoration: none;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.02em;
  }
  .mtab[aria-current='page'] {
    color: var(--accent);
  }
  .mtab:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
    border-radius: var(--radius-sm);
  }
  .mi {
    width: 20px;
    height: 20px;
  }

  .fab {
    flex: none;
    width: 48px;
    height: 48px;
    margin-top: -20px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: var(--radius-xl);
    background: var(--accent);
    color: var(--text-on-accent);
    box-shadow: var(--shadow-md);
    cursor: pointer;
  }
  .fab:active {
    background: var(--accent-press);
  }
  .fab:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
</style>
