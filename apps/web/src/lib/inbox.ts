import { firstRealPromptText, type DiffStat } from '@telecode/protocol';
import type { SessionState, TranscriptEntry } from './session';
import { pickDisplayTitle } from './session-groups';

/**
 * The needs-you inbox model (approval-reliability T6): every pending ask across the watched channel's
 * live sessions, flattened into actionable items. Three ask kinds get three names in the UI — an
 * approval (inline-actionable), a question, and a handover (both link into the session, where their
 * richer pickers live). Oldest ask first: the one that has waited longest is the most urgent, and an
 * ask with no known time (an unstamped backfill from an old daemon) is treated as oldest of all.
 * `askedAt` comes from the entry's `at` — the daemon's wire stamp when it sent one (honest across
 * reloads), else this client's receive-time. Pure and unit-tested; the dashboard renders it.
 * (`InboxAsk` is this builder's tightly-coupled result type.)
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
      /** Rough ±lines for a file-writing tool (mockup §01-4); absent when not computable. */
      readonly diffStat?: DiffStat;
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

/** The per-session context every ask carries (resolved once per session, not per entry). */
interface AskContext {
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly deviceName: string | null;
}

function permissionAsk(
  entry: Extract<TranscriptEntry, { kind: 'permission' }>,
  ctx: AskContext,
): InboxAsk | null {
  if (
    entry.decision !== 'pending' &&
    entry.decision !== 'approving' &&
    entry.decision !== 'rejecting'
  ) {
    return null;
  }
  return {
    kind: 'permission',
    ...ctx,
    requestId: entry.requestId,
    toolName: entry.toolName,
    input: entry.input,
    ...(entry.diffStat !== undefined ? { diffStat: entry.diffStat } : {}),
    decision: entry.decision,
    ...(entry.at !== undefined ? { askedAt: entry.at } : {}),
  };
}

function questionAsk(
  entry: Extract<TranscriptEntry, { kind: 'question' }>,
  ctx: AskContext,
): InboxAsk | null {
  if (entry.answer !== 'pending' && entry.answer !== 'answering') return null;
  return {
    kind: 'question',
    ...ctx,
    requestId: entry.requestId,
    prompt: entry.questions[0]?.question ?? 'The agent has a question for you.',
    ...(entry.at !== undefined ? { askedAt: entry.at } : {}),
  };
}

function handoverAsk(
  entry: Extract<TranscriptEntry, { kind: 'handover' }>,
  ctx: AskContext,
): InboxAsk | null {
  if (entry.state !== 'pending' && entry.state !== 'submitting') return null;
  return {
    kind: 'handover',
    ...ctx,
    requestId: entry.requestId,
    question: entry.question,
    ...(entry.at !== undefined ? { askedAt: entry.at } : {}),
  };
}

function askFor(entry: TranscriptEntry, ctx: AskContext): InboxAsk | null {
  switch (entry.kind) {
    case 'permission':
      return permissionAsk(entry, ctx);
    case 'question':
      return questionAsk(entry, ctx);
    case 'handover':
      return handoverAsk(entry, ctx);
    default:
      return null;
  }
}

export function buildInboxAsks(input: {
  readonly live: ReadonlyMap<string, SessionState>;
  readonly titleOf: (sessionId: string) => string | null;
  readonly deviceNameOf: (sessionId: string) => string | null;
}): InboxAsk[] {
  const asks: InboxAsk[] = [];
  for (const [sessionId, state] of input.live) {
    const ctx: AskContext = {
      sessionId,
      sessionTitle: pickDisplayTitle(input.titleOf(sessionId), firstRealPromptText(state.entries)),
      deviceName: input.deviceNameOf(sessionId),
    };
    for (const entry of state.entries) {
      const ask = askFor(entry, ctx);
      if (ask) asks.push(ask);
    }
  }
  // Waited-longest first; an unknown askedAt predates this page and sorts oldest.
  return asks.sort((a, b) => (a.askedAt ?? 0) - (b.askedAt ?? 0));
}
