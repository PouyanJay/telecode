import { makeEnvelope, type Envelope } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import {
  applyEnvelope,
  initialSessionState,
  markDeciding,
  pendingPermission,
  startingState,
  type SessionState,
} from './session';

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

  it('ignores frames with invalid payloads', () => {
    const state = applyEnvelope(startingState(), frame('agent.message', { notText: 1 }));
    expect(state.entries).toHaveLength(0);
  });

  it('starts from an idle initial state', () => {
    expect(initialSessionState.status).toBe('idle');
    expect(initialSessionState.entries).toHaveLength(0);
  });
});
