/**
 * Split one agent-message frame into renderable segments (Phase 4 T10): prose, inline code, and fenced
 * code blocks. Pure and line-based so it has no DOM coupling and is unit-tested directly. Fences are
 * matched on their own line (the common, robust case); an unclosed fence — which a streamed message can
 * produce mid-flight — resolves to a code block through end of input rather than leaking backticks into
 * the prose. Only code constructs are parsed; all other markdown stays as plain text by design.
 */

/** One renderable slice of an agent message. */
export type MessageSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'inline-code'; readonly text: string }
  | { readonly kind: 'code'; readonly code: string; readonly language: string };

const FENCE_OPEN = /^```([^\n`]*)$/;
const CLOSING_FENCE = '```';
const INLINE_CODE = /`([^`\n]+)`/g;

/** Push a prose chunk, breaking out inline `code` spans. Empty chunks contribute nothing. */
function pushProse(segments: MessageSegment[], text: string): void {
  if (text === '') return;
  let last = 0;
  INLINE_CODE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_CODE.exec(text)) !== null) {
    if (match.index > last) segments.push({ kind: 'text', text: text.slice(last, match.index) });
    segments.push({ kind: 'inline-code', text: match[1]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
}

/** Fold an agent message into ordered {@link MessageSegment}s. */
export function parseMessageContent(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const lines = text.split('\n');
  let proseStart = 0;
  let i = 0;

  const flushProse = (end: number): void => {
    if (end > proseStart) pushProse(segments, lines.slice(proseStart, end).join('\n'));
  };

  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]!);
    if (open) {
      flushProse(i);
      const language = open[1]!.trim();
      const codeStart = i + 1;
      let j = codeStart;
      while (j < lines.length && lines[j]!.trim() !== CLOSING_FENCE) j++;
      segments.push({ kind: 'code', code: lines.slice(codeStart, j).join('\n'), language });
      // Skip the closing fence when present; an unclosed fence already consumed to end of input.
      i = j < lines.length ? j + 1 : j;
      proseStart = i;
    } else {
      i++;
    }
  }
  flushProse(lines.length);
  return segments;
}
