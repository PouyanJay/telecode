import { type SessionHistoryEntry } from '@telecode/protocol';

/**
 * Build a concise "what this session was doing" summary for a free-form handover (Journey 4), by
 * DETERMINISTIC extraction from the mirrored transcript — no extra model call (fast, private, zero cost;
 * AD-J4-2/Q2). Keeps only the conversational text turns (user prompts + assistant prose — tool calls,
 * permission gates, questions, and handovers are skipped), takes the most recent few, collapses whitespace,
 * truncates each, and bounds the total. Returns '' when there is nothing to summarize (the question + the
 * user's answer still carry the handover on their own). Never throws — a thin transcript just yields a thin
 * summary.
 */
const DEFAULT_MAX_ENTRIES = 6;
const DEFAULT_MAX_CHARS_PER_ENTRY = 300;
const DEFAULT_MAX_TOTAL_CHARS = 1500;

interface HandoverSummaryOptions {
  readonly maxEntries?: number;
  readonly maxCharsPerEntry?: number;
  readonly maxTotalChars?: number;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildHandoverSummary(
  entries: readonly SessionHistoryEntry[],
  options: HandoverSummaryOptions = {},
): string {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxCharsPerEntry = options.maxCharsPerEntry ?? DEFAULT_MAX_CHARS_PER_ENTRY;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  const textTurns = entries.filter(
    (e): e is Extract<SessionHistoryEntry, { kind: 'user' | 'message' }> =>
      e.kind === 'user' || e.kind === 'message',
  );
  const lines = textTurns
    .slice(-maxEntries)
    .map((e) => {
      const who = e.kind === 'user' ? 'User' : 'Assistant';
      const text = truncate(collapseWhitespace(e.text), maxCharsPerEntry);
      return text.length > 0 ? `${who}: ${text}` : '';
    })
    .filter((line) => line.length > 0);

  const summary = lines.join('\n');
  // Bound the total from the FRONT (keep the most recent context) when it overflows.
  return summary.length > maxTotalChars
    ? `…${summary.slice(summary.length - maxTotalChars)}`
    : summary;
}
