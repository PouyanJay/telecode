/**
 * Build the seeded prompt for a takeover / resume-as-new FRESH-LAUNCH fallback on an ADOPTED parent
 * (adopted-takeover T3). Preferred, telecode fork-resumes the external conversation directly (full
 * context); but if that resume fails — the SDK can't pick up an externally-created conversation
 * (transcript gone, version skew) — the continuation runs as a brand-new conversation instead. This
 * prompt hands that fresh session the context it lost: a summary of where the adopted session left
 * off plus the user's instruction — so it continues sensibly rather than starting cold. The sibling
 * of `buildHandoverFallbackPrompt`, without the question/answer shape (a takeover has no question —
 * the instruction IS the next turn).
 */
export function buildTakeoverFallbackPrompt(summary: string, instruction: string): string {
  const lines = [
    'You are continuing a previous session that could not be resumed directly, so here is its context.',
  ];
  const trimmedSummary = summary.trim();
  if (trimmedSummary.length > 0) {
    lines.push('', 'Summary of the session so far:', trimmedSummary);
  }
  lines.push(
    '',
    "The user's next instruction:",
    instruction.trim(),
    '',
    'Continue the work from here, carrying out the instruction.',
  );
  return lines.join('\n');
}
