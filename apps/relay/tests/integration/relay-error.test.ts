import type { AddressInfo } from 'node:net';

import { makeEnvelope, relayErrorPayloadSchema, type Envelope } from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';
import { connectBrowser, connectDaemon, waitForEnvelope } from '../_helpers/ws';

/**
 * No silent drops (approval-reliability T3). A browser frame sent while the daemon is offline used to
 * vanish with only a relay-side log line — an approval clicked on a phone went nowhere while the gate
 * kept spinning. The relay now answers the SENDING browser with `relay.error` (`device_offline`,
 * `regarding` = the failed type) so the UI can un-spin exactly that action. Relay-generated cleartext
 * routing metadata — no session payload. Registry-less relay (routing behavior only).
 */
describe('relay: relay.error for frames sent while the daemon is offline', () => {
  let app: FastifyInstance;
  let relayUrl: string;
  const userId = 'user-relay-error';

  beforeAll(async () => {
    app = await buildRelay({ logger: pino({ level: 'silent' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
  });

  const relayError = (sessionId: string) => (e: Envelope) =>
    e.type === 'relay.error' && e.session_id === sessionId;

  it.each([
    ['permission.decision', { requestId: 'r1', behavior: 'deny' }],
    ['question.answer', { requestId: 'r2', answers: [] }],
    ['handover.answer', { requestId: 'r3', answerText: 'go on' }],
    ['user.message', { text: 'continue' }],
    ['session.control', { action: 'interrupt' }],
    ['session.branch.switch', { branch: 'feat/other' }],
    ['session.push', {}],
  ] as const)('answers a %s to an offline daemon with device_offline', async (type, payload) => {
    const deviceId = `device-offline-${type}`;
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = `sess-${type}`;

    const errorFrame = waitForEnvelope(browser, relayError(sessionId));
    browser.send(JSON.stringify(makeEnvelope({ type, userId, deviceId, sessionId, payload })));
    const envelope = await errorFrame;
    const parsed = relayErrorPayloadSchema.parse(envelope.payload);
    expect(parsed).toEqual({ code: 'device_offline', regarding: type });
    browser.close();
  });

  it('answers a workspace.reap to an offline daemon with device_offline (Phase C T3)', async () => {
    // Box-sealed device-scoped payload, but the envelope carries the target session id as routing
    // metadata precisely so this honesty path can name the action that went nowhere.
    const deviceId = 'device-offline-workspace.reap';
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = 'sess-reap-offline';

    const errorFrame = waitForEnvelope(browser, relayError(sessionId));
    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'workspace.reap',
          userId,
          deviceId,
          sessionId,
          payload: 'OPAQUE_CIPHERTEXT',
          nonce: 'nonce',
        }),
      ),
    );
    const parsed = relayErrorPayloadSchema.parse((await errorFrame).payload);
    expect(parsed).toEqual({ code: 'device_offline', regarding: 'workspace.reap' });
    browser.close();
  });

  it('sends no relay.error when the daemon is online (the frame is forwarded instead)', async () => {
    const deviceId = 'device-online-forward';
    const daemon = await connectDaemon(relayUrl, userId, deviceId);
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = 'sess-forwarded';

    const frames: Envelope[] = [];
    browser.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Envelope);
    });
    const delivered = waitForEnvelope(
      daemon,
      (e) => e.type === 'user.message' && e.session_id === sessionId,
    );
    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'user.message',
          userId,
          deviceId,
          sessionId,
          payload: { text: 'hello' },
        }),
      ),
    );
    // The daemon receiving the frame is the barrier: the relay finished routing this frame.
    await delivered;
    expect(frames.some((f) => f.type === 'relay.error')).toBe(false);
    browser.close();
    daemon.close();
  });

  it('sends no relay.error for a session-less frame (device-scoped types stay fire-and-forget)', async () => {
    const deviceId = 'device-offline-sessionless';
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const frames: Envelope[] = [];
    browser.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Envelope);
    });
    browser.send(
      JSON.stringify(makeEnvelope({ type: 'adopt.config', userId, deviceId, payload: {} })),
    );
    // Barrier: a session-scoped control gets its error reply AFTER the adopt.config was processed
    // (same-socket FIFO), proving no error was emitted for the session-less frame.
    const errorReply = waitForEnvelope(browser, relayError('sess-barrier'));
    browser.send(
      JSON.stringify(
        makeEnvelope({
          type: 'session.control',
          userId,
          deviceId,
          sessionId: 'sess-barrier',
          payload: { action: 'interrupt' },
        }),
      ),
    );
    await errorReply;
    const errorFrames = frames.filter((f) => f.type === 'relay.error');
    expect(errorFrames).toHaveLength(1);
    expect(errorFrames[0]!.session_id).toBe('sess-barrier');
    browser.close();
  });

  it('a subscribe to an offline daemon still gets the error alongside any cache replay', async () => {
    const deviceId = 'device-offline-subscribe';
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const sessionId = 'sess-subscribe-offline';

    const errorFrame = waitForEnvelope(browser, relayError(sessionId));
    browser.send(
      JSON.stringify(
        makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId, payload: {} }),
      ),
    );
    const parsed = relayErrorPayloadSchema.parse((await errorFrame).payload);
    expect(parsed).toEqual({ code: 'device_offline', regarding: 'session.subscribe' });
    browser.close();
  });
});
