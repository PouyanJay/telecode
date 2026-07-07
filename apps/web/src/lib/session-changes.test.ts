import { makeEnvelope, type SessionChangesPayload } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { applyChangesFrame, type SessionChangesMap } from './session-changes';

/**
 * `session.changes` web leg (branch-actions T1): live frames fold into a per-session map the rail's
 * CHANGES panel reads. Latest-wins snapshots — a frame REPLACES the session's entry (unlike the
 * merging meta map: a diff summary is whole, not partial).
 */
const summary: SessionChangesPayload = {
  baseBranch: 'main',
  files: [{ path: 'src/app.ts', additions: 3, deletions: 1 }],
  totalAdditions: 3,
  totalDeletions: 1,
  truncated: false,
};

function frame(sessionId: string, payload: unknown, nonce = ''): ReturnType<typeof makeEnvelope> {
  return makeEnvelope({
    type: 'session.changes',
    userId: 'u1',
    deviceId: 'd1',
    sessionId,
    payload,
    nonce,
  });
}

describe('applyChangesFrame', () => {
  it('folds a decrypted frame into the map, keyed by session', () => {
    const map: SessionChangesMap = new Map();
    const next = applyChangesFrame(map, frame('s1', summary));
    expect(next.get('s1')).toEqual(summary);
    expect(map.size).toBe(0); // pure — the input map is untouched
  });

  it('replaces the previous snapshot instead of merging', () => {
    const seeded = applyChangesFrame(new Map(), frame('s1', summary));
    const emptied: SessionChangesPayload = {
      baseBranch: 'main',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      truncated: false,
    };
    const next = applyChangesFrame(seeded, frame('s1', emptied));
    expect(next.get('s1')).toEqual(emptied);
  });

  it('skips ciphertext this browser could not open, malformed payloads, and session-less frames', () => {
    const map = applyChangesFrame(new Map(), frame('s1', summary));
    expect(applyChangesFrame(map, frame('s1', 'OPAQUE_CIPHERTEXT', 'nonce'))).toBe(map);
    expect(applyChangesFrame(map, frame('s1', { files: 'nope' }))).toBe(map);
    const sessionless = makeEnvelope({
      type: 'session.changes',
      userId: 'u1',
      deviceId: 'd1',
      payload: summary,
    });
    expect(applyChangesFrame(map, sessionless)).toBe(map);
  });
});
