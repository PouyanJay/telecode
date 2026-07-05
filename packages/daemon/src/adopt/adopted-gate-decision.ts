import { permissionModeSchema } from '@telecode/protocol';

import { classifyTool } from '../permission-policy';

/**
 * How telecode's adopted-session gate should treat one PreToolUse tool call, given the LIVE permission
 * mode Claude Code reports for that session. An adopted session runs in the mode the user chose in their
 * own Claude Code, so telecode MIRRORS it — it must never be stricter than the local session already is,
 * or it would freeze a session the user is driving locally on a remote approval they never meant to give
 * (the failure that hung an adopted Bypass-mode session on every tool). This is the deliberate opposite of
 * a telecode-*launched* session, where telecode is the safety boundary and never surrenders the gate.
 *
 *  - `'defer'`  the local mode never prompts (`bypassPermissions` / `auto` / `dontAsk`): return no opinion
 *               and let Claude Code's own mode run the tool — bypass runs it, auto safety-checks it,
 *               dontAsk applies its allowlist. telecode must NOT blanket-allow here, which would skip those
 *               local checks.
 *  - `'allow'`  a gating mode, but this tool auto-runs locally anyway (read-only, or an edit under
 *               `acceptEdits`): telecode approves it without a human round-trip.
 *  - `'gate'`   a gating mode and a consequential tool the local session WOULD prompt for: telecode holds
 *               it for the operator's remote decision (its approval value-add).
 *
 * An absent or unrecognized mode fails safe to `default` (gate consequential) — never an optimistic defer.
 */
export type AdoptedGateDecision = 'defer' | 'allow' | 'gate';

/** Modes in which Claude Code never prompts for a consequential tool — telecode defers to them wholesale. */
const NON_GATING_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'auto', 'dontAsk']);

export function adoptedGateDecision(
  toolName: string,
  rawMode: string | undefined,
): AdoptedGateDecision {
  if (rawMode !== undefined && NON_GATING_MODES.has(rawMode)) return 'defer';
  // Everything else is keyed off the modes telecode's own policy models; an unknown or absent mode fails
  // safe to `default` (gate consequential — never an optimistic defer on uncertainty).
  const parsed = permissionModeSchema.safeParse(rawMode);
  const mode = parsed.success ? parsed.data : 'default';
  return classifyTool(toolName, mode) === 'allow' ? 'allow' : 'gate';
}
