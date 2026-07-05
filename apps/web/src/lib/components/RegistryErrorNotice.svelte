<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@telecode/ui';

  /**
   * The registry-outage state (error ≠ empty): shown when the relay couldn't be read, instead of the
   * onboarding/empty screens that would make a healthy account look deleted. Offers a real retry
   * (re-runs the load functions); the live channel keeps reconnecting on its own.
   */
  let retrying = $state(false);

  async function retry(): Promise<void> {
    retrying = true;
    try {
      await invalidateAll();
    } finally {
      retrying = false;
    }
  }
</script>

<div class="outage" role="alert">
  <p class="eyebrow">Relay unreachable</p>
  <p class="sub">
    Your devices and sessions couldn't be loaded — this is a connection problem, not a change to your
    account. Nothing has been unpaired.
  </p>
  <Button variant="secondary" loading={retrying} onclick={() => void retry()}>Retry</Button>
</div>

<style>
  .outage {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    text-align: center;
    padding: var(--space-16) var(--space-4);
  }
  .eyebrow {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--danger);
  }
  .sub {
    margin: 0 0 var(--space-2);
    max-width: 30rem;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: var(--lh-base);
  }
</style>
