<script lang="ts">
  import { onMount } from 'svelte';

  import { createRelayClient, type RelayClient } from '$lib/relay-client';

  // Phase 0: fixed stub identity + relay URL; both become real in later phases.
  const RELAY_URL = 'ws://127.0.0.1:8080/ws';
  const USER_ID = 'u_dev';
  const DEVICE_ID = 'd_dev';

  let status = $state<'connecting' | 'connected' | 'error'>('connecting');
  let input = $state('ping');
  let reply = $state('');
  let client: RelayClient | null = null;

  onMount(() => {
    client = createRelayClient({ relayUrl: RELAY_URL, userId: USER_ID, deviceId: DEVICE_ID });
    client
      .connect()
      .then(() => {
        status = 'connected';
      })
      .catch(() => {
        status = 'error';
      });
    return () => client?.close();
  });

  async function send() {
    if (client === null) return;
    try {
      reply = await client.echo(input);
    } catch {
      reply = '(echo failed)';
    }
  }
</script>

<main>
  <h1>telecode echo</h1>
  <p>Walking skeleton: browser → relay → daemon → relay → browser.</p>
  <p>Relay status: <strong data-testid="status">{status}</strong></p>

  <label>
    Message
    <input data-testid="echo-input" bind:value={input} />
  </label>
  <button data-testid="echo-send" onclick={send} disabled={status !== 'connected'}>Send</button>

  <p>Echo reply: <strong data-testid="echo-reply">{reply}</strong></p>
</main>
