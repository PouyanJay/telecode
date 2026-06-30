import type { AddressInfo } from 'node:net';

import { createDaemon, createFakeAgentAdapter, type Daemon } from '@telecode/daemon';
import {
  encodeKey,
  generateKeyPair,
  makeEnvelope,
  parseEnvelope,
  type EncryptedEnvelopeFields,
  type Envelope,
  type KeyPair,
} from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import {
  decryptWithContentKey,
  sealEnvelopePayload,
  unwrapContentKey,
} from '../_helpers/browser-crypto';
import { expectSessionStatus } from '../_helpers/db';
import { connectBrowser } from '../_helpers/ws';

/**
 * Phase 3 exit criterion (plan §3.5 + §8): an encrypted session runs end-to-end across the REAL relay — a
 * keypair-bearing daemon and a browser that seals its launch — and the relay only ever forwards ciphertext.
 * Two proofs the daemon-only test (fake relay) can't give: (1) the frames the relay forwards carry no
 * plaintext, exercising the relay's launch rewrite (which must carry `sender_public_key` through) and its
 * cleartext-status routing; (2) the relay's own logs contain neither plaintext nor ciphertext payloads —
 * the "verify via relay logs" criterion, captured here from a real pino stream.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const PROMPT = 'exfiltrate the production secrets';
const AGENT_TEXT = 'planning the change';

describe('full-stack E2E session through the real relay', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
  let handle: DbHandle;
  let admin: Pool;
  let relayUrl: string;
  let daemonKp: KeyPair;
  let userId: string;
  let deviceId: string;
  // Captured relay log lines (real pino → in-memory stream), cleared per test.
  const relayLogs: string[] = [];

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

    // Capture the relay's logs at info level into memory so the test can assert payload-blindness.
    const logger = pino({ level: 'info' }, { write: (line: string) => relayLogs.push(line) });
    app = await buildRelay({ logger, sessionRegistry: createSessionRegistry(handle) });
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
      agentAdapter: createFakeAgentAdapter([{ type: 'message', text: AGENT_TEXT }]),
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
    relayLogs.length = 0;
  });

  /**
   * Drive a full encrypted session as the browser: seal + send the launch, unwrap the delivered content
   * key, decrypt the stream to completion. Returns every frame the relay forwarded + the sealed launch
   * payload (the ciphertext the relay handled), for the caller to assert against.
   */
  async function runEncryptedSession(): Promise<{
    received: Envelope[];
    sessionId: string | undefined;
    sealedLaunch: EncryptedEnvelopeFields;
  }> {
    const browserKp = await generateKeyPair();
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const received: Envelope[] = [];
    browser.on('message', (raw: Buffer) =>
      received.push(parseEnvelope(JSON.parse(raw.toString()))),
    );

    const sealedLaunch = await sealEnvelopePayload(
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
          payload: sealedLaunch.payload,
          nonce: sealedLaunch.nonce,
        }),
      ),
    );

    // Every frame is captured into `received` by the collector above. Poll it for completion rather than
    // registering serial one-shot listeners: a frame can arrive between two awaits and be missed — now more
    // likely because the relay broadcasts `session.ended` before persisting (so it no longer trails the DB
    // write). Once `session.ended` is in, the earlier `session.key`/`agent.message` frames precede it.
    await vi.waitFor(() => expect(received.some((e) => e.type === 'session.ended')).toBe(true), {
      timeout: 5000,
      interval: 25,
    });
    const keyFrame = received.find((e) => e.type === 'session.key');
    if (!keyFrame) throw new Error('expected a session.key frame');
    const contentKey = await unwrapContentKey(keyFrame, daemonKp.publicKey, browserKp.privateKey);
    const messageFrame = received.find((e) => e.type === 'agent.message');
    if (!messageFrame) throw new Error('expected an agent.message frame');
    expect(await decryptWithContentKey(messageFrame, contentKey)).toEqual({ text: AGENT_TEXT });

    browser.close();
    return { received, sessionId: keyFrame.session_id, sealedLaunch };
  }

  it('runs an encrypted session end-to-end; no plaintext crosses the relay; registry marked done', async () => {
    const { received, sessionId } = await runEncryptedSession();

    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // session.ended carried the cleartext status; the relay used it to mark the registry `done`.
    await expectSessionStatus(admin, sessionId, 'done');

    // The decisive property: every frame the relay forwarded to the browser carried a ciphertext payload
    // (a base64 string, non-empty nonce) and no plaintext (prompt or agent output) appears anywhere. That
    // the helper decrypted the stream proves the ciphertext round-tripped intact.
    for (const frame of received) {
      expect(typeof frame.payload).toBe('string');
      expect(frame.nonce).not.toBe('');
    }
    const allFrames = JSON.stringify(received);
    expect(allFrames).not.toContain(PROMPT);
    expect(allFrames).not.toContain(AGENT_TEXT);
  });

  it('the relay logs only routing metadata — never plaintext or ciphertext payloads', async () => {
    const { sealedLaunch } = await runEncryptedSession();

    const logs = relayLogs.join('\n');
    // Sanity: capture works and the relay did log session lifecycle metadata.
    expect(logs).toContain('relay: session');
    // The exit criterion: nothing readable or even encrypted from the payload reaches the relay's logs.
    expect(logs).not.toContain(PROMPT);
    expect(logs).not.toContain(AGENT_TEXT);
    expect(logs).not.toContain(sealedLaunch.payload);
    expect(logs).not.toContain('"payload"');
  });
});
