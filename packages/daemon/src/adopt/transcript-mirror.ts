import { open } from 'node:fs/promises';

import { type SessionHistoryEntry } from '@telecode/protocol';
import { type Logger } from 'pino';

import { transcriptEntriesFrom } from './transcript-parse';

/**
 * The transcript mirror (architecture decision AD-1): the daemon reads the hook-provided `transcript_path`
 * of an adopted session — Claude Code's JSONL conversation log — and maps it into telecode transcript
 * entries to stream to the web. This is the one sanctioned read of `~/.claude/projects` (only the
 * hook-supplied path, only for adopted sessions, via the official hooks contract — never terminal-output
 * scraping, never for telecode-launched sessions). Defensive line parsing lives in {@link transcriptEntriesFrom}.
 */

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
  /** Injected at the composition root (the daemon's child logger) — never created here (TYPESCRIPT.md). */
  readonly logger: Logger;
}

export function createTranscriptMirror(options: TranscriptMirrorOptions): TranscriptMirror {
  const log = options.logger;
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
