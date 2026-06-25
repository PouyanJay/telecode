import type { AddressInfo } from 'node:net';

import {
  generateKeyPair,
  makeEnvelope,
  openEnvelopePayload,
  sealEnvelopePayload,
  type KeyPair,
} from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * Phase 3 walking skeleton (plan §3.5 + architecture invariant #5): a payload sealed in the browser
 * round-trips through a REAL relay to the daemon and back, and the relay only ever observes ciphertext.
 * This proves the crypto seam (`@telecode/protocol` seal/open-envelope helpers) + the single wire
 * envelope + the relay's opaque forward are wired end-to-end, BEFORE any session-level encryption
 * behavior is added. No DB/auth needed — the echo path exercises pure routing.
 */
describe('E2E walking skeleton: the relay forwards only ciphertext', () => {
  let app: FastifyInstance;
  let relayUrl: string;
  let browserKp: KeyPair;
  let daemonKp: KeyPair;
  const userId = '11111111-1111-1111-1111-111111111111';
  const deviceId = '22222222-2222-2222-2222-222222222222';

  beforeAll(async () => {
    browserKp = await generateKeyPair();
    daemonKp = await generateKeyPair();
    app = await buildRelay({ logger: pino({ level: 'silent' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('seals both directions; no plaintext crosses the relay; both ends decrypt', async () => {
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);

    // A distinctive plaintext that must never appear in any frame the relay handles.
    const PROMPT = 'rm -rf / --no-preserve-root';
    const sealed = await sealEnvelopePayload(
      { text: PROMPT },
      daemonKp.publicKey,
      browserKp.privateKey,
    );

    const onDaemon = waitForEnvelope(daemon, (e) => e.type === 'echo');
    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'echo',
          userId,
          deviceId,
          payload: sealed.payload,
          nonce: sealed.nonce,
        }),
      ),
    );
    const daemonFrame = await onDaemon;

    // The relay forwards frames verbatim, so what the daemon received is exactly what the relay observed.
    expect(JSON.stringify(daemonFrame)).not.toContain(PROMPT);
    expect(typeof daemonFrame.payload).toBe('string');
    expect(daemonFrame.nonce).toBe(sealed.nonce);
    const openedPrompt = await openEnvelopePayload(
      daemonFrame,
      browserKp.publicKey,
      daemonKp.privateKey,
    );
    expect(openedPrompt).toEqual({ text: PROMPT });

    // Reverse direction: daemon → browser.
    const REPLY = 'secret-agent-output-42';
    const sealedReply = await sealEnvelopePayload(
      { text: REPLY },
      browserKp.publicKey,
      daemonKp.privateKey,
    );
    const onBrowser = waitForEnvelope(browser, (e) => e.type === 'echo.reply');
    daemon.send(
      JSON.stringify(
        makeEnvelope({
          type: 'echo.reply',
          userId,
          deviceId,
          payload: sealedReply.payload,
          nonce: sealedReply.nonce,
        }),
      ),
    );
    const browserFrame = await onBrowser;

    expect(JSON.stringify(browserFrame)).not.toContain(REPLY);
    const openedReply = await openEnvelopePayload(
      browserFrame,
      daemonKp.publicKey,
      browserKp.privateKey,
    );
    expect(openedReply).toEqual({ text: REPLY });

    daemon.close();
    browser.close();
  });
});
