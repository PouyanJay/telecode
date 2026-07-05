import { makeEnvelope, type Envelope } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { buildInboxAsks } from './inbox';
import { applyEnvelope, markDeciding, startingState, type SessionState } from './session';
import { waitingLabel } from './waiting-label';

/**
 * The needs-you inbox (approval-reliability T6): every pending ask across the watched channel's live
 * sessions, as actionable cards. Three ask kinds get three names — an approval, a question, a
 * handover — and each carries how long it has been waiting (client receive-time until the wire gains
 * timestamps in Phase 3). Pure builder over the live session map.
 */
const NOW = 1_751_700_000_000;

function frame(sessionId: string, type: Envelope['type'], payload: unknown): Envelope {
  return makeEnvelope({ type, userId: 'u', deviceId: 'd', sessionId, payload });
}

const QUESTION = {
  question: 'Apply the migration now?',
  header: 'Migration',
  multiSelect: false,
  options: [{ label: 'Now' }, { label: 'Later' }],
};

function liveWith(...states: [string, SessionState][]): ReadonlyMap<string, SessionState> {
  return new Map(states);
}

function sessionWithGate(sessionId: string, askedAt: number): SessionState {
  let state = applyEnvelope(startingState(), frame(sessionId, 'session.started', {}), askedAt);
  state = applyEnvelope(
    state,
    frame(sessionId, 'agent.permission_request', {
      requestId: `req-${sessionId}`,
      toolName: 'Bash',
      input: { command: 'pnpm db:migrate' },
    }),
    askedAt,
  );
  return state;
}

describe('askedAt stamping (client receive-time)', () => {
  it('stamps a permission gate, question, and handover with the fold-time clock', () => {
    let state = sessionWithGate('s1', NOW - 60_000);
    state = applyEnvelope(
      state,
      frame('s1', 'agent.question', { requestId: 'q1', questions: [QUESTION] }),
      NOW - 30_000,
    );
    state = applyEnvelope(
      state,
      frame('s1', 'agent.handover', { requestId: 'h1', question: 'Take over?', summary: '' }),
      NOW - 10_000,
    );
    const [gate, question, handover] = [
      state.entries.find((e) => e.kind === 'permission'),
      state.entries.find((e) => e.kind === 'question'),
      state.entries.find((e) => e.kind === 'handover'),
    ];
    expect(gate && 'askedAt' in gate ? gate.askedAt : undefined).toBe(NOW - 60_000);
    expect(question && 'askedAt' in question ? question.askedAt : undefined).toBe(NOW - 30_000);
    expect(handover && 'askedAt' in handover ? handover.askedAt : undefined).toBe(NOW - 10_000);
  });
});

describe('buildInboxAsks', () => {
  const titleOf = (id: string): string | null => (id === 's1' ? 'fix pairing race' : null);
  const deviceNameOf = (): string | null => 'macbook';

  it('collects the three ask kinds with session context, oldest first', () => {
    let s1 = sessionWithGate('s1', NOW - 120_000);
    s1 = applyEnvelope(
      s1,
      frame('s1', 'agent.handover', { requestId: 'h1', question: 'Continue here?', summary: '' }),
      NOW - 20_000,
    );
    const s2 = applyEnvelope(
      applyEnvelope(startingState(), frame('s2', 'session.started', {}), NOW),
      frame('s2', 'agent.question', { requestId: 'q2', questions: [QUESTION] }),
      NOW - 60_000,
    );
    const asks = buildInboxAsks({ live: liveWith(['s1', s1], ['s2', s2]), titleOf, deviceNameOf });

    expect(asks.map((a) => a.kind)).toEqual(['permission', 'question', 'handover']);
    expect(asks[0]).toMatchObject({
      sessionId: 's1',
      sessionTitle: 'fix pairing race',
      deviceName: 'macbook',
      requestId: 'req-s1',
      toolName: 'Bash',
      askedAt: NOW - 120_000,
    });
    expect(asks[1]).toMatchObject({ sessionId: 's2', requestId: 'q2', prompt: QUESTION.question });
    expect(asks[2]).toMatchObject({ sessionId: 's1', requestId: 'h1', question: 'Continue here?' });
  });

  it('lists every pending gate of one session as its own card (concurrent tool calls)', () => {
    let s1 = sessionWithGate('s1', NOW - 60_000);
    s1 = applyEnvelope(
      s1,
      frame('s1', 'agent.permission_request', {
        requestId: 'req-second',
        toolName: 'Write',
        input: { path: 'a.txt' },
      }),
      NOW - 30_000,
    );
    const asks = buildInboxAsks({ live: liveWith(['s1', s1]), titleOf, deviceNameOf });
    expect(asks.map((a) => a.requestId)).toEqual(['req-s1', 'req-second']);
  });

  it('keeps an in-flight decision visible as its spinner state', () => {
    const deciding = markDeciding(sessionWithGate('s1', NOW), 'req-s1', 'allow');
    const asks = buildInboxAsks({ live: liveWith(['s1', deciding]), titleOf, deviceNameOf });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ kind: 'permission', decision: 'approving' });
  });

  it('drops resolved asks (the session settled them)', () => {
    const resolved = applyEnvelope(
      sessionWithGate('s1', NOW),
      frame('s1', 'session.ended', { status: 'done' }),
      NOW,
    );
    expect(buildInboxAsks({ live: liveWith(['s1', resolved]), titleOf, deviceNameOf })).toEqual([]);
  });

  it('returns nothing for sessions with no pending asks', () => {
    const idle = applyEnvelope(startingState(), frame('s3', 'session.started', {}), NOW);
    expect(buildInboxAsks({ live: liveWith(['s3', idle]), titleOf, deviceNameOf })).toEqual([]);
  });
});

describe('waitingLabel', () => {
  it('formats minutes and hours, says nothing when the ask predates this page', () => {
    expect(waitingLabel(NOW - 30_000, NOW)).toBe('waiting <1 min');
    expect(waitingLabel(NOW - 18 * 60_000, NOW)).toBe('waiting 18 min');
    expect(waitingLabel(NOW - 90 * 60_000, NOW)).toBe('waiting 1 hr 30 min');
    expect(waitingLabel(undefined, NOW)).toBeNull();
  });
});
