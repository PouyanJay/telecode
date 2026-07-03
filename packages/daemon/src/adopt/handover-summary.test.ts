import { type SessionHistoryEntry } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { buildHandoverSummary } from './handover-summary';

/**
 * The deterministic handover summary (Journey 4): a concise "what the session was doing" blob extracted from
 * the mirrored transcript — no model call. Keeps recent user/assistant text turns; skips tool/gate entries.
 */
describe('buildHandoverSummary', () => {
  it('summarizes recent user + assistant text turns, labelled', () => {
    const entries: SessionHistoryEntry[] = [
      { kind: 'user', text: 'Add a REST API for orders.' },
      { kind: 'message', text: 'I scaffolded the routes and a service layer.' },
    ];
    const summary = buildHandoverSummary(entries);
    expect(summary).toContain('User: Add a REST API for orders.');
    expect(summary).toContain('Assistant: I scaffolded the routes and a service layer.');
  });

  it('skips tool calls, permission gates, questions, and handovers', () => {
    const entries: SessionHistoryEntry[] = [
      { kind: 'user', text: 'do it' },
      { kind: 'tool', toolName: 'Write', input: { path: 'x' } },
      { kind: 'permission', requestId: 'r', toolName: 'Bash', input: {}, decision: 'allow' },
      { kind: 'message', text: 'done' },
    ];
    const summary = buildHandoverSummary(entries);
    expect(summary).not.toContain('Write');
    expect(summary).not.toContain('Bash');
    expect(summary.split('\n')).toEqual(['User: do it', 'Assistant: done']);
  });

  it('keeps only the most recent entries (maxEntries)', () => {
    const entries: SessionHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'message' as const,
      text: `line ${i}`,
    }));
    const summary = buildHandoverSummary(entries, { maxEntries: 3 });
    expect(summary).toBe('Assistant: line 7\nAssistant: line 8\nAssistant: line 9');
  });

  it('collapses whitespace and truncates a long turn', () => {
    const entries: SessionHistoryEntry[] = [
      { kind: 'user', text: `line one\n\n   line two\t\tend ${'x'.repeat(400)}` },
    ];
    const summary = buildHandoverSummary(entries, { maxCharsPerEntry: 20 });
    // Whitespace collapsed to single spaces; the turn text truncated to 20 chars + an ellipsis.
    expect(summary).toBe('User: line one line two en…');
  });

  it('returns an empty string for a transcript with no text turns', () => {
    expect(buildHandoverSummary([])).toBe('');
    expect(buildHandoverSummary([{ kind: 'tool', toolName: 'Read', input: {} }])).toBe('');
  });
});
