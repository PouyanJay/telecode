import { z } from 'zod';

/**
 * The contract between Claude Code's hooks and telecode's adoption bridge. Claude Code writes this JSON to
 * the `telecode hook` command's stdin for every hook event (PreToolUse, Notification, SessionStart/End,
 * Stop). The bridge forwards it over the daemon's Unix socket; the daemon parses it here, at the trust
 * boundary, before correlating it to an adopted session.
 *
 * The shape is the subset telecode needs, confirmed empirically in the Phase 0 spike (Claude Code v2.1.x):
 * a `PreToolUse` event carries `tool_name` / `tool_input` / `tool_use_id` (the latter binds a gate request
 * to the exact tool call); other events omit them. Unknown fields are ignored (zod strips by default) so a
 * Claude Code version that adds fields doesn't break parsing.
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
});
export type HookEvent = z.infer<typeof hookEventSchema>;
