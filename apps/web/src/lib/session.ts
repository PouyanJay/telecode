import {
  agentMessagePayloadSchema,
  agentPermissionRequestPayloadSchema,
  agentToolUsePayloadSchema,
  sessionEndedPayloadSchema,
  sessionHistoryPayloadSchema,
  type Envelope,
  type SessionStatusName,
} from '@telecode/protocol';

/**
 * Pure session-transcript reducer. The session lives on the laptop; the browser is a window onto it
 * (architecture invariant #7). This folds the relay's inbound frames into an append-only transcript +
 * a status, with no DOM or framework coupling so it can be unit-tested directly. The Svelte view holds
 * this in a `$state` and reassigns it on each frame.
 */
/** The wire session statuses plus the UI-only `idle` (no session launched yet on this device). */
export type SessionStatus = SessionStatusName | 'idle';

/** Lifecycle of one permission request as the human acts on it (verification-gated — never optimistic). */
export type DecisionState = 'pending' | 'approving' | 'rejecting' | 'approved' | 'rejected';

export type TranscriptEntry =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'message'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly kind: 'permission';
      readonly id: string;
      readonly requestId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
      readonly decision: DecisionState;
    };

export interface SessionState {
  readonly sessionId: string | null;
  readonly status: SessionStatus;
  readonly entries: readonly TranscriptEntry[];
  /** Monotonic counter for stable entry keys (keeps `{#each}` keyed without Math.random). */
  readonly seq: number;
}

export const initialSessionState: SessionState = {
  sessionId: null,
  status: 'idle',
  entries: [],
  seq: 0,
};

/** Reset to a fresh transcript when launching a new session (the relay assigns the next id). */
export function startingState(): SessionState {
  return { sessionId: null, status: 'starting', entries: [], seq: 0 };
}

/**
 * Any inbound frame proves the daemon has moved on, so an in-flight decision (`approving`/`rejecting`)
 * is now confirmed — flip it to its terminal state. This is the round-trip confirmation that keeps the
 * approve/reject gate honest rather than optimistic.
 */
function confirmInFlightDecisions(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.kind !== 'permission') return entry;
    if (entry.decision === 'approving') {
      changed = true;
      return { ...entry, decision: 'approved' as const };
    }
    if (entry.decision === 'rejecting') {
      changed = true;
      return { ...entry, decision: 'rejected' as const };
    }
    return entry;
  });
  return changed ? next : entries;
}

/**
 * When a session reaches a terminal state, any gate still awaiting a verdict can never be answered —
 * the daemon's `canUseTool` is no longer waiting. Close it so the Approve/Reject buttons disappear and a
 * late click can't strand on the daemon (which already settled the gate on interrupt/end). An unanswered
 * gate means the tool never ran, so it reads as rejected — matching the verdict the daemon records.
 */
function closeOpenGates(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.kind !== 'permission' || entry.decision !== 'pending') return entry;
    changed = true;
    return { ...entry, decision: 'rejected' as const };
  });
  return changed ? next : entries;
}

/** Fold one inbound relay frame into the session state. Unknown/invalid frames are ignored. */
export function applyEnvelope(state: SessionState, envelope: Envelope): SessionState {
  const entries = confirmInFlightDecisions(state.entries);
  const base = entries === state.entries ? state : { ...state, entries };

  switch (envelope.type) {
    case 'session.started':
      return {
        ...base,
        sessionId: envelope.session_id ?? base.sessionId,
        status: 'running',
      };

    case 'agent.message': {
      const parsed = agentMessagePayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return base;
      return {
        ...base,
        entries: [...base.entries, { kind: 'message', id: `e${base.seq}`, text: parsed.data.text }],
        seq: base.seq + 1,
      };
    }

    case 'agent.tool_use': {
      const parsed = agentToolUsePayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return base;
      return {
        ...base,
        entries: [
          ...base.entries,
          {
            kind: 'tool',
            id: `e${base.seq}`,
            toolName: parsed.data.toolName,
            input: parsed.data.input,
          },
        ],
        seq: base.seq + 1,
      };
    }

    case 'agent.permission_request': {
      const parsed = agentPermissionRequestPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return base;
      return {
        ...base,
        status: 'awaiting_input',
        entries: [
          ...base.entries,
          {
            kind: 'permission',
            id: `e${base.seq}`,
            requestId: parsed.data.requestId,
            toolName: parsed.data.toolName,
            input: parsed.data.input,
            decision: 'pending',
          },
        ],
        seq: base.seq + 1,
      };
    }

    case 'session.ended': {
      const parsed = sessionEndedPayloadSchema.safeParse(envelope.payload);
      return {
        ...base,
        status: parsed.success ? parsed.data.status : 'done',
        entries: closeOpenGates(base.entries),
      };
    }

    case 'session.history': {
      // Reopen = reconnect, not restart (invariant #7): the daemon backfills the whole transcript, so
      // reseed the state wholesale from it rather than appending. A resolved gate (`allow`/`deny`)
      // replays as decided (no action buttons); a still-open one stays `pending` and actionable.
      const parsed = sessionHistoryPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return base;
      const entries: TranscriptEntry[] = parsed.data.entries.map((entry, i) => {
        const id = `e${i}`;
        switch (entry.kind) {
          case 'user':
            return { kind: 'user', id, text: entry.text };
          case 'message':
            return { kind: 'message', id, text: entry.text };
          case 'tool':
            return { kind: 'tool', id, toolName: entry.toolName, input: entry.input };
          case 'permission':
            return {
              kind: 'permission',
              id,
              requestId: entry.requestId,
              toolName: entry.toolName,
              input: entry.input,
              decision:
                entry.decision === 'allow'
                  ? 'approved'
                  : entry.decision === 'deny'
                    ? 'rejected'
                    : 'pending',
            };
          default: {
            // Exhaustiveness: a new history-entry kind must be handled here (parse already rejects
            // unknown kinds at runtime, so this is unreachable).
            const _exhaustive: never = entry;
            return _exhaustive;
          }
        }
      });
      return {
        sessionId: envelope.session_id ?? base.sessionId,
        status: parsed.data.status,
        entries,
        seq: entries.length,
      };
    }

    default:
      return base;
  }
}

/** Append the human's own message (the launch prompt or a follow-up) to the transcript. */
export function appendUserMessage(state: SessionState, text: string): SessionState {
  return {
    ...state,
    entries: [...state.entries, { kind: 'user', id: `e${state.seq}`, text }],
    seq: state.seq + 1,
  };
}

/** Mark a permission request as decided locally (in-flight) the instant the human acts. */
export function markDeciding(
  state: SessionState,
  requestId: string,
  behavior: 'allow' | 'deny',
): SessionState {
  const decision: DecisionState = behavior === 'allow' ? 'approving' : 'rejecting';
  return {
    ...state,
    status: 'running',
    entries: state.entries.map((entry) =>
      entry.kind === 'permission' && entry.requestId === requestId ? { ...entry, decision } : entry,
    ),
  };
}

/** The permission request currently awaiting a human decision, if any. */
export function pendingPermission(state: SessionState): TranscriptEntry | undefined {
  return state.entries.find((entry) => entry.kind === 'permission' && entry.decision === 'pending');
}
