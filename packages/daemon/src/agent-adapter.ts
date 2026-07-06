import type { PermissionModeName } from '@telecode/protocol';

/**
 * The seam that isolates the agent runtime from the rest of the daemon. Architecture invariant:
 * the Claude Agent SDK is used behind this one interface (never CLI scraping), so SDK churn touches
 * a single file and a future adapter for another coding agent slots in cleanly.
 *
 * Two load-bearing pieces:
 *  - `canUseTool`: every tool the agent wants to run is routed through it for an allow/deny decision.
 *    In the product the daemon forwards that request to the browser (the human-in-the-loop gate).
 *  - `onEvent`: streamed agent activity (assistant text, tool calls) the daemon relays up to the web
 *    as it happens. Streaming is telecode's default, not an edge case.
 */

export interface PermissionRequest {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type CanUseTool = (request: PermissionRequest) => Promise<PermissionDecision>;

/** A streamed unit of agent activity. */
export type AgentEvent =
  | { readonly type: 'message'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    };

export interface AgentRunOptions {
  readonly canUseTool: CanUseTool;
  readonly onEvent: (event: AgentEvent) => void;
  /**
   * Resume a prior agent conversation for a follow-up turn (from {@link AgentRunResult.sessionId} of an
   * earlier run). Omitted on the first turn of a session.
   */
  readonly resume?: string;
  /**
   * Fork the resumed conversation instead of continuing it in place (Journey 4 free-form handover). With
   * `resume` set, `forkSession: true` makes the SDK branch a NEW conversation (new id, own transcript) that
   * inherits the resumed context — so telecode can take over an adopted session by resuming its `session_id`
   * without writing into the still-live external process's transcript. Ignored without `resume`.
   */
  readonly forkSession?: boolean;
  /**
   * Working directory the agent runs in — the session's git worktree (Phase 2). Omitted falls back to
   * the daemon's own cwd. The daemon derives this path; it is never taken from an untrusted client.
   */
  readonly cwd?: string;
  /**
   * Aborts the in-flight turn (Task 9 interrupt/end). When it fires, the adapter stops the run promptly;
   * the daemon treats an aborted run as an interrupted turn, not an error.
   */
  readonly signal?: AbortSignal;
  /**
   * The session's permission mode (chosen by the operator at launch). The real adapter applies it both to
   * the SDK `query()` and to the per-tool gate it forces every tool through, so a session can be `plan`-only
   * or auto-accept edits without weakening the approval gate. Omitted falls back to the conservative `default`.
   */
  readonly permissionMode?: PermissionModeName;
}

/**
 * How a run's final turn settled, from the SDK's terminal `result` message (ux Phase 6 status split):
 * `completed` = a clean finish; `turn_limit` = the turn budget ran out mid-task (followable — resuming
 * continues the same conversation); `execution_error` = the SDK reported an internal failure without
 * throwing. Distinguishable ONLY here — the message iterator simply ends in all three cases.
 */
export type AgentEndReason = 'completed' | 'turn_limit' | 'execution_error';

export interface AgentRunResult {
  /** Every tool request that passed through `canUseTool`, in order. */
  readonly intercepted: PermissionRequest[];
  readonly allowed: string[];
  readonly denied: string[];
  /** The agent conversation id to {@link AgentRunOptions.resume} for the next (follow-up) turn. */
  readonly sessionId?: string;
  /** Absent when the stream ended without a terminal result (abort, old SDK) — treated as completed. */
  readonly endReason?: AgentEndReason;
  /** The model the SDK ran (from its `system/init`, ux Phase 6 T5) — surfaced in the session's metadata. */
  readonly model?: string;
}

export interface AgentAdapter {
  run(prompt: string, options: AgentRunOptions): Promise<AgentRunResult>;
}

/** Test hooks for {@link createFakeAgentAdapter}. */
export interface FakeAgentAdapterOptions {
  /** The conversation id every run reports (so the daemon can thread `resume` across turns). */
  readonly sessionId?: string;
  /** Invoked once per `run` with the turn's prompt + the resume id / forkSession flag / cwd it was called with. */
  readonly onRun?: (call: {
    prompt: string;
    resume?: string;
    forkSession?: boolean;
    cwd?: string;
  }) => void;
  /** The terminal reason every run reports (simulates the SDK's `result` subtype; default none). */
  readonly endReason?: AgentEndReason;
  /** The model every run reports (simulates the SDK's `system/init` model, ux Phase 6 T5; default none). */
  readonly model?: string;
}

/**
 * Deterministic adapter for tests/CI: replays a fixed script of events, with no model call. Messages
 * stream straight through `onEvent`; tool_use events are gated through `canUseTool` first and only
 * streamed when allowed — proving both the streaming and the allow/deny contracts the real adapter honors.
 */
export function createFakeAgentAdapter(
  events: AgentEvent[],
  options: FakeAgentAdapterOptions = {},
): AgentAdapter {
  const sessionId = options.sessionId ?? 'fake-session';
  return {
    async run(
      prompt: string,
      { canUseTool, onEvent, resume, forkSession, cwd }: AgentRunOptions,
    ): Promise<AgentRunResult> {
      options.onRun?.({
        prompt,
        ...(resume !== undefined ? { resume } : {}),
        ...(forkSession !== undefined ? { forkSession } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
      const intercepted: PermissionRequest[] = [];
      const allowed: string[] = [];
      const denied: string[] = [];
      for (const event of events) {
        if (event.type === 'message') {
          onEvent(event);
          continue;
        }
        const request: PermissionRequest = { toolName: event.toolName, input: event.input };
        intercepted.push(request);
        const decision = await canUseTool(request);
        if (decision.behavior === 'allow') {
          allowed.push(event.toolName);
          onEvent({
            type: 'tool_use',
            toolName: event.toolName,
            input: decision.updatedInput ?? event.input,
          });
        } else {
          denied.push(event.toolName);
        }
      }
      return {
        intercepted,
        allowed,
        denied,
        sessionId,
        ...(options.endReason !== undefined ? { endReason: options.endReason } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
      };
    },
  };
}
