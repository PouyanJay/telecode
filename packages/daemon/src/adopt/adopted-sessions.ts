import { pino, type Logger } from 'pino';

/**
 * The adopted-session manager: the daemon's map from a Claude Code `session_id` (which the hook events
 * carry) to the telecode session id the relay mints. The first hook event for an unknown Claude session
 * triggers `ensureAdopted`, which announces it to the relay (`session.adopted`, with the Claude id as the
 * `clientRef`) and resolves once the relay's ACK arrives via {@link AdoptedSessionManager.resolveAck};
 * subsequent events reuse the cached id. Concurrent first-events for the same session are deduped into a
 * single announce.
 *
 * Pure + dependency-injected: `announce` (the actual frame send) is supplied by the daemon at the
 * composition root, so the mapping logic stays substitutable and unit-testable. Factory + its contract
 * types are tightly-coupled siblings.
 */
export interface AdoptInput {
  /** The Claude Code session id from the hook event. */
  readonly claudeSessionId: string;
  /** Derived hints for the registry row (first prompt / working directory). */
  readonly title?: string;
  readonly cwd?: string;
}

export interface AdoptedSessionManager {
  /**
   * Resolve the telecode session id for a Claude session, adopting it (announce → await ACK) on first sight.
   * Rejects if the relay does not ACK within the configured timeout (the caller then fail-closes the hook).
   */
  ensureAdopted(input: AdoptInput): Promise<string>;
  /** Feed the relay's `session.adopted` ACK: bind the `clientRef` (Claude id) to the minted telecode id. */
  resolveAck(clientRef: string, telecodeSessionId: string): void;
  /** The telecode id for an already-adopted Claude session, or undefined. */
  telecodeIdFor(claudeSessionId: string): string | undefined;
}

export interface AdoptedSessionOptions {
  /** Announce an external session to the relay (the daemon enqueues the `session.adopted` frame). */
  readonly announce: (payload: { clientRef: string; title?: string; cwd?: string }) => void;
  /** How long to wait for the relay's ACK before failing the adoption. Default 15s. */
  readonly ackTimeoutMs?: number;
  readonly logger?: Logger;
}

interface Waiter {
  readonly promise: Promise<string>;
  resolve(id: string): void;
  reject(err: unknown): void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createAdoptedSessionManager(options: AdoptedSessionOptions): AdoptedSessionManager {
  const log = options.logger ?? pino({ name: 'adopted-sessions' });
  const ackTimeoutMs = options.ackTimeoutMs ?? 15_000;
  // claudeSessionId -> telecode session id (once adopted). The clientRef we announce IS the Claude id.
  const byClaudeId = new Map<string, string>();
  // claudeSessionId -> in-flight adoption waiter (also dedupes concurrent first-events).
  const pending = new Map<string, Waiter>();

  function settle(claudeSessionId: string, telecodeSessionId: string): void {
    byClaudeId.set(claudeSessionId, telecodeSessionId);
    const waiter = pending.get(claudeSessionId);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(claudeSessionId);
      waiter.resolve(telecodeSessionId);
    }
  }

  return {
    ensureAdopted({ claudeSessionId, title, cwd }): Promise<string> {
      const known = byClaudeId.get(claudeSessionId);
      if (known !== undefined) return Promise.resolve(known);
      const inflight = pending.get(claudeSessionId);
      if (inflight) return inflight.promise;

      let resolve!: (id: string) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const timer = setTimeout(() => {
        pending.delete(claudeSessionId);
        reject(new Error(`timed out awaiting session.adopted ack for ${claudeSessionId}`));
      }, ackTimeoutMs);
      timer.unref?.();
      pending.set(claudeSessionId, { promise, resolve, reject, timer });

      log.info({ claudeSessionId }, 'adopted-sessions: announcing external session');
      options.announce({
        clientRef: claudeSessionId,
        ...(title !== undefined ? { title } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
      return promise;
    },

    resolveAck(clientRef, telecodeSessionId): void {
      // The clientRef we announced is the Claude session id; bind it even if the waiter already timed out
      // (a late ACK), so a retried hook event for the same session correlates without re-announcing.
      settle(clientRef, telecodeSessionId);
    },

    telecodeIdFor(claudeSessionId): string | undefined {
      return byClaudeId.get(claudeSessionId);
    },
  };
}
