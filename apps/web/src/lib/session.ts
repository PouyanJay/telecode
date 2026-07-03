import {
  agentHandoverPayloadSchema,
  agentMessagePayloadSchema,
  agentNoticePayloadSchema,
  agentPermissionRequestPayloadSchema,
  agentQuestionPayloadSchema,
  agentToolUsePayloadSchema,
  sessionEndedPayloadSchema,
  sessionHistoryPayloadSchema,
  type AgentQuestionItem,
  type Envelope,
  type QuestionAnswerItem,
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

/**
 * Lifecycle of an adopted-session question (Journey 2): `pending` awaits the human; `answering` is the
 * verification-gated in-flight state (confirmed on the daemon's next frame, never optimistic — like a
 * permission); `answered` is delivered; `closed` is a question the session ended before answering (the
 * picker disappears, honestly unanswered — telecode couldn't relay it). Answering is best-effort (AD-4).
 */
export type AnswerState = 'pending' | 'answering' | 'answered' | 'closed';

/**
 * Lifecycle of a free-form handover offer (Journey 4): `pending` shows the actionable "continue here" card;
 * `submitting` is the verification-gated in-flight state after the user takes it over; `submitted` is
 * confirmed (a forked continuation was launched — the parent session then ends); `closed` is an offer the
 * session ended before the user took it up (the card disappears, honestly not taken over).
 */
export type HandoverState = 'pending' | 'submitting' | 'submitted' | 'closed';

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
    }
  | {
      readonly kind: 'question';
      readonly id: string;
      readonly requestId: string;
      readonly questions: readonly AgentQuestionItem[];
      readonly answer: AnswerState;
      /** The human's pick(s), one per question — present once answering/answered. */
      readonly answers?: readonly QuestionAnswerItem[];
    }
  | {
      readonly kind: 'handover';
      readonly id: string;
      readonly requestId: string;
      /** The exact free-form question the adopted session ended its turn on. */
      readonly question: string;
      /** Deterministic handover summary of recent context (may be empty). */
      readonly summary: string;
      readonly state: HandoverState;
      /** The user's free-text answer — present once they took it over (submitting/submitted). */
      readonly answerText?: string;
      /** The forked continuation this handover launched — present once the daemon registered it (link target). */
      readonly childSessionId?: string;
    };

export interface SessionState {
  readonly sessionId: string | null;
  readonly status: SessionStatus;
  readonly entries: readonly TranscriptEntry[];
  /** Monotonic counter for stable entry keys (keeps `{#each}` keyed without Math.random). */
  readonly seq: number;
  /**
   * A transient "needs attention" cue from an adopted session's `Notification` (e.g. it went idle waiting
   * for input). Holds Claude Code's notification text while it stands; cleared the moment any other frame
   * arrives (the session moved on). Non-blocking — distinct from the `awaiting_input` gate (Journey 3).
   */
  readonly notice: string | null;
  /**
   * The adopted session this one continues (free-form handover, Journey 4), or null when unchained. Set
   * from the daemon's `session.chained` for a forked continuation, so the child can link back to its parent.
   */
  readonly parentSessionId: string | null;
}

export const initialSessionState: SessionState = {
  sessionId: null,
  status: 'idle',
  entries: [],
  seq: 0,
  notice: null,
  parentSessionId: null,
};

/** Reset to a fresh transcript when launching a new session (the relay assigns the next id). */
export function startingState(): SessionState {
  return {
    sessionId: null,
    status: 'starting',
    entries: [],
    seq: 0,
    notice: null,
    parentSessionId: null,
  };
}

/**
 * Any inbound frame proves the daemon has moved on, so an in-flight action — a permission decision
 * (`approving`/`rejecting`) or a question answer (`answering`) — is now confirmed; flip it to its terminal
 * state. This is the round-trip confirmation that keeps the gate/picker honest rather than optimistic.
 */
function confirmInFlightActions(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.kind === 'permission') {
      if (entry.decision === 'approving') {
        changed = true;
        return { ...entry, decision: 'approved' as const };
      }
      if (entry.decision === 'rejecting') {
        changed = true;
        return { ...entry, decision: 'rejected' as const };
      }
      return entry;
    }
    if (entry.kind === 'question' && entry.answer === 'answering') {
      changed = true;
      return { ...entry, answer: 'answered' as const };
    }
    if (entry.kind === 'handover' && entry.state === 'submitting') {
      changed = true;
      return { ...entry, state: 'submitted' as const };
    }
    return entry;
  });
  return changed ? next : entries;
}

/**
 * When a session reaches a terminal state, any gate or question still awaiting the human can never be
 * answered — the daemon is no longer waiting. Close them so the action controls disappear and a late click
 * can't strand. An unanswered permission means the tool never ran, so it reads as rejected (matching the
 * daemon's recorded verdict); an unanswered question is `closed` (the picker disappears, honestly unanswered).
 */
function closeOpenGates(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.kind === 'permission' && entry.decision === 'pending') {
      changed = true;
      return { ...entry, decision: 'rejected' as const };
    }
    if (entry.kind === 'question' && (entry.answer === 'pending' || entry.answer === 'answering')) {
      changed = true;
      return { ...entry, answer: 'closed' as const };
    }
    // A handover the user never took over (the session ended some other way) closes — the card disappears.
    // A `submitting` one was already confirmed to `submitted` by confirmInFlightActions before this runs.
    if (entry.kind === 'handover' && entry.state === 'pending') {
      changed = true;
      return { ...entry, state: 'closed' as const };
    }
    return entry;
  });
  return changed ? next : entries;
}

/** Fold one inbound relay frame into the session state. Unknown/invalid frames are ignored. */
export function applyEnvelope(state: SessionState, envelope: Envelope): SessionState {
  const entries = confirmInFlightActions(state.entries);
  // A notice is a one-shot cue; any frame other than `agent.notice` means the session moved on → clear it.
  const notice = envelope.type === 'agent.notice' ? state.notice : null;
  const base =
    entries === state.entries && notice === state.notice ? state : { ...state, entries, notice };

  switch (envelope.type) {
    case 'agent.notice': {
      const parsed = agentNoticePayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return base;
      return { ...base, notice: parsed.data.message };
    }

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

    case 'agent.question': {
      // An adopted session's AskUserQuestion (Journey 2): park at awaiting_input and surface the picker.
      const parsed = agentQuestionPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return base;
      return {
        ...base,
        status: 'awaiting_input',
        entries: [
          ...base.entries,
          {
            kind: 'question',
            id: `e${base.seq}`,
            requestId: parsed.data.requestId,
            questions: parsed.data.questions,
            answer: 'pending',
          },
        ],
        seq: base.seq + 1,
      };
    }

    case 'agent.handover': {
      // A free-form handover offer (Journey 4): an adopted session ended its turn asking a free-form
      // question. Park at awaiting_input and surface the actionable "continue here" card.
      const parsed = agentHandoverPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return base;
      return {
        ...base,
        status: 'awaiting_input',
        entries: [
          ...base.entries,
          {
            kind: 'handover',
            id: `e${base.seq}`,
            requestId: parsed.data.requestId,
            question: parsed.data.question,
            summary: parsed.data.summary,
            state: 'pending',
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
      // Guard: an EMPTY backfill means the daemon no longer holds this session (it restarted, or a
      // different daemon process answered) and replied `offline_paused` with no entries. Never let that
      // wipe a transcript we already have — that is exactly the "finished session went blank on reconnect"
      // bug. Keep our entries; keep a terminal status (a done session stays DONE, not OFFLINE), but let an
      // in-flight session adopt the backfilled status so it can honestly show offline.
      if (parsed.data.entries.length === 0 && base.entries.length > 0) {
        const terminal = base.status === 'done' || base.status === 'error';
        return {
          ...base,
          sessionId: envelope.session_id ?? base.sessionId,
          status: terminal ? base.status : parsed.data.status,
        };
      }
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
          case 'question':
            // A backfilled question replays as decided (answered, no picker) when it carries answers, or
            // still-open (pending, actionable) otherwise — the same decided-vs-pending split as a permission.
            return {
              kind: 'question',
              id,
              requestId: entry.requestId,
              questions: entry.questions,
              answer: entry.answers !== undefined ? 'answered' : 'pending',
              ...(entry.answers !== undefined ? { answers: entry.answers } : {}),
            };
          case 'handover':
            // A backfilled handover replays as submitted (taken over) when it carries the user's answerText,
            // or still-open (pending, actionable) otherwise — the same decided-vs-pending split.
            return {
              kind: 'handover',
              id,
              requestId: entry.requestId,
              question: entry.question,
              summary: entry.summary,
              state: entry.answerText !== undefined ? 'submitted' : 'pending',
              ...(entry.answerText !== undefined ? { answerText: entry.answerText } : {}),
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
        notice: null, // a backfilled reopen carries no live notice
        parentSessionId: base.parentSessionId,
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

/**
 * Mark a question as answered locally (in-flight) the instant the human submits, carrying their pick(s).
 * Verification-gated like {@link markDeciding}: it shows `answering` and only confirms to `answered` on the
 * daemon's next frame. Resuming the session optimistically (status → running) matches the daemon flow.
 */
export function markAnswering(
  state: SessionState,
  requestId: string,
  answers: readonly QuestionAnswerItem[],
): SessionState {
  return {
    ...state,
    status: 'running',
    entries: state.entries.map((entry) =>
      entry.kind === 'question' && entry.requestId === requestId
        ? { ...entry, answer: 'answering', answers }
        : entry,
    ),
  };
}

/** The question currently awaiting a human answer, if any. */
export function pendingQuestion(state: SessionState): TranscriptEntry | undefined {
  return state.entries.find((entry) => entry.kind === 'question' && entry.answer === 'pending');
}

/**
 * Mark a free-form handover as being taken over locally (in-flight) the instant the user submits their
 * answer, carrying it. Verification-gated like {@link markAnswering}: it shows `submitting` and confirms to
 * `submitted` on the daemon's next frame (the parent session then ends — the conversation migrates to the
 * forked continuation). Status is left at `awaiting_input` until that terminal frame — the parent is being
 * superseded, not resumed, so it should not optimistically read as `running`.
 */
export function markHandoverSubmitting(
  state: SessionState,
  requestId: string,
  answerText: string,
): SessionState {
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.kind === 'handover' && entry.requestId === requestId
        ? { ...entry, state: 'submitting', answerText }
        : entry,
    ),
  };
}

/** The free-form handover currently awaiting the user, if any. */
export function pendingHandover(state: SessionState): TranscriptEntry | undefined {
  return state.entries.find((entry) => entry.kind === 'handover' && entry.state === 'pending');
}

/**
 * Link a handover to the forked continuation the daemon just registered (its `session.chained`), so the
 * card can offer a "view the continuation" link. Sets `childSessionId` on the most recent taken-over
 * handover (submitting/submitted) that doesn't already have one — a handover leads to exactly one child.
 */
export function linkHandoverChild(state: SessionState, childSessionId: string): SessionState {
  let linked = false;
  const entries = [...state.entries].reverse().map((entry) => {
    if (
      !linked &&
      entry.kind === 'handover' &&
      entry.childSessionId === undefined &&
      (entry.state === 'submitting' || entry.state === 'submitted')
    ) {
      linked = true;
      return { ...entry, childSessionId };
    }
    return entry;
  });
  return linked ? { ...state, entries: entries.reverse() } : state;
}
