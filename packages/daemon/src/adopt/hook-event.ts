import { z } from 'zod';

/**
 * The contract between Claude Code's hooks and telecode's adoption bridge. Claude Code writes this JSON to
 * the `telecode hook` command's stdin for every hook event (PreToolUse, Notification, SessionStart/End,
 * Stop). The bridge forwards it over the daemon's Unix socket; the daemon parses it here, at the trust
 * boundary, before correlating it to an adopted session.
 *
 * The shape is the subset telecode needs, confirmed empirically (Claude Code v2.1.x): a `PreToolUse` event
 * carries `tool_name` / `tool_input` / `tool_use_id` (the latter binds a gate request to the exact tool call);
 * `SessionStart` carries `source`; `SessionEnd` carries `reason`; `Notification` carries `message`; other
 * events omit them. Unknown fields are ignored (zod strips by default) so a Claude Code version that adds
 * fields doesn't break parsing.
 *
 * SECURITY BOUNDARY (adopted-takeover AD-7/AD-22): `UserPromptSubmit` events carry a `prompt` field
 * that is DELIBERATELY absent here — zod's strip mode drops it at this trust boundary, so the user's
 * prompt text is structurally never parsed, logged, or mirrored by the daemon (the transcript mirror
 * picks the turn up from the transcript file on its Stop instead). Do not "complete" the schema with
 * it.
 */
export const hookEventSchema = z.object({
  hook_event_name: z.string().min(1),
  session_id: z.string().min(1),
  /** Path to the session's JSONL transcript (used by the transcript mirror). */
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  /** PreToolUse: the tool the agent wants to run + its input + the unique id of this tool call. */
  tool_name: z.string().optional(),
  tool_input: z.record(z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  /** SessionStart: why the session started (`startup` / `resume` / `clear`). */
  source: z.string().optional(),
  /** SessionEnd: why the session ended (`clear` / `logout` / `other` / `prompt_input_exit`). */
  reason: z.string().optional(),
  /** Notification: the human-readable notification text (idle / needs-permission prompts). */
  message: z.string().optional(),
  /**
   * Stop (Journey 4): the assistant's final text for the just-ended turn, handed to us directly — so a
   * free-form question (prose, no tool call) needs no transcript parse to detect. The free-form handover
   * detector reads this verbatim.
   */
  last_assistant_message: z.string().optional(),
  /**
   * Stop: true when the stop is itself firing from within a Stop hook that continued the session — the
   * re-entrancy guard, so the handover detector never loops on its own continuation.
   */
  stop_hook_active: z.boolean().optional(),
});
export type HookEvent = z.infer<typeof hookEventSchema>;
