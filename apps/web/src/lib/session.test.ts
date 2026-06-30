import { makeEnvelope, SESSION_STATUSES, type Envelope } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { SESSION_DISPLAY } from './session-display';
import {
  appendUserMessage,
  applyEnvelope,
  initialSessionState,
  markAnswering,
  markDeciding,
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
      }),
    ]);
    expect(state.status).toBe('awaiting_input');
    const pending = pendingPermission(state);
    expect(pending?.kind).toBe('permission');
    expect(pending && pending.kind === 'permission' && pending.requestId).toBe('req_1');
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
