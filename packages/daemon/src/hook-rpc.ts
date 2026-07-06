import { createConnection } from 'node:net';

/**
 * Test harness: call the daemon's local hook socket the way `telecode hook` does — one JSON event in,
 * one JSON decision out. Shared by the adopted-session/handover/timestamps suites (a fake `claude` side
 * of the hooks bridge, like `fake-relay` is the fake relay side).
 */
export function hookRpc(socketPath: string, event: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let out = '';
    client.on('connect', () => client.end(JSON.stringify(event)));
    client.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    client.on('end', () => {
      // A force-closed connection (daemon stop while the gate blocks) leaves `out` empty — reject rather
      // than let JSON.parse throw uncaught inside this event callback.
      try {
        resolve(JSON.parse(out));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('hook response parse failed'));
      }
    });
    client.on('error', reject);
  });
}
