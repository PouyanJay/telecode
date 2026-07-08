import type { PermissionModeName } from '@telecode/protocol';

/**
 * Telecode's tool-approval policy — the single source of truth for whether a tool the agent wants to run
 * may proceed automatically (`allow`) or must be forwarded to the human for a decision (`ask`).
 *
 * This is deliberately telecode's own policy, NOT the Agent SDK's. In the SDK's `default` mode an internal
 * classifier silently auto-allows tools it deems "safe" (reads, some bash) without ever invoking
 * `canUseTool` — which would let consequential commands run on the user's machine before the operator sees
 * them, breaking the approval gate that is telecode's safety boundary (architecture invariant #4). So the
 * adapter forces EVERY tool through this policy (a `PreToolUse` hook), and the daemon's gate applies it
 * again — the relay/browser only ever see the calls this function classifies as `ask`.
 *
 * `mode` is the session's permission mode (chosen at launch):
 *  - `plan` / `default`  → only read-only tools auto-run; every consequential tool asks.
 *  - `acceptEdits`       → file-edit tools also auto-run; bash, network, and the rest still ask.
 *  - `bypassPermissions` → everything auto-runs. The operator EXPLICITLY surrendered the gate when
 *    they picked this mode at launch (it is never the shipped default — invariant #4's conservative
 *    default holds; this is the same trade Claude Code's own bypass mode offers). The one exception
 *    is `AskUserQuestion`: a question is a request FOR the human — bypassing it answers nothing.
 *
 * Anything not on an allowlist asks — unknown/new tools fail safe (toward a human decision).
 */

/**
 * Tools with no consequential side effect on the user's machine — auto-approved in every mode. These
 * neither write the user's files, nor execute commands, nor reach the network: `Read`/`Glob`/`Grep`/
 * `NotebookRead` only read; `TodoWrite` updates the agent's own in-session task list (it does not touch the
 * filesystem or run anything — its `Write` suffix is about the todo list, not the user's code).
 */
const AUTO_APPROVED_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'TodoWrite',
]);

/** File-mutation tools auto-approved only under `acceptEdits` (they still write to the user's worktree). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function classifyTool(toolName: string, mode: PermissionModeName): 'allow' | 'ask' {
  if (AUTO_APPROVED_TOOLS.has(toolName)) return 'allow';
  if (mode === 'bypassPermissions') return toolName === 'AskUserQuestion' ? 'ask' : 'allow';
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return 'allow';
  return 'ask';
}
