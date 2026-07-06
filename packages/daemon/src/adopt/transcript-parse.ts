import { type SessionHistoryEntry } from '@telecode/protocol';

/**
 * Defensive parsing of an adopted session's Claude Code JSONL transcript (architecture decision AD-1) into
 * telecode transcript entries. The format is version-dependent and undocumented, so each line is parsed in
 * isolation and an unparseable/unknown record is skipped, never thrown — a Claude Code update or a
 * half-written line must not crash the session view. Confirmed record shapes (Phase 0 spike): `user` /
 * `assistant` records carry an Anthropic `message` (`role` + `content`); `content` blocks are
 * `text` / `thinking` / `tool_use` / `tool_result` / `image`; other record types are non-conversation.
 *
 * The {@link createTranscriptMirror} reader (sibling file) tails the file and feeds chunks through here.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asInput(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

/** Extract human-readable text from a message `content` that may be a string or an array of blocks. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { text: string } =>
        isObject(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

/**
 * The record's own creation time as an epoch-ms `ts` fragment, from the JSONL `timestamp` (ISO 8601).
 * Spread onto each entry the record yields so mirrored terminal-segment entries carry their REAL times
 * (Phase 3 lineage). Absent/unparseable → `{}` — an unknown time is left unknown, never invented.
 */
function tsFromRecord(record: Record<string, unknown>): { ts?: number } {
  if (typeof record.timestamp !== 'string') return {};
  const parsed = Date.parse(record.timestamp);
  return Number.isFinite(parsed) && parsed >= 0 ? { ts: parsed } : {};
}

function entriesFromRecord(record: Record<string, unknown>): SessionHistoryEntry[] {
  const message = isObject(record.message) ? record.message : undefined;
  if (!message) return [];
  const ts = tsFromRecord(record);

  if (record.type === 'assistant' && Array.isArray(message.content)) {
    const out: SessionHistoryEntry[] = [];
    for (const block of message.content) {
      if (!isObject(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        out.push({ kind: 'message', text: block.text, ...ts });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        out.push({ kind: 'tool', toolName: block.name, input: asInput(block.input), ...ts });
      }
    }
    return out;
  }

  // A `user` record with `toolUseResult` is a tool output, not a prompt — skip it (the tool call itself
  // was already surfaced from the assistant record).
  if (record.type === 'user' && record.toolUseResult === undefined) {
    const text = textFromContent(message.content);
    if (text.length > 0) return [{ kind: 'user', text, ...ts }];
  }
  return [];
}

/** Parse a chunk of transcript JSONL into telecode transcript entries, skipping anything unrecognized. */
export function transcriptEntriesFrom(jsonl: string): SessionHistoryEntry[] {
  const entries: SessionHistoryEntry[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // a malformed/half-written line — skip, never throw
    }
    if (isObject(record)) entries.push(...entriesFromRecord(record));
  }
  return entries;
}
