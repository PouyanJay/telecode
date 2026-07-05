import type { SessionState } from './session';

/**
 * The needs-you inbox model (approval-reliability T6): every pending ask across the watched channel's
 * live sessions, flattened into actionable items. Three ask kinds get three names in the UI — an
 * approval (inline-actionable), a question, and a handover (both link into the session, where their
 * richer pickers live). Oldest ask first: the one that has waited longest is the most urgent, and an
 * ask with no `askedAt` (it predates this page's load) is treated as oldest of all. Pure and
 * unit-tested; the dashboard renders it.
 */
export type InboxAsk =
  | {
      readonly kind: 'permission';
      readonly sessionId: string;
      readonly sessionTitle: string | null;
      readonly deviceName: string | null;
      readonly requestId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
      /** pending | approving | rejecting — in-flight decisions stay visible as their spinner state. */
      readonly decision: 'pending' | 'approving' | 'rejecting';
      readonly askedAt?: number;
    }
  | {
      readonly kind: 'question';
      readonly sessionId: string;
      readonly sessionTitle: string | null;
      readonly deviceName: string | null;
      readonly requestId: string;
      /** The first question's prompt — the card's one-line summary. */
      readonly prompt: string;
      readonly askedAt?: number;
    }
  | {
      readonly kind: 'handover';
      readonly sessionId: string;
      readonly sessionTitle: string | null;
      readonly deviceName: string | null;
      readonly requestId: string;
      readonly question: string;
      readonly askedAt?: number;
    };

export function buildInboxAsks(input: {
  readonly live: ReadonlyMap<string, SessionState>;
  readonly titleOf: (sessionId: string) => string | null;
  readonly deviceNameOf: (sessionId: string) => string | null;
}): InboxAsk[] {
  const asks: InboxAsk[] = [];
  for (const [sessionId, state] of input.live) {
    const sessionTitle =
      input.titleOf(sessionId) ?? state.entries.find((e) => e.kind === 'user')?.text ?? null;
    const deviceName = input.deviceNameOf(sessionId);
    for (const entry of state.entries) {
      if (
        entry.kind === 'permission' &&
        (entry.decision === 'pending' ||
          entry.decision === 'approving' ||
          entry.decision === 'rejecting')
      ) {
        asks.push({
          kind: 'permission',
          sessionId,
          sessionTitle,
          deviceName,
          requestId: entry.requestId,
          toolName: entry.toolName,
          input: entry.input,
          decision: entry.decision,
          ...(entry.askedAt !== undefined ? { askedAt: entry.askedAt } : {}),
        });
      } else if (
        entry.kind === 'question' &&
        (entry.answer === 'pending' || entry.answer === 'answering')
      ) {
        asks.push({
          kind: 'question',
          sessionId,
          sessionTitle,
          deviceName,
          requestId: entry.requestId,
          prompt: entry.questions[0]?.question ?? 'The agent has a question for you.',
          ...(entry.askedAt !== undefined ? { askedAt: entry.askedAt } : {}),
        });
      } else if (
        entry.kind === 'handover' &&
        (entry.state === 'pending' || entry.state === 'submitting')
      ) {
        asks.push({
          kind: 'handover',
          sessionId,
          sessionTitle,
          deviceName,
          requestId: entry.requestId,
          question: entry.question,
          ...(entry.askedAt !== undefined ? { askedAt: entry.askedAt } : {}),
        });
      }
    }
  }
  // Waited-longest first; an unknown askedAt predates this page and sorts oldest.
  return asks.sort((a, b) => (a.askedAt ?? 0) - (b.askedAt ?? 0));
}

/**
 * How long an ask has been waiting, for the card's timer pill. Null when the ask predates this page
 * (no client receive-time — claiming a duration would be a lie until the wire carries timestamps).
 */
export function waitingLabel(askedAt: number | undefined, now: number): string | null {
  if (askedAt === undefined) return null;
  const minutes = Math.floor(Math.max(0, now - askedAt) / 60_000);
  if (minutes < 1) return 'waiting <1 min';
  if (minutes < 60) return `waiting ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `waiting ${String(hours)} hr`
    : `waiting ${String(hours)} hr ${String(rest)} min`;
}
