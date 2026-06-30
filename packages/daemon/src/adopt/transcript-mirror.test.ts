import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createTranscriptMirror, transcriptEntriesFrom } from './transcript-mirror';

const logger = pino({ level: 'silent' });

/**
 * The transcript mirror (Journey 1, Task 6; AD-1): parse the hook-provided JSONL transcript of an adopted
 * session into telecode transcript entries, and tail it incrementally. Defensive — a Claude Code version
 * change or a half-written line must never crash the session view.
 */
const USER = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'fix the bug' },
});
const ASSISTANT_TEXT = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
});
const ASSISTANT_TOOL = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ],
  },
});
// A tool RESULT arrives as a `user` record carrying `toolUseResult` — it's a tool output, not a prompt.
const TOOL_RESULT = JSON.stringify({
  type: 'user',
  toolUseResult: { stdout: 'a\nb' },
  message: { role: 'user', content: [{ type: 'tool_result', content: 'a\nb' }] },
});
const NON_CONVO = JSON.stringify({ type: 'file-history-snapshot', snapshot: {} });

describe('transcriptEntriesFrom', () => {
  it('maps user prompts, assistant text, and tool calls; skips thinking + non-conversation', () => {
    const jsonl = [USER, ASSISTANT_TEXT, ASSISTANT_TOOL, NON_CONVO].join('\n');
    expect(transcriptEntriesFrom(jsonl)).toEqual([
      { kind: 'user', text: 'fix the bug' },
      { kind: 'message', text: 'on it' },
      { kind: 'tool', toolName: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('skips a user record that is a tool result (not a prompt)', () => {
    expect(transcriptEntriesFrom(TOOL_RESULT)).toEqual([]);
  });

  it('skips malformed lines without throwing', () => {
    const jsonl = ['{not json', USER, '', '   ', '{"type":"user"}'].join('\n');
    expect(transcriptEntriesFrom(jsonl)).toEqual([{ kind: 'user', text: 'fix the bug' }]);
  });

  it('reads user content given as an array of text blocks', () => {
    const rec = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    });
    expect(transcriptEntriesFrom(rec)).toEqual([{ kind: 'user', text: 'do it' }]);
  });
});

describe('createTranscriptMirror.sync (incremental tail)', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns only entries appended since the previous sync', async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-transcript-'));
    const path = join(dir, 't.jsonl');
    await writeFile(path, `${USER}\n`);
    const mirror = createTranscriptMirror({ path, logger });

    expect(await mirror.sync()).toEqual([{ kind: 'user', text: 'fix the bug' }]);

    await appendFile(path, `${ASSISTANT_TEXT}\n`);
    expect(await mirror.sync()).toEqual([{ kind: 'message', text: 'on it' }]);

    // No new bytes → no new entries.
    expect(await mirror.sync()).toEqual([]);
  });

  it('does not consume a partial (newline-less) trailing line until it completes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-transcript-'));
    const path = join(dir, 't.jsonl');
    await writeFile(path, `${USER}\n${ASSISTANT_TEXT}`); // second line not yet terminated
    const mirror = createTranscriptMirror({ path, logger });

    expect(await mirror.sync()).toEqual([{ kind: 'user', text: 'fix the bug' }]);
    await appendFile(path, '\n'); // terminate the line
    expect(await mirror.sync()).toEqual([{ kind: 'message', text: 'on it' }]);
  });

  it('returns nothing for a missing file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-transcript-'));
    const mirror = createTranscriptMirror({ path: join(dir, 'missing.jsonl'), logger });
    expect(await mirror.sync()).toEqual([]);
  });
});
