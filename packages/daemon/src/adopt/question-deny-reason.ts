import { type AgentQuestionItem, type QuestionAnswerItem } from '@telecode/protocol';

/**
 * Build the `permissionDecisionReason` the daemon returns to deny an adopted session's `AskUserQuestion`,
 * carrying the human's remote pick back to the model (the deny-feedback channel — AD-4, spike-proven). The
 * framing matters: it reads as a *relayed user answer to that question*, never an injected instruction — the
 * spike showed the model adopts a relayed answer but is rightly suspicious of an out-of-band command. Each
 * answer maps positionally to its question; selected labels and any "Other" free text are joined per question.
 */
export function buildQuestionDenyReason(
  questions: readonly AgentQuestionItem[],
  answers: readonly QuestionAnswerItem[],
): string {
  const lines = questions.map((question, index) => {
    const answer = answers[index];
    const parts = [
      ...(answer?.selectedLabels ?? []),
      ...(answer?.otherText !== undefined ? [answer.otherText] : []),
    ];
    const choice = parts.length > 0 ? parts.join(', ') : '(no answer)';
    return `- "${question.header}": ${choice}`;
  });
  return [
    '[Answer relayed from the user via telecode]',
    'The user reviewed your question remotely and answered:',
    ...lines,
    'Proceed using these answers; do not ask again.',
  ].join('\n');
}
