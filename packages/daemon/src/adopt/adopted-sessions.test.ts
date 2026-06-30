import { describe, expect, it, vi } from 'vitest';

import { createAdoptedSessionManager } from './adopted-sessions';

/**
 * The adopted-session manager (Journey 1, Task 5): maps a Claude Code `session_id` to the telecode session
 * id the relay mints. The first hook event for an unknown Claude session announces it (`session.adopted`)
 * and awaits the relay's ACK; later events reuse the cached id. Pure + DI — `announce` is injected, so this
 * is unit-tested without a daemon socket.
 */
describe('createAdoptedSessionManager', () => {
  it('announces an unknown session and resolves with the relay-minted id', async () => {
    const announce = vi.fn();
    const mgr = createAdoptedSessionManager({ announce });

    const pending = mgr.ensureAdopted({ claudeSessionId: 'claude-1', title: 'fix', cwd: '/repo' });
    expect(announce).toHaveBeenCalledWith({ clientRef: 'claude-1', title: 'fix', cwd: '/repo' });

    mgr.resolveAck('claude-1', 'tc-uuid-1');
    await expect(pending).resolves.toBe('tc-uuid-1');
    expect(mgr.telecodeIdFor('claude-1')).toBe('tc-uuid-1');
  });

  it('reuses the cached id on a later event (no re-announce)', async () => {
    const announce = vi.fn();
    const mgr = createAdoptedSessionManager({ announce });

    const first = mgr.ensureAdopted({ claudeSessionId: 'claude-1' });
    mgr.resolveAck('claude-1', 'tc-1');
    await first;

    await expect(mgr.ensureAdopted({ claudeSessionId: 'claude-1' })).resolves.toBe('tc-1');
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent ensureAdopted for the same session into one announce', async () => {
    const announce = vi.fn();
    const mgr = createAdoptedSessionManager({ announce });

    const a = mgr.ensureAdopted({ claudeSessionId: 'claude-1' });
    const b = mgr.ensureAdopted({ claudeSessionId: 'claude-1' });
    expect(announce).toHaveBeenCalledTimes(1);

    mgr.resolveAck('claude-1', 'tc-1');
    await expect(Promise.all([a, b])).resolves.toEqual(['tc-1', 'tc-1']);
  });

  it('rejects when the relay never ACKs within the timeout', async () => {
    const mgr = createAdoptedSessionManager({ announce: vi.fn(), ackTimeoutMs: 10 });
    await expect(mgr.ensureAdopted({ claudeSessionId: 'claude-late' })).rejects.toThrow(
      /timed out/,
    );
  });

  it('records a late ACK that has no waiter (so a retry correlates)', () => {
    const mgr = createAdoptedSessionManager({ announce: vi.fn() });
    mgr.resolveAck('claude-late', 'tc-late');
    expect(mgr.telecodeIdFor('claude-late')).toBe('tc-late');
  });
});
