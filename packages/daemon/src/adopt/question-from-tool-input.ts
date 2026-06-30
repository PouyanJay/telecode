import { agentQuestionItemSchema, type AgentQuestionItem } from '@telecode/protocol';
import { z } from 'zod';

/**
 * Map a Claude Code `AskUserQuestion` tool input (from a `PreToolUse` hook) into telecode's wire questions.
 * The hook input is untrusted and version-dependent, so it is validated defensively: the shape is the wire
 * {@link agentQuestionItemSchema} (reusing its caps), but `multiSelect` is tolerated as optional and
 * defaulted to `false` so an older/newer Claude Code that omits it still parses. Anything that doesn't fit
 * (no `questions`, empty options, over-cap) yields `undefined`, and the caller fails closed (defers to the
 * local picker) — telecode never invents a question it couldn't parse.
 */
const toolInputSchema = z.object({
  questions: z
    .array(agentQuestionItemSchema.extend({ multiSelect: z.boolean().optional().default(false) }))
    .min(1)
    .max(10),
});

export function questionsFromToolInput(
  toolInput: Record<string, unknown> | undefined,
): AgentQuestionItem[] | undefined {
  if (toolInput === undefined) return undefined;
  const parsed = toolInputSchema.safeParse(toolInput);
  return parsed.success ? parsed.data.questions : undefined;
}
