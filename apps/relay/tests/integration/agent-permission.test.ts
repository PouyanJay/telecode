import type { AddressInfo } from 'node:net';

import { createDaemon, createFakeAgentAdapter, type Daemon } from '@telecode/daemon';
import {
  agentPermissionRequestPayloadSchema,
  agentToolUsePayloadSchema,
  makeEnvelope,
  parseEnvelope,
  type Envelope,
  type PermissionDecisionPayload,
} from '@telecode/protocol';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createSessionRegistry } from '../../src/registry/session-registry';
import { buildRelay } from '../../src/relay';
import { connectBrowser } from '../_helpers/ws';

/**
 * Task 6 — the human-in-the-loop permission gate. The (fake) agent wants to run a consequential tool;
 * the daemon forwards it as `agent.permission_request` and blocks on `canUseTool` until the browser
 * replies with a `permission.decision`. Asserted end-to-end against a real relay + real Postgres + an
 * in-process daemon: the gated tool only runs on `allow` (with the human's edited input on
 * allow-with-edit) and never on `deny`, and the session row flips `awaiting_input` ↔ `running` ↔ `done`.
 */
const DATABASE_URL = process.env.DATABASE_URL;

/** The scripted run: a message, then a tool that must be approved, then a closing message. */
const SCRIPT = [
  { type: 'message' as const, text: 'Planning the change' },
  {
    type: 'tool_use' as const,
    toolName: 'Write',
    input: { path: 'README.md', content: 'original' },
  },
  { type: 'message' as const, text: 'Finished' },
];

describe('permission gate: request → human decision → canUseTool allow/deny/edit', () => {
  let app: FastifyInstance;
  let daemon: Daemon;
  let handle: DbHandle;
  let admin: Pool;
  let relayUrl: string;
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
      "insert into users (provider, provider_user_id) values ('dev', 'perm') returning id",
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

    daemon = createDaemon({
      relayUrl,
      userId,
      deviceId,
      logger: pino({ level: 'silent' }),
      agentAdapter: createFakeAgentAdapter(SCRIPT),
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

  /**
   * Launch a session, then answer the first `agent.permission_request` with `decide(requestId)`.
   * Resolves once `session.ended` arrives, returning the ordered frame types, the persisted status the
   * session held at the moment of the request, the final DB status, and the streamed tool input (if any).
   */
  async function runGatedSession(
    decide: (requestId: string) => PermissionDecisionPayload,
  ): Promise<{
    types: string[];
    statusAtRequest: string | undefined;
    finalStatus: string | undefined;
    toolInput: Record<string, unknown> | undefined;
  }> {
    const browser = await connectBrowser(relayUrl, userId, deviceId);
    const received: Envelope[] = [];
    let statusAtRequest: string | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out before session.ended')), 8000);
        browser.on('message', (raw: Buffer) => {
          void (async () => {
            const envelope = parseEnvelope(JSON.parse(raw.toString()));
            received.push(envelope);
            if (envelope.type === 'agent.permission_request') {
              const request = agentPermissionRequestPayloadSchema.parse(envelope.payload);
              const sessionId = envelope.session_id;
              if (sessionId === undefined) throw new Error('permission_request missing session_id');
              // The relay must have persisted `awaiting_input` before broadcasting this request.
              const row = await admin.query<{ status: string }>(
                'select status from sessions where id = $1',
                [sessionId],
              );
              statusAtRequest = row.rows[0]?.status;
              browser.send(
                JSON.stringify(
                  makeEnvelope({
                    type: 'permission.decision',
                    userId,
                    deviceId,
                    sessionId,
                    payload: decide(request.requestId),
                  }),
                ),
              );
            }
            if (envelope.type === 'session.ended') {
              clearTimeout(timer);
              resolve();
            }
          })().catch(reject);
        });

        browser.send(
          JSON.stringify(
            makeEnvelope({
              type: 'session.launch',
              userId,
              deviceId,
              payload: { prompt: 'do it' },
            }),
          ),
        );
      });
    } finally {
      browser.close();
    }

    const sessionId = received[0]?.session_id;
    const finalRow = await admin.query<{ status: string }>(
      'select status from sessions where id = $1',
      [sessionId],
    );
    const toolUse = received.find((e) => e.type === 'agent.tool_use');
    return {
      types: received.map((e) => e.type),
      statusAtRequest,
      finalStatus: finalRow.rows[0]?.status,
      toolInput: toolUse ? agentToolUsePayloadSchema.parse(toolUse.payload).input : undefined,
    };
  }

  it('runs the gated tool when the human allows it, and the row passes through awaiting_input', async () => {
    const result = await runGatedSession((requestId) => ({ requestId, behavior: 'allow' }));

    expect(result.statusAtRequest).toBe('awaiting_input');
    expect(result.types).toEqual([
      'session.started',
      'agent.message',
      'agent.permission_request',
      'agent.tool_use',
      'agent.message',
      'session.ended',
    ]);
    expect(result.toolInput).toEqual({ path: 'README.md', content: 'original' });
    expect(result.finalStatus).toBe('done');
  });

  it('runs the gated tool with the human-edited input on allow-with-edit', async () => {
    const result = await runGatedSession((requestId) => ({
      requestId,
      behavior: 'allow',
      updatedInput: { path: 'SAFE.md', content: 'edited by human' },
    }));

    expect(result.statusAtRequest).toBe('awaiting_input');
    expect(result.types).toEqual([
      'session.started',
      'agent.message',
      'agent.permission_request',
      'agent.tool_use',
      'agent.message',
      'session.ended',
    ]);
    expect(result.toolInput).toEqual({ path: 'SAFE.md', content: 'edited by human' });
    expect(result.finalStatus).toBe('done');
  });

  it('never runs the gated tool when the human denies it', async () => {
    const result = await runGatedSession((requestId) => ({
      requestId,
      behavior: 'deny',
      message: 'not allowed',
    }));

    expect(result.statusAtRequest).toBe('awaiting_input');
    expect(result.types).toEqual([
      'session.started',
      'agent.message',
      'agent.permission_request',
      'agent.message',
      'session.ended',
    ]);
    expect(result.toolInput).toBeUndefined();
    expect(result.finalStatus).toBe('done');
  });
});
