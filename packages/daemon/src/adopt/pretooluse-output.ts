/** The PreToolUse decision telecode's gate returns: allow / deny (block) / ask (defer to the local prompt). */
export type HookPermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * Build the JSON Claude Code expects back from a `PreToolUse` hook. `ask` (or returning `{}`) defers to
 * Claude Code's own permission flow — the fail-closed default, since it never auto-allows. `deny` carries a
 * reason surfaced to the model (also the channel used to relay a question answer, Journey 2).
 */
export function preToolUseOutput(decision: HookPermissionDecision, reason?: string): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reason !== undefined ? { permissionDecisionReason: reason } : {}),
    },
  };
}
