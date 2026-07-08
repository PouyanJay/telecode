import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agentPermissionRequestPayloadSchema,
  agentQuestionPayloadSchema,
  makeEnvelope,
  sessionHistoryPayloadSchema,
  type Envelope,
  type SessionHistoryEntry,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentEvent } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * The approval gate (architecture invariant #4) and the per-session permission mode. Telecode's own policy
 * — not the SDK's classifier — decides which tools auto-run: read-only tools proceed without a human, while
 * every consequential tool is forwarded to the operator and the run blocks until a decision returns. The
 * mode chosen at launch (`default` / `acceptEdits`) tunes that policy per session. Real daemon + fake relay
 * + deterministic fake agent (no model call, no Postgres).
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

async function startDaemon(
  userId: string,
  deviceId: string,
  events: AgentEvent[],
): Promise<FakeRelay> {
  const relay = await startFakeRelay(userId, deviceId);
  relays.push(relay);
  const daemon = createDaemon({
    relayUrl: relay.url,
    userId,
    deviceId,
    agentAdapter: createFakeAgentAdapter(events, { sessionId: 'sdk-1' }),
    logger: silent,
  });
  daemons.push(daemon);
  await daemon.start();
  return relay;
}

function launch(
  relay: FakeRelay,
  userId: string,
  deviceId: string,
  sessionId: string,
  payload: Record<string, unknown>,
): void {
  relay.send(makeEnvelope({ type: 'session.launch', userId, deviceId, sessionId, payload }));
}

async function history(
  relay: FakeRelay,
  userId: string,
  deviceId: string,
  sessionId: string,
): Promise<{ status: string; entries: SessionHistoryEntry[] }> {
  relay.send(makeEnvelope({ type: 'session.subscribe', userId, deviceId, sessionId, payload: {} }));
  const frame = await relay.waitForFrame(
    (e) => e.type === 'session.history' && e.session_id === sessionId,
  );
  return sessionHistoryPayloadSchema.parse(frame.payload);
}

const ended = (sessionId: string) => (e: Envelope) =>
  e.type === 'session.ended' && e.session_id === sessionId;
const gate = (sessionId: string) => (e: Envelope) =>
  e.type === 'agent.permission_request' && e.session_id === sessionId;

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe('approval gate + per-session permission mode', () => {
  it('auto-approves a read-only tool: it runs and ends WITHOUT a human gate', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    // A read-only tool. No permission.decision is ever sent — if the gate fired, the session would park at
    // awaiting_input forever. Reaching session.ended therefore proves it auto-approved.
    const relay = await startDaemon(userId, deviceId, [
      { type: 'tool_use', toolName: 'Read', input: { path: 'README.md' } },
    ]);
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, { prompt: 'read the file' });
    await relay.waitForFrame(ended(sid));

    const backfill = await history(relay, userId, deviceId, sid);
    expect(backfill.status).toBe('done');
    // The read ran (a tool entry), but it was never gated (no permission entry).
    expect(backfill.entries.some((e) => e.kind === 'tool')).toBe(true);
    expect(backfill.entries.some((e) => e.kind === 'permission')).toBe(false);
  });

  it('gates a consequential tool: the run blocks at the gate until the operator decides', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      { type: 'tool_use', toolName: 'Bash', input: { command: 'echo hi' } },
    ]);
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, { prompt: 'run a command' });
    // The gate fires (Bash is consequential) and the session parks awaiting the human.
    const request = await relay.waitForFrame(gate(sid));
    const parked = await history(relay, userId, deviceId, sid);
    expect(parked.status).toBe('awaiting_input');

    // Approve it; only now does the tool run and the turn end.
    const requestId = agentPermissionRequestPayloadSchema.parse(request.payload).requestId;
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId,
        deviceId,
        sessionId: sid,
        payload: { requestId, behavior: 'allow' },
      }),
    );
    await relay.waitForFrame(ended(sid));
    const done = await history(relay, userId, deviceId, sid);
    expect(done.entries.some((e) => e.kind === 'tool')).toBe(true);
  });

  it('honors acceptEdits: a file edit auto-approves while bash still gates', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    // A Write (auto-approved under acceptEdits) followed by a Bash (always gated). No decision is sent for
    // the Write — reaching the Bash gate proves the Write was not gated.
    const relay = await startDaemon(userId, deviceId, [
      { type: 'tool_use', toolName: 'Write', input: { path: 'README.md' } },
      { type: 'tool_use', toolName: 'Bash', input: { command: 'echo hi' } },
    ]);
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, {
      prompt: 'edit then run',
      permissionMode: 'acceptEdits',
    });
    // The Bash gate fires — which can only happen if the Write before it auto-approved.
    await relay.waitForFrame(gate(sid));
    const backfill = await history(relay, userId, deviceId, sid);
    const writeWasGated = backfill.entries.some(
      (e) => e.kind === 'permission' && e.toolName === 'Write',
    );
    expect(writeWasGated).toBe(false);
    // The Write ran without a gate.
    expect(backfill.entries.some((e) => e.kind === 'tool' && e.toolName === 'Write')).toBe(true);
  });

  it('honors plan mode: a file write is still gated (no silent mutation while planning)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      { type: 'tool_use', toolName: 'Write', input: { path: 'README.md' } },
    ]);
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, { prompt: 'plan it', permissionMode: 'plan' });
    // Plan mode does not auto-allow writes — the gate fires and the session parks awaiting the human.
    await relay.waitForFrame(gate(sid));
    const parked = await history(relay, userId, deviceId, sid);
    expect(parked.status).toBe('awaiting_input');
  });
});

describe('gate diff stats (mockup §01-4)', () => {
  it('an Edit gate carries a ±lines stat on the wire AND in the backfilled entry', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      {
        type: 'tool_use',
        toolName: 'Edit',
        input: { file_path: 'a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree\nfour' },
      },
    ]);
    launch(relay, userId, deviceId, sessionId, { prompt: 'edit something' });
    const frame = await relay.waitForFrame(gate(sessionId));
    expect(frame.payload).toMatchObject({
      toolName: 'Edit',
      diffStat: { added: 2, removed: 0 },
    });

    // The recorded entry carries it too, so a reopen's backfill keeps the ± on the gate card.
    const backfill = await history(relay, userId, deviceId, sessionId);
    const entry = backfill.entries.find((e) => e.kind === 'permission');
    expect(entry).toMatchObject({ diffStat: { added: 2, removed: 0 } });
  });

  it('a Write gate stats against the REAL file on disk (the un-injected read path)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'telecode-diffstat-'));
    try {
      const target = join(dir, 'notes.md');
      await writeFile(target, 'keep\nreplace me', 'utf8');
      const userId = randomUUID();
      const deviceId = randomUUID();
      const sessionId = randomUUID();
      const relay = await startDaemon(userId, deviceId, [
        {
          type: 'tool_use',
          toolName: 'Write',
          input: { file_path: target, content: 'keep\nnew one\nnew two' },
        },
      ]);
      launch(relay, userId, deviceId, sessionId, { prompt: 'write the file' });
      const frame = await relay.waitForFrame(gate(sessionId));
      expect(frame.payload).toMatchObject({ diffStat: { added: 2, removed: 1 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a Write over a HUGE target skips the stat (the read must never delay the gate)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'telecode-diffstat-big-'));
    try {
      const target = join(dir, 'big.txt');
      await writeFile(target, 'x'.repeat(600 * 1024), 'utf8'); // past the 512 KiB cap
      const userId = randomUUID();
      const deviceId = randomUUID();
      const sessionId = randomUUID();
      const relay = await startDaemon(userId, deviceId, [
        { type: 'tool_use', toolName: 'Write', input: { file_path: target, content: 'tiny' } },
      ]);
      launch(relay, userId, deviceId, sessionId, { prompt: 'overwrite the big file' });
      const frame = await relay.waitForFrame(gate(sessionId));
      expect(frame.payload).toMatchObject({ toolName: 'Write' });
      expect((frame.payload as { diffStat?: unknown }).diffStat).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a non-file tool gate carries NO stat (absent, never zeroes)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      { type: 'tool_use', toolName: 'Bash', input: { command: 'ls' } },
    ]);
    launch(relay, userId, deviceId, sessionId, { prompt: 'run something' });
    const frame = await relay.waitForFrame(gate(sessionId));
    expect(frame.payload).toMatchObject({ toolName: 'Bash' });
    expect((frame.payload as { diffStat?: unknown }).diffStat).toBeUndefined();
  });
});

describe('bypassPermissions launches (bypass-launch-mode)', () => {
  it('runs consequential tools unattended — no gate, the turn completes on its own', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      { type: 'tool_use', toolName: 'Bash', input: { command: 'pnpm test' } },
      { type: 'tool_use', toolName: 'Write', input: { path: 'a.ts', content: 'x' } },
      { type: 'message', text: 'all done' },
    ]);
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, {
      prompt: 'ship it',
      permissionMode: 'bypassPermissions',
    });
    // The run ends without ever parking on a human decision.
    await relay.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sid);
    const done = await history(relay, userId, deviceId, sid);
    expect(done.status).toBe('done');
    expect(done.entries.filter((e) => e.kind === 'permission')).toHaveLength(0);
    expect(done.entries.filter((e) => e.kind === 'tool')).toHaveLength(2);
  });

  it('still stops for AskUserQuestion — the structured picker, answered from the browser', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      {
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Deploy to staging or prod?',
              header: 'Target',
              multiSelect: false,
              options: [{ label: 'staging' }, { label: 'prod' }],
            },
          ],
        },
      },
      { type: 'message', text: 'proceeding with your pick' },
    ]);
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, {
      prompt: 'release it',
      permissionMode: 'bypassPermissions',
    });
    // The question rides the STRUCTURED flow (agent.question → picker card), never a raw
    // approve/reject gate — and the session honestly parks on it, bypass or not.
    const question = await relay.waitForFrame(
      (e) => e.type === 'agent.question' && e.session_id === sid,
    );
    const payload = agentQuestionPayloadSchema.parse(question.payload);
    expect(payload.questions[0]?.header).toBe('Target');
    const parked = await history(relay, userId, deviceId, sid);
    expect(parked.status).toBe('awaiting_input');

    // Answer from the browser; the turn continues and completes.
    relay.send(
      makeEnvelope({
        type: 'question.answer',
        userId,
        deviceId,
        sessionId: sid,
        payload: { requestId: payload.requestId, answers: [{ selectedLabels: ['prod'] }] },
      }),
    );
    await relay.waitForFrame((e) => e.type === 'session.ended' && e.session_id === sid);
    const done = await history(relay, userId, deviceId, sid);
    expect(done.status).toBe('done');
    const entry = done.entries.find((e) => e.kind === 'question');
    expect(entry?.kind === 'question' && entry.answers?.[0]?.selectedLabels).toEqual(['prod']);
  });

  it('falls back to the ordinary permission gate when the question input is unparseable', async () => {
    // The one case where a bypass operator still sees a raw approve/reject card: a malformed
    // AskUserQuestion can't render a picker, so it fails toward a human decision (never auto-runs).
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      { type: 'tool_use', toolName: 'AskUserQuestion', input: { not_questions: true } },
    ]);
    const sid = randomUUID();
    launch(relay, userId, deviceId, sid, {
      prompt: 'ask badly',
      permissionMode: 'bypassPermissions',
    });
    const request = await relay.waitForFrame(gate(sid));
    expect(agentPermissionRequestPayloadSchema.parse(request.payload).toolName).toBe(
      'AskUserQuestion',
    );
  });

  it('tells the agent to use its own judgment when a question goes unanswered (timeout)', async () => {
    // Bypass runs are often unattended — an unanswered question must settle the turn, not hang it.
    const decisions: { behavior: string; message?: string }[] = [];
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startFakeRelay(userId, deviceId);
    relays.push(relay);
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId,
      deviceId,
      agentAdapter: {
        async run(_prompt, { canUseTool, onEvent }) {
          const decision = await canUseTool({
            toolName: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Anyone there?',
                  header: 'Hello',
                  multiSelect: false,
                  options: [{ label: 'yes' }, { label: 'no' }],
                },
              ],
            },
          });
          decisions.push({
            behavior: decision.behavior,
            ...(decision.behavior === 'deny' && decision.message !== undefined
              ? { message: decision.message }
              : {}),
          });
          onEvent({ type: 'message', text: 'continuing on my own judgment' });
          return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-q-timeout' };
        },
      },
      logger: silent,
      gateTimeoutMs: 250,
    });
    daemons.push(daemon);
    await daemon.start();
    const sid = randomUUID();

    launch(relay, userId, deviceId, sid, { prompt: 'go', permissionMode: 'bypassPermissions' });
    await relay.waitForFrame((e) => e.type === 'agent.question' && e.session_id === sid);
    // Nobody answers. The gate timeout settles the question (pushing its own reconcile
    // session.history — consume it so the final subscribe's backfill is what we assert on)
    // and the turn completes on its own.
    await relay.waitForFrame((e) => e.type === 'session.history' && e.session_id === sid);
    await relay.waitForFrame(ended(sid));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ behavior: 'deny' });
    expect(decisions[0]?.message).toMatch(/No answer arrived/);
    expect(decisions[0]?.message).toMatch(/own judgment|most sensible option/);
    const done = await history(relay, userId, deviceId, sid);
    expect(done.status).toBe('done');
  });

  it('routes AskUserQuestion through the picker in gated modes too (never a raw approve/reject)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, [
      {
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which one?',
              header: 'Pick',
              multiSelect: false,
              options: [{ label: 'A' }, { label: 'B' }],
            },
          ],
        },
      },
    ]);
    const sid = randomUUID();
    launch(relay, userId, deviceId, sid, { prompt: 'ask me', permissionMode: 'default' });
    const question = await relay.waitForFrame(
      (e) => e.type === 'agent.question' && e.session_id === sid,
    );
    expect(agentQuestionPayloadSchema.parse(question.payload).questions[0]?.header).toBe('Pick');
  });
});
