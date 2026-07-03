/**
 * Does this end-of-turn assistant message look like a **free-form question** soliciting the user's input?
 *
 * Claude Code's `Stop` hook fires on EVERY turn end, so the free-form handover detector (Journey 4) uses
 * this to decide whether to offer a "continue here" card. It is deliberately a HEURISTIC: a false positive
 * only surfaces a *dismissible* card, never a wrong action (AD-J4-3), so it favours precision but tolerates
 * the occasional miss. The strongest signal is a message whose prose ends in a question mark; a short list
 * of high-precision solicitation cues adds recall for questions phrased without one. Fenced code blocks are
 * stripped first so a `?` inside a code sample never triggers, and empty / absurdly long messages are ignored.
 */

/** Upper bound: mirrors the wire cap on the handover question; a longer blob is not a concise question. */
const MAX_QUESTION_LENGTH = 8000;

/** High-precision cues for a question phrased without a trailing `?` (e.g. "Let me know which you prefer."). */
const SOLICITATION_CUES = [
  /\blet me know\b/i,
  /\bwhich (?:one|option|approach|would you)\b/i,
  /\bwould you (?:like|prefer|want)\b/i,
  /\bdo you want\b/i,
  /\bplease (?:confirm|choose|specify|clarify|let me know)\b/i,
  /\bhow would you like\b/i,
];

/** Prevents a `?` inside a fenced code block from being read as a question by the detector. */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/g, ' ');
}

export function isFreeFormQuestion(lastAssistantMessage: string | undefined): boolean {
  if (lastAssistantMessage === undefined) return false;
  const text = lastAssistantMessage.trim();
  if (text.length === 0 || text.length > MAX_QUESTION_LENGTH) return false;
  const prose = stripCodeBlocks(text).trim();
  if (prose.length === 0) return false;
  if (/\?["'”’)\]*_`]*\s*$/.test(prose)) return true;
  return SOLICITATION_CUES.some((cue) => cue.test(prose));
}
