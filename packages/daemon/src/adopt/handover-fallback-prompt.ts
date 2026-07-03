/**
 * Build the seeded prompt for a free-form handover's FRESH-LAUNCH fallback (Journey 4). Preferred, telecode
 * resumes the adopted conversation directly (full context); but if that resume fails — the SDK can't pick up
 * an externally-created conversation (transcript gone, version skew) — the continuation runs as a brand-new
 * conversation instead. This prompt hands that fresh session the context it lost: a summary of where the
 * adopted session left off, the exact question it asked, and the user's answer — so it continues sensibly
 * rather than starting cold. `summary` may be empty (deterministic extraction found little); the question +
 * answer alone still orient the model.
 */
export function buildHandoverFallbackPrompt(
  summary: string,
  question: string,
  answerText: string,
): string {
  const lines = [
    'You are continuing a previous session that could not be resumed directly, so here is its context.',
  ];
  const trimmedSummary = summary.trim();
  if (trimmedSummary.length > 0) {
    lines.push('', 'Summary of the session so far:', trimmedSummary);
  }
  lines.push(
    '',
    'The last thing the session asked was:',
    question.trim(),
    '',
    "The user's answer:",
    answerText.trim(),
    '',
    'Continue the work from here, taking the answer into account.',
  );
  return lines.join('\n');
}
