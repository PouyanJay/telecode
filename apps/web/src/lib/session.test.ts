import { makeEnvelope, SESSION_STATUSES, type Envelope } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { SESSION_DISPLAY } from './session-display';
import {
  appendUserMessage,
  applyEnvelope,
  initialSessionState,
  markAnswering,
  markDeciding,
  linkHandoverChild,
  markHandoverSubmitting,
  pendingHandover,
  pendingPermission,
  pendingQuestion,
  startingState,
  type SessionState,
} from './session';

const DB_QUESTION = {
  question: 'Which database should we use?',
  header: 'Database',
  multiSelect: false,
  options: [{ label: 'Postgres' }, { label: 'SQLite' }],
};

const USER = 'u_1';
const DEVICE = 'd_1';
const SESSION = 'sess-123';

function frame(type: Envelope['type'], payload: unknown): Envelope {
  return makeEnvelope({ type, userId: USER, deviceId: DEVICE, sessionId: SESSION, payload });
}

/** Fold a list of frames over the initial state. */
function fold(frames: Envelope[]): SessionState {
  return frames.reduce(applyEnvelope, startingState());
}

describe('session reducer', () => {
  it('records the session id and flips to running on session.started', () => {
    const state = applyEnvelope(startingState(), frame('session.started', {}));
    expect(state.sessionId).toBe(SESSION);
    expect(state.status).toBe('running');
  });

  it('appends agent messages and tool calls in order with stable keys', () => {
    const state = fold([
      frame('session.started', {}),
      frame('agent.message', { text: 'Planning' }),
      frame('agent.tool_use', { toolName: 'Read', input: { path: 'README.md' } }),
      frame('agent.message', { text: 'Done' }),
    ]);
    expect(state.entries.map((e) => e.kind)).toEqual(['message', 'tool', 'message']);
    expect(new Set(state.entries.map((e) => e.id)).size).toBe(3); // keys are unique
    const tool = state.entries[1];
    expect(tool?.kind).toBe('tool');
    if (tool?.kind === 'tool') {
      expect(tool.toolName).toBe('Read');
    }
  });

  it('surfaces a permission request as awaiting_input with a pending decision', () => {
    const state = fold([
      frame('session.started', {}),
      frame('agent.permission_request', {
        requestId: 'req_1',
        toolName: 'Write',
        input: { path: 'x' },
        diffStat: { added: 3, removed: 1 },
      }),
    ]);
    expect(state.status).toBe('awaiting_input');
    const pending = pendingPermission(state);
    expect(pending?.kind).toBe('permission');
    expect(pending && pending.kind === 'permission' && pending.requestId).toBe('req_1');
    // The gate's ±lines rides the live frame into the entry (mockup §01-4).
    expect(pending && pending.kind === 'permission' && pending.diffStat).toEqual({
      added: 3,
      removed: 1,
    });
  });

  it('confirms an in-flight approval once the next frame arrives (round-trip, not optimistic)', () => {
    let state = fold([
      frame('session.started', {}),
      frame('agent.permission_request', { requestId: 'req_1', toolName: 'Write', input: {} }),
    ]);
    state = markDeciding(state, 'req_1', 'allow');
    // Optimistic-but-pending: shown as approving, status back to running, but not yet confirmed.
    expect(state.status).toBe('running');
    expect(state.entries.find((e) => e.kind === 'permission')?.decision).toBe('approving');
    expect(pendingPermission(state)).toBeUndefined();

    // The daemon's next frame (the tool actually running) confirms it.
    state = applyEnvelope(state, frame('agent.tool_use', { toolName: 'Write', input: {} }));
    expect(state.entries.find((e) => e.kind === 'permission')?.decision).toBe('approved');
  });

  it('confirms a rejection on the following frame', () => {
    let state = fold([
      frame('session.started', {}),
      frame('agent.permission_request', { requestId: 'req_1', toolName: 'Bash', input: {} }),
    ]);
    state = markDeciding(state, 'req_1', 'deny');
    state = applyEnvelope(state, frame('agent.message', { text: 'continuing' }));
    expect(state.entries.find((e) => e.kind === 'permission')?.decision).toBe('rejected');
  });

  it('marks the terminal status from session.ended', () => {
    const done = applyEnvelope(startingState(), frame('session.ended', { status: 'done' }));
    expect(done.status).toBe('done');
    const errored = applyEnvelope(startingState(), frame('session.ended', { status: 'error' }));
    expect(errored.status).toBe('error');
  });

  it('closes a still-pending gate as rejected when the session ends (no dead, clickable gate)', () => {
    let state = fold([
      frame('session.started', {}),
      frame('agent.permission_request', { requestId: 'req_1', toolName: 'Bash', input: {} }),
    ]);
    expect(pendingPermission(state)?.kind).toBe('permission');

    // The session ends (e.g. interrupted) while the gate is still awaiting a verdict. The terminal
    // session can no longer answer a decision, so the gate must close — otherwise the Approve/Reject
    // buttons stay live and a click strands on the daemon (which already settled the gate).
    state = applyEnvelope(state, frame('session.ended', { status: 'done' }));
    expect(state.status).toBe('done');
    // The tool never ran, matching the daemon's recorded `deny`, so it reads as rejected — not actionable.
    expect(state.entries.find((e) => e.kind === 'permission')?.decision).toBe('rejected');
    expect(pendingPermission(state)).toBeUndefined();
  });

  it('ignores frames with invalid payloads', () => {
    const state = applyEnvelope(startingState(), frame('agent.message', { notText: 1 }));
    expect(state.entries).toHaveLength(0);
  });

  it('rebuilds the transcript from session.history on reconnect (backfill)', () => {
    const state = applyEnvelope(
      initialSessionState,
      frame('session.history', {
        status: 'awaiting_input',
        entries: [
          { kind: 'user', text: 'do it' },
          { kind: 'message', text: 'Working' },
          {
            kind: 'permission',
            requestId: 'req_1',
            toolName: 'Read',
            input: { path: 'README.md' },
            decision: 'allow',
          },
          { kind: 'tool', toolName: 'Read', input: { path: 'README.md' } },
          {
            kind: 'permission',
            requestId: 'req_2',
            toolName: 'Write',
            input: { path: 'x' },
            decision: 'pending',
          },
        ],
      }),
    );
    expect(state.sessionId).toBe(SESSION);
    expect(state.status).toBe('awaiting_input');
    expect(state.entries.map((e) => e.kind)).toEqual([
      'user',
      'message',
      'permission',
      'tool',
      'permission',
    ]);
    // The resolved gate shows decided (no buttons); the still-open gate stays actionable.
    const perms = state.entries.filter((e) => e.kind === 'permission');
    expect(perms.map((e) => e.kind === 'permission' && e.decision)).toEqual([
      'approved',
      'pending',
    ]);
    expect(pendingPermission(state)?.kind).toBe('permission');
    expect(new Set(state.entries.map((e) => e.id)).size).toBe(5); // stable, unique keys
  });

  it('keeps a finished transcript when the daemon backfills empty/offline (no clobber on reconnect)', () => {
    // A session watched to completion: a full transcript, terminal status `done`.
    const finished = fold([
      frame('session.started', {}),
      frame('agent.message', { text: 'Here is the answer' }),
      frame('session.ended', { status: 'done' }),
    ]);
    expect(finished.entries.length).toBeGreaterThan(0);

    // A reconnect re-subscribes, but the daemon no longer holds the session (it restarted) and backfills
    // an empty, offline_paused history. That must NOT wipe the transcript we already have — and a finished
    // session must keep showing DONE, not flip to OFFLINE. (This is the "finished session went blank" bug.)
    const after = applyEnvelope(
      finished,
      frame('session.history', { status: 'offline_paused', entries: [] }),
    );
    expect(after.entries).toEqual(finished.entries);
    expect(after.status).toBe('done');
  });

  it.each(['turn_limit', 'needs_restart'] as const)(
    'keeps a %s session on its honest ended state through an empty backfill (never OFFLINE)',
    (status) => {
      const settled = fold([
        frame('session.started', {}),
        frame('agent.message', { text: 'partial work' }),
        frame('session.ended', { status }),
      ]);
      expect(settled.status).toBe(status);

      const after = applyEnvelope(
        settled,
        frame('session.history', { status: 'offline_paused', entries: [] }),
      );
      expect(after.entries).toEqual(settled.entries);
      expect(after.status).toBe(status);
    },
  );

  it('lets an in-flight session show offline on an empty backfill, but keeps its transcript', () => {
    const live = fold([frame('session.started', {}), frame('agent.message', { text: 'working' })]);
    expect(live.status).toBe('running');

    const after = applyEnvelope(
      live,
      frame('session.history', { status: 'offline_paused', entries: [] }),
    );
    // Transcript preserved; a non-terminal session honestly reflects that the daemon is offline.
    expect(after.entries).toEqual(live.entries);
    expect(after.status).toBe('offline_paused');
  });

  it('still reports an empty offline backfill when there is no local transcript to protect', () => {
    const after = applyEnvelope(
      initialSessionState,
      frame('session.history', { status: 'offline_paused', entries: [] }),
    );
    expect(after.entries).toHaveLength(0);
    expect(after.status).toBe('offline_paused');
  });

  it('starts from an idle initial state', () => {
    expect(initialSessionState.status).toBe('idle');
    expect(initialSessionState.entries).toHaveLength(0);
  });

  it('appends the human’s own messages (launch prompt + follow-ups) interleaved with the agent', () => {
    let state = appendUserMessage(startingState(), 'build it');
    state = applyEnvelope(state, frame('session.started', {}));
    state = applyEnvelope(state, frame('agent.message', { text: 'on it' }));
    state = appendUserMessage(state, 'now add tests');

    expect(state.entries.map((e) => e.kind)).toEqual(['user', 'message', 'user']);
    const [first, , third] = state.entries;
    expect(first?.kind === 'user' && first.text).toBe('build it');
    expect(third?.kind === 'user' && third.text).toBe('now add tests');
    expect(new Set(state.entries.map((e) => e.id)).size).toBe(3); // stable, unique keys
  });
});

describe('session reducer: adopted-session questions (Journey 2)', () => {
  it('surfaces an agent.question as awaiting_input with a pending question', () => {
    const state = fold([
      frame('session.started', {}),
      frame('agent.question', { requestId: 'q1', questions: [DB_QUESTION] }),
    ]);
    expect(state.status).toBe('awaiting_input');
    const pending = pendingQuestion(state);
    expect(pending?.kind).toBe('question');
    if (pending?.kind === 'question') {
      expect(pending.requestId).toBe('q1');
      expect(pending.questions[0]?.header).toBe('Database');
    }
  });

  it('marks an answer in-flight (answering) and confirms it on the next frame', () => {
    let state = fold([
      frame('session.started', {}),
      frame('agent.question', { requestId: 'q1', questions: [DB_QUESTION] }),
    ]);
    state = markAnswering(state, 'q1', [{ selectedLabels: ['Postgres'] }]);
    // In-flight: shown as answering, status back to running, no longer the pending question.
    expect(state.status).toBe('running');
    const answering = state.entries.find((e) => e.kind === 'question');
    expect(answering?.kind === 'question' && answering.answer).toBe('answering');
    expect(pendingQuestion(state)).toBeUndefined();

    // The daemon's next frame (the session resuming) confirms the answer was delivered.
    state = applyEnvelope(state, frame('agent.message', { text: 'Using Postgres.' }));
    const answered = state.entries.find((e) => e.kind === 'question');
    expect(answered?.kind === 'question' && answered.answer).toBe('answered');
  });

  it('closes a still-pending question when the session ends (no dead, clickable picker)', () => {
    let state = fold([
      frame('session.started', {}),
      frame('agent.question', { requestId: 'q1', questions: [DB_QUESTION] }),
    ]);
    expect(pendingQuestion(state)?.kind).toBe('question');

    state = applyEnvelope(state, frame('session.ended', { status: 'done' }));
    const closed = state.entries.find((e) => e.kind === 'question');
    expect(closed?.kind === 'question' && closed.answer).toBe('closed');
    expect(pendingQuestion(state)).toBeUndefined();
  });

  it('ignores an agent.question with an invalid payload', () => {
    const state = applyEnvelope(startingState(), frame('agent.question', { requestId: 'q1' }));
    expect(state.entries).toHaveLength(0);
  });

  it('backfills question entries from session.history (pending + answered)', () => {
    const state = applyEnvelope(
      initialSessionState,
      frame('session.history', {
        status: 'awaiting_input',
        entries: [
          {
            kind: 'question',
            requestId: 'q1',
            questions: [DB_QUESTION],
            answers: [{ selectedLabels: ['Postgres'] }],
          },
          { kind: 'question', requestId: 'q2', questions: [DB_QUESTION] },
        ],
      }),
    );
    expect(state.entries.map((e) => e.kind)).toEqual(['question', 'question']);
    const [answered, pending] = state.entries;
    expect(answered?.kind === 'question' && answered.answer).toBe('answered');
    expect(pending?.kind === 'question' && pending.answer).toBe('pending');
    // The resolved one is no longer actionable; the still-open one is the pending question.
    const stillPending = pendingQuestion(state);
    expect(stillPending?.kind === 'question' && stillPending.requestId).toBe('q2');
  });
});

describe('session reducer: adopted-session notice (Journey 3)', () => {
  it('sets the notice on agent.notice (needs attention)', () => {
    const state = fold([
      frame('session.started', {}),
      frame('agent.notice', { message: 'Claude is waiting for your input' }),
    ]);
    expect(state.notice).toBe('Claude is waiting for your input');
  });

  it('clears the notice on the next frame (the session moved on)', () => {
    let state = fold([frame('session.started', {}), frame('agent.notice', { message: 'idle' })]);
    expect(state.notice).toBe('idle');
    state = applyEnvelope(state, frame('agent.message', { text: 'back to work' }));
    expect(state.notice).toBeNull();
  });

  it('clears the notice when the session ends', () => {
    let state = fold([frame('session.started', {}), frame('agent.notice', { message: 'idle' })]);
    state = applyEnvelope(state, frame('session.ended', { status: 'done' }));
    expect(state.notice).toBeNull();
  });

  it('ignores an agent.notice with an invalid payload', () => {
    const state = applyEnvelope(startingState(), frame('agent.notice', { message: '' }));
    expect(state.notice).toBeNull();
  });
});

// Variant coverage (Task 11): every wire session status must have a display mapping — a parametrized
// guard so adding a status without a display fails here.
describe('session status coverage', () => {
  it.each(SESSION_STATUSES)('has a display mapping for %s', (status) => {
    expect(SESSION_DISPLAY[status]).toBeDefined();
  });
});

describe('session reducer: free-form handover (Journey 4)', () => {
  const HANDOVER = {
    requestId: 'h1',
    question: 'Which database should we use?',
    summary: 'scaffolding an API',
  };

  it('surfaces an agent.handover as awaiting_input with a pending, actionable offer', () => {
    const state = fold([frame('session.started', {}), frame('agent.handover', HANDOVER)]);
    expect(state.status).toBe('awaiting_input');
    const pending = pendingHandover(state);
    expect(pending?.kind).toBe('handover');
    if (pending?.kind === 'handover') {
      expect(pending.requestId).toBe('h1');
      expect(pending.question).toContain('database');
      expect(pending.summary).toBe('scaffolding an API');
    }
  });

  it('marks a take-over in-flight (submitting) and confirms it on the next frame', () => {
    let state = fold([frame('session.started', {}), frame('agent.handover', HANDOVER)]);
    state = markHandoverSubmitting(state, 'h1', 'Use Postgres.');
    const submitting = state.entries.find((e) => e.kind === 'handover');
    expect(submitting?.kind === 'handover' && submitting.state).toBe('submitting');
    expect(submitting?.kind === 'handover' && submitting.answerText).toBe('Use Postgres.');
    expect(pendingHandover(state)).toBeUndefined();

    // The daemon's next frame (the parent ending — the conversation migrated) confirms the take-over.
    state = applyEnvelope(state, frame('session.ended', { status: 'done' }));
    const submitted = state.entries.find((e) => e.kind === 'handover');
    expect(submitted?.kind === 'handover' && submitted.state).toBe('submitted');
    expect(state.status).toBe('done');
  });

  it('closes a still-pending handover when the session ends (no dead, clickable card)', () => {
    let state = fold([frame('session.started', {}), frame('agent.handover', HANDOVER)]);
    state = applyEnvelope(state, frame('session.ended', { status: 'done' }));
    const closed = state.entries.find((e) => e.kind === 'handover');
    expect(closed?.kind === 'handover' && closed.state).toBe('closed');
    expect(pendingHandover(state)).toBeUndefined();
  });

  it('backfills an answered handover as submitted, an unanswered one as pending', () => {
    const state = applyEnvelope(
      startingState(),
      frame('session.history', {
        status: 'done',
        entries: [
          {
            kind: 'handover',
            requestId: 'h1',
            question: 'Which DB?',
            summary: '',
            answerText: 'Postgres',
          },
          { kind: 'handover', requestId: 'h2', question: 'Which region?', summary: '' },
        ],
      }),
    );
    const [a, b] = state.entries;
    expect(a?.kind === 'handover' && a.state).toBe('submitted');
    expect(a?.kind === 'handover' && a.answerText).toBe('Postgres');
    expect(b?.kind === 'handover' && b.state).toBe('pending');
  });

  it('ignores an agent.handover with an invalid payload', () => {
    const state = applyEnvelope(startingState(), frame('agent.handover', { requestId: 'h1' }));
    expect(state.entries).toHaveLength(0);
  });

  it('links the taken-over handover to its forked continuation (childSessionId)', () => {
    let state = fold([frame('session.started', {}), frame('agent.handover', HANDOVER)]);
    state = markHandoverSubmitting(state, 'h1', 'Use Postgres.');
    state = linkHandoverChild(state, 'child-sess-1');
    const linked = state.entries.find((e) => e.kind === 'handover');
    expect(linked?.kind === 'handover' && linked.childSessionId).toBe('child-sess-1');
  });

  it('does not link when there is no taken-over handover to link', () => {
    const state = fold([frame('session.started', {}), frame('agent.handover', HANDOVER)]);
    // Still pending (not submitting/submitted) → nothing to link, same state reference back.
    expect(linkHandoverChild(state, 'child-sess-1')).toBe(state);
  });

  it('backfills all three decision kinds (permission + question + handover) in one adopted transcript', () => {
    const state = applyEnvelope(
      startingState(),
      frame('session.history', {
        status: 'awaiting_input',
        entries: [
          { kind: 'user', text: 'help me set up the db' },
          {
            kind: 'permission',
            requestId: 'p1',
            toolName: 'Bash',
            input: {},
            diffStat: { added: 12, removed: 4 },
            decision: 'allow',
          },
          {
            kind: 'question',
            requestId: 'q1',
            questions: [DB_QUESTION],
            answers: [{ selectedLabels: ['Postgres'] }],
          },
          { kind: 'handover', requestId: 'h1', question: 'Which region?', summary: '' },
        ],
      }),
    );
    const kinds = state.entries.map((e) => e.kind);
    expect(kinds).toEqual(['user', 'permission', 'question', 'handover']);
    const permission = state.entries[1];
    const question = state.entries[2];
    const handover = state.entries[3];
    expect(permission?.kind === 'permission' && permission.decision).toBe('approved');
    // The gate's ±lines survives the backfill fold (mockup §01-4) — a reload keeps the badge.
    expect(permission?.kind === 'permission' && permission.diffStat).toEqual({
      added: 12,
      removed: 4,
    });
    expect(question?.kind === 'question' && question.answer).toBe('answered');
    expect(handover?.kind === 'handover' && handover.state).toBe('pending');
  });
});

describe('session reducer: relay.error (undelivered action, approval-reliability T4)', () => {
  function withPendingGate(): SessionState {
    return fold([
      frame('session.started', {}),
      frame('agent.permission_request', {
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'echo hi' },
      }),
    ]);
  }

  it('reverts an in-flight decision to pending and surfaces the delivery error', () => {
    const deciding = markDeciding(withPendingGate(), 'req-1', 'allow');
    const after = applyEnvelope(
      deciding,
      frame('relay.error', { code: 'device_offline', regarding: 'permission.decision' }),
    );
    const entry = after.entries.find((e) => e.kind === 'permission');
    expect(entry && 'decision' in entry ? entry.decision : undefined).toBe('pending');
    expect(after.deliveryError).not.toBeNull();
    expect(after.status).toBe('offline_paused');
  });

  it('reverts an in-flight question answer and handover takeover to pending', () => {
    let state = fold([
      frame('session.started', {}),
      frame('agent.question', { requestId: 'q-1', questions: [DB_QUESTION] }),
      frame('agent.handover', { requestId: 'h-1', question: 'Continue?', summary: '' }),
    ]);
    state = markAnswering(state, 'q-1', [{ selectedLabels: ['Postgres'] }]);
    state = markHandoverSubmitting(state, 'h-1', 'yes, do it');
    const after = applyEnvelope(
      state,
      frame('relay.error', { code: 'device_offline', regarding: 'question.answer' }),
    );
    const question = after.entries.find((e) => e.kind === 'question');
    const handover = after.entries.find((e) => e.kind === 'handover');
    expect(question && 'answer' in question ? question.answer : undefined).toBe('pending');
    expect(handover && 'state' in handover ? handover.state : undefined).toBe('pending');
  });

  it('keeps a terminal status terminal (only the error is surfaced)', () => {
    const done = applyEnvelope(withPendingGate(), frame('session.ended', { status: 'done' }));
    const after = applyEnvelope(
      done,
      frame('relay.error', { code: 'device_offline', regarding: 'user.message' }),
    );
    expect(after.status).toBe('done');
    expect(after.deliveryError).not.toBeNull();
  });

  it('clears the delivery error the moment any other frame arrives (the channel works again)', () => {
    const errored = applyEnvelope(
      withPendingGate(),
      frame('relay.error', { code: 'device_offline', regarding: 'user.message' }),
    );
    const recovered = applyEnvelope(errored, frame('agent.message', { text: 'back online' }));
    expect(recovered.deliveryError).toBeNull();
  });

  it('ignores a malformed relay.error payload', () => {
    const state = withPendingGate();
    expect(applyEnvelope(state, frame('relay.error', { nope: true }))).toBe(state);
  });
});

describe('per-entry times (Phase 3 T1): daemon ts preferred, fold clock fallback', () => {
  const NOW = 1_783_290_000_000;
  const DAEMON_TS = NOW - 45_000; // the daemon stamped the entry 45s before this client received it

  it('stamps message and tool entries from the wire ts when the daemon sent one', () => {
    let state = applyEnvelope(startingState(), frame('session.started', {}), NOW);
    state = applyEnvelope(state, frame('agent.message', { text: 'working', ts: DAEMON_TS }), NOW);
    state = applyEnvelope(
      state,
      frame('agent.tool_use', { toolName: 'Read', input: {}, ts: DAEMON_TS + 1 }),
      NOW,
    );
    expect(state.entries.map((e) => e.at)).toEqual([DAEMON_TS, DAEMON_TS + 1]);
  });

  it('falls back to the fold clock when an old daemon stamps nothing', () => {
    let state = applyEnvelope(startingState(), frame('session.started', {}), NOW);
    state = applyEnvelope(state, frame('agent.message', { text: 'working' }), NOW);
    expect(state.entries[0]?.at).toBe(NOW);
  });

  it('prefers the daemon ts for an ask entry — the waiting timer stays honest across reloads', () => {
    let state = applyEnvelope(startingState(), frame('session.started', {}), NOW);
    state = applyEnvelope(
      state,
      frame('agent.permission_request', {
        requestId: 'r1',
        toolName: 'Bash',
        input: {},
        ts: DAEMON_TS,
      }),
      NOW,
    );
    const gate = state.entries.find((e) => e.kind === 'permission');
    expect(gate?.at).toBe(DAEMON_TS);
  });

  it('prefers the daemon ts for question and handover asks too (every ask kind, same rule)', () => {
    let state = applyEnvelope(startingState(), frame('session.started', {}), NOW);
    state = applyEnvelope(
      state,
      frame('agent.question', { requestId: 'q1', questions: [DB_QUESTION], ts: DAEMON_TS }),
      NOW,
    );
    state = applyEnvelope(
      state,
      frame('agent.handover', {
        requestId: 'h1',
        question: 'Take over?',
        summary: '',
        ts: DAEMON_TS + 1,
      }),
      NOW,
    );
    expect(state.entries.find((e) => e.kind === 'question')?.at).toBe(DAEMON_TS);
    expect(state.entries.find((e) => e.kind === 'handover')?.at).toBe(DAEMON_TS + 1);
  });

  it('maps backfilled history ts onto entries and leaves unstamped ones un-stamped', () => {
    const state = applyEnvelope(
      startingState(),
      frame('session.history', {
        status: 'awaiting_input',
        entries: [
          { kind: 'user', text: 'do it', ts: DAEMON_TS },
          { kind: 'message', text: 'from an old daemon' },
          {
            kind: 'permission',
            requestId: 'r1',
            toolName: 'Write',
            input: {},
            decision: 'pending',
            ts: DAEMON_TS + 2,
          },
        ],
      }),
      NOW,
    );
    expect(state.entries.map((e) => e.at)).toEqual([DAEMON_TS, undefined, DAEMON_TS + 2]);
    // A backfilled pending gate now carries its REAL ask time — the inbox waiting pill survives reload.
    const gate = state.entries.find((e) => e.kind === 'permission');
    expect(gate?.at).toBe(DAEMON_TS + 2);
  });

  it('stamps the local echo of the human message with the provided clock', () => {
    const state = appendUserMessage(startingState(), 'do the thing', NOW);
    expect(state.entries[0]?.at).toBe(NOW);
  });
});
