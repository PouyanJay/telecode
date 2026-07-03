/**
 * Does this end-of-turn assistant message look like a **free-form question** soliciting the user's input?
 *
 * Claude Code's `Stop` hook fires on EVERY turn end, so the free-form handover detector (Journey 4) uses
 * this to decide whether to offer a "continue here" card. It is deliberately a HEURISTIC: a false positive
 * only surfaces a *dismissible* card, never a wrong action (AD-J4-3), so it errs toward offering. The
 * walking skeleton treats a message that ends in a question mark as the signal; Journey 4 T3 refines it
 * (interrogative lead-ins, length bounds, ignoring code blocks, etc.).
 */
export function isFreeFormQuestion(lastAssistantMessage: string | undefined): boolean {
  if (lastAssistantMessage === undefined) return false;
  const trimmed = lastAssistantMessage.trim();
  if (trimmed.length === 0) return false;
  return trimmed.endsWith('?');
}
