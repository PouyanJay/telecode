import { open } from 'node:fs/promises';

import { type SessionHistoryEntry } from '@telecode/protocol';
import { pino, type Logger } from 'pino';

/**
 * The transcript mirror (architecture decision AD-1): the daemon reads the hook-provided `transcript_path`
 * of an adopted session — Claude Code's JSONL conversation log — and maps it into telecode transcript
 * entries to stream to the web. This is the one sanctioned read of `~/.claude/projects` (only the
 * hook-supplied path, only for adopted sessions, via the official hooks contract — never terminal-output
 * scraping, never for telecode-launched sessions).
 *
 * The format is version-dependent and undocumented, so parsing is DEFENSIVE: each line is parsed in
 * isolation and an unparseable/unknown record is skipped, never thrown — a Claude Code update or a
 * half-written line must not crash the session view. Confirmed record shapes (Phase 0 spike): `user` /
 * `assistant` records carry an Anthropic `message` (`role` + `content`); `content` blocks are
 * `text` / `thinking` / `tool_use` / `tool_result` / `image`; other record types are non-conversation.
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

function entriesFromRecord(record: Record<string, unknown>): SessionHistoryEntry[] {
  const message = isObject(record.message) ? record.message : undefined;
  if (!message) return [];

  if (record.type === 'assistant' && Array.isArray(message.content)) {
    const out: SessionHistoryEntry[] = [];
    for (const block of message.content) {
      if (!isObject(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        out.push({ kind: 'message', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        out.push({ kind: 'tool', toolName: block.name, input: asInput(block.input) });
      }
    }
    return out;
  }

  // A `user` record with `toolUseResult` is a tool output, not a prompt — skip it (the tool call itself
  // was already surfaced from the assistant record).
  if (record.type === 'user' && record.toolUseResult === undefined) {
    const text = textFromContent(message.content);
    if (text.length > 0) return [{ kind: 'user', text }];
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

export interface TranscriptMirror {
  /**
   * Read the transcript lines appended since the previous call and return their new entries. A partial
   * (newline-less) trailing line is left unconsumed until it completes. A missing file yields no entries.
   */
  sync(): Promise<SessionHistoryEntry[]>;
}

export interface TranscriptMirrorOptions {
  /** Absolute path to the adopted session's JSONL transcript (from the hook event). */
  readonly path: string;
  readonly logger?: Logger;
}

export function createTranscriptMirror(options: TranscriptMirrorOptions): TranscriptMirror {
  const log = options.logger ?? pino({ name: 'transcript-mirror' });
  // Bytes consumed up to and including the last complete line; we never re-emit them.
  let offset = 0;

  return {
    async sync(): Promise<SessionHistoryEntry[]> {
      let handle;
      try {
        handle = await open(options.path, 'r');
      } catch {
        return []; // not created yet (or gone) — nothing to mirror
      }
      try {
        const { size } = await handle.stat();
        if (size <= offset) return [];
        const length = size - offset;
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        const lastNewline = buffer.lastIndexOf(0x0a);
        if (lastNewline < 0) return []; // no complete line yet — wait for the terminator
        const complete = buffer.subarray(0, lastNewline).toString('utf8');
        offset += lastNewline + 1;
        return transcriptEntriesFrom(complete);
      } catch (err) {
        log.warn({ err }, 'transcript-mirror: failed to read transcript');
        return [];
      } finally {
        await handle.close();
      }
    },
  };
}
