import {
  query,
  type HookCallback,
  type PermissionResult,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionModeName } from '@telecode/protocol';
import { pino, type Logger } from 'pino';

import {
  AgentRunError,
  type AgentAdapter,
  type AgentEndReason,
  type AgentRunOptions,
  type AgentRunResult,
  type PermissionRequest,
} from './agent-adapter';
import { classifyTool } from './permission-policy';

/**
 * The real {@link AgentAdapter} backed by the Claude Agent SDK. Maps the SDK's `canUseTool` callback
 * onto our {@link CanUseTool} contract and drives the session to completion. Requires
 * `ANTHROPIC_API_KEY` (or Claude Code auth) in the environment.
 */
export interface ClaudeAgentAdapterOptions {
  readonly permissionMode?: PermissionModeName;
  readonly allowedTools?: string[];
  readonly maxTurns?: number;
  readonly model?: string;
  /**
   * Which on-disk settings to load. Defaults to `[]` (none) so the daemon runs an isolated session
   * and never inherits the operator's personal Claude config — and so every tool actually routes
   * through `canUseTool` instead of being auto-allowed by ambient rules.
   */
  readonly settingSources?: SettingSource[];
  readonly logger?: Logger;
}

/**
 * The SDK's terminal `result` subtype in telecode's vocabulary. Anything that is neither a success nor
 * an explicit turn-limit ending is an execution error — unknown future subtypes fail safe as errors.
 */
function resolveEndReason(subtype: string): AgentEndReason {
  if (subtype === 'success') return 'completed';
  if (subtype === 'error_max_turns') return 'turn_limit';
  return 'execution_error';
}

/**
 * The SDK's turn-cap wording in its THROWN form (see {@link isThrownTurnCap}). Kept as a named
 * constant so an SDK upgrade that rewords the message has one obvious place to re-sync — the graceful
 * form is `resolveEndReason`'s `error_max_turns` case, and the regression guard is
 * claude-agent-adapter.result.test.ts ("recovers a THROWN turn-cap error…").
 */
const TURN_CAP_MESSAGE_MARKER = 'maximum number of turns';

/**
 * A runaway safety net, NOT a task budget: real work routinely needs dozens of turns (the old
 * default of 4 starved every substantial run). Hitting the net settles as the followable
 * `turn_limit` — a follow-up message continues the same conversation.
 */
const DEFAULT_MAX_TURNS_SAFETY_NET = 100;

/**
 * Whether a thrown stream error is the SDK's turn-cap ending. Some SDK versions THROW
 * "Claude Code returned an error result: Reached maximum number of turns (N)" from the message
 * iterator instead of yielding a `result: error_max_turns` — surfacing that as a run failure turned
 * the designed, followable "ENDED · TURN LIMIT" into FAILED (and misfired the resume fallback).
 * Message-text detection is the only handle the SDK gives for the thrown form.
 */
function isThrownTurnCap(err: unknown): boolean {
  return err instanceof Error && err.message.includes(TURN_CAP_MESSAGE_MARKER);
}

/** The SDK types a tool block's `input` as `unknown`; narrow it to an object instead of casting blindly. */
function toToolInput(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function createClaudeAgentAdapter(options: ClaudeAgentAdapterOptions = {}): AgentAdapter {
  const log = options.logger ?? pino({ name: 'claude-agent-adapter' });

  return {
    async run(
      prompt: string,
      { canUseTool, onEvent, resume, forkSession, cwd, signal, permissionMode }: AgentRunOptions,
    ): Promise<AgentRunResult> {
      const intercepted: PermissionRequest[] = [];
      const allowed: string[] = [];
      const denied: string[] = [];
      let sessionId: string | undefined;
      let endReason: AgentEndReason | undefined;
      let model: string | undefined;

      // The session's mode drives both the SDK and telecode's own gate. `bypassPermissions` is never honored
      // (telecode never surrenders the approval gate), so it is clamped to `default` for the SDK below.
      const sessionMode: PermissionModeName = permissionMode ?? options.permissionMode ?? 'default';

      const sdkCanUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
      ): Promise<PermissionResult> => {
        const request: PermissionRequest = { toolName, input };
        intercepted.push(request);
        const decision = await canUseTool(request);
        if (decision.behavior === 'allow') {
          allowed.push(toolName);
          return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
        }
        denied.push(toolName);
        return { behavior: 'deny', message: decision.message };
      };

      // THE approval-gate fix: in the SDK's `default` mode an internal classifier silently auto-allows tools
      // it deems "safe" (reads, some bash) WITHOUT ever calling `canUseTool` — which let consequential
      // commands run before the operator approved them. A `PreToolUse` hook fires for EVERY tool (it runs
      // before, and bypasses, the classifier), so we force telecode's own policy here: read-only tools
      // auto-run; everything consequential is elevated to `ask`, which routes to `sdkCanUseTool` above and
      // therefore to the browser. The gate is telecode's, not the SDK's (architecture invariant #4).
      const preToolUseGate: HookCallback = async (hookEvent) => {
        if (hookEvent.hook_event_name !== 'PreToolUse') return {};
        const decision = classifyTool(hookEvent.tool_name, sessionMode);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason:
              decision === 'allow'
                ? 'telecode: read-only tool auto-approved'
                : 'telecode: forwarded to the operator for approval',
          },
        };
      };

      // Bridge our AbortSignal onto the SDK's AbortController so an interrupt/end aborts the query.
      const abortController = new AbortController();
      if (signal) {
        if (signal.aborted) abortController.abort();
        else signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }

      const session = query({
        prompt,
        options: {
          canUseTool: sdkCanUseTool,
          hooks: { PreToolUse: [{ hooks: [preToolUseGate] }] },
          // Drive the SDK with the session's mode (so `plan` plans and `acceptEdits` accepts), but never
          // `bypassPermissions` — telecode's gate stays in force regardless.
          permissionMode: sessionMode === 'bypassPermissions' ? 'default' : sessionMode,
          maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS_SAFETY_NET,
          settingSources: options.settingSources ?? [],
          abortController,
          // Run in the session's worktree so parallel agents never clobber each other's files.
          ...(cwd ? { cwd } : {}),
          ...(resume ? { resume } : {}),
          // Fork the resumed conversation (free-form handover): a new SDK session id + its own transcript,
          // so taking over an adopted session never writes into the still-live external process's transcript.
          ...(resume && forkSession ? { forkSession: true } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
        },
      });

      try {
        for await (const message of session) {
          // Capture the conversation id (to resume) + the model (for the session's sealed metadata,
          // ux Phase 6 T5) from the init message.
          if (message.type === 'system' && message.subtype === 'init') {
            sessionId = message.session_id;
            if (typeof message.model === 'string') model = message.model;
          }
          // The terminal result is the ONLY place a turn-limit ending is distinguishable from a clean
          // finish (the iterator just ends either way) — surface it so the daemon reports honestly.
          if (message.type === 'result') {
            endReason = resolveEndReason(message.subtype);
          }
          // Map SDK assistant messages onto our streamed event contract. canUseTool above records
          // every interception; tool_use blocks here are the (allowed) tools the agent actually ran.
          if (message.type === 'assistant') {
            for (const block of message.message.content) {
              if (block.type === 'text') {
                onEvent({ type: 'message', text: block.text });
              } else if (block.type === 'tool_use') {
                onEvent({
                  type: 'tool_use',
                  toolName: block.name,
                  input: toToolInput(block.input),
                });
              }
            }
          }
          log.debug({ type: message.type }, 'agent message');
        }
      } catch (err) {
        // An operator interrupt/end aborts the query mid-stream. Return what we have (notably the
        // captured conversation id) so the daemon ends the turn cleanly and the session can still be
        // resumed — rather than surfacing the abort as a run failure.
        if (signal?.aborted) {
          log.debug({ sessionId }, 'agent session aborted (interrupt/end)');
        } else if (isThrownTurnCap(err)) {
          // The THROWN form of the turn cap (see isThrownTurnCap): recover it as the graceful
          // turn_limit ending, keeping the captured conversation id so a follow-up resumes it.
          endReason = 'turn_limit';
          log.warn({ sessionId }, 'agent turn budget exhausted — settled as turn_limit');
        } else {
          // A genuine failure: tell the daemon whether the conversation had STARTED (a resume that
          // got past init must never fall back to a context-losing fresh launch) and hand it the
          // started id so a follow-up can still resume the conversation.
          throw new AgentRunError(err instanceof Error ? err.message : 'agent run failed', {
            cause: err,
            hasConversationStarted: sessionId !== undefined,
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
        }
      }

      log.debug(
        { intercepted: intercepted.length, sessionId, endReason },
        'agent session complete',
      );
      return {
        intercepted,
        allowed,
        denied,
        ...(sessionId ? { sessionId } : {}),
        ...(endReason ? { endReason } : {}),
        ...(model ? { model } : {}),
      };
    },
  };
}
