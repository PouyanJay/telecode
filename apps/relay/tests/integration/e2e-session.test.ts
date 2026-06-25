import type { AddressInfo } from 'node:net';

import { createDaemon, createFakeAgentAdapter, type Daemon } from '@telecode/daemon';
import {
  decryptWithContentKey,
  encodeKey,
  generateKeyPair,
  makeEnvelope,
  parseEnvelope,
  sealEnvelopePayload,
  unwrapContentKey,
  type Envelope,
  type KeyPair,
} from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser, waitForEnvelope } from '../_helpers/ws';

/**
 * Phase 3 exit criterion (plan §3.5): an encrypted session runs end-to-end across the REAL relay — a
 * keypair-bearing daemon and a browser that seals its launch — and the relay only ever forwards
 * ciphertext. This is the full-stack proof the daemon-only test (fake relay) can't give: it exercises the
 * relay's launch rewrite (which must carry `sender_public_key` through) and its cleartext-status routing.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('full-stack E2E session through the real relay', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
  let handle: DbHandle;
  let admin: Pool;
  let relayUrl: string;
  let daemonKp: KeyPair;
  let userId: string;
  let deviceId: string;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });

    await admin.query('truncate table users restart identity cascade');
    const u = await admin.query<{ id: string }>(
      "insert into users (provider, provider_user_id) values ('dev', 'e2e-session') returning id",
    );
    userId = u.rows[0]!.id;
    const d = await admin.query<{ id: string }>(
      "insert into devices (user_id, name, device_token_hash) values ($1, 'lap', 'h') returning id",
      [userId],
    );
    deviceId = d.rows[0]!.id;

    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      sessionRegistry: createSessionRegistry(handle),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;

    daemonKp = await generateKeyPair();
    daemon = createDaemon({
      relayUrl,
      userId,
      deviceId,
      keyPair: {
        publicKey: encodeKey(daemonKp.publicKey),
        privateKey: encodeKey(daemonKp.privateKey),
      },
      agentAdapter: createFakeAgentAdapter([{ type: 'message', text: 'planning the change' }]),
      logger: pino({ level: 'silent' }),
    });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon?.stop();
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('truncate table sessions');
  });

  it('runs an encrypted session end-to-end; the relay never forwards plaintext', async () => {
    const browserKp = await generateKeyPair();
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const received: Envelope[] = [];
    browser.on('message', (raw: Buffer) =>
      received.push(parseEnvelope(JSON.parse(raw.toString()))),
    );

    // The browser seals the launch to the daemon and announces its ephemeral pubkey. Distinctive
    // plaintext (with spaces) that must never appear verbatim in any forwarded frame.
    const PROMPT = 'exfiltrate the production secrets';
    const sealed = await sealEnvelopePayload(
      { prompt: PROMPT },
      daemonKp.publicKey,
      browserKp.privateKey,
    );
    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.launch',
          userId,
          deviceId,
          senderPublicKey: encodeKey(browserKp.publicKey),
          payload: sealed.payload,
          nonce: sealed.nonce,
        }),
      ),
    );

    // The daemon decrypted the launch, minted + delivered the content key (box-wrapped to the browser).
    const keyFrame = await waitForEnvelope(browser, (e) => e.type === 'session.key');
    const sessionId = keyFrame.session_id;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);

    // The streamed frame is ciphertext; the browser decrypts it to the agent's message.
    const messageFrame = await waitForEnvelope(browser, (e) => e.type === 'agent.message');
    expect(typeof messageFrame.payload).toBe('string');
    expect(await decryptWithContentKey(messageFrame, contentKey)).toEqual({
      text: 'planning the change',
    });

    // session.ended carries the cleartext status; the relay used it to mark the registry `done`.
    const endedFrame = await waitForEnvelope(browser, (e) => e.type === 'session.ended');
    expect(endedFrame.status).toBe('done');
    const row = await admin.query<{ status: string }>('select status from sessions where id = $1', [
      sessionId,
    ]);
    expect(row.rows[0]?.status).toBe('done');

    // The decisive property: no plaintext (prompt or agent output) crossed the relay in any frame.
    const allFrames = JSON.stringify(received);
    expect(allFrames).not.toContain(PROMPT);
    expect(allFrames).not.toContain('planning the change');

    browser.close();
  });
});
