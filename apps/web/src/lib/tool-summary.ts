/**
 * Condense a tool call into a one-line summary for a collapsed tool-log row (Phase 4 T11) — the salient
 * argument (a file path, a command, a search pattern), whitespace-collapsed so it never wraps. Pure, so
 * it is unit-tested directly and the disclosure component stays a thin renderer.
 */

/** The most informative input key per well-known tool. */
const SUMMARY_KEY: Record<string, string> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  NotebookRead: 'notebook_path',
  Bash: 'command',
  Grep: 'pattern',
  Glob: 'pattern',
  LS: 'path',
  WebFetch: 'url',
  WebSearch: 'query',
  Task: 'description',
};

/** Tried in order for any tool whose specific key is absent (or that is not yet known). */
const FALLBACK_KEYS = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description'];

/** The salient argument of a tool call as a single collapsed line, or `''` when nothing stands out. */
export function summarizeTool(toolName: string, input: Record<string, unknown>): string {
  const preferred = SUMMARY_KEY[toolName];
  const keys = preferred ? [preferred, ...FALLBACK_KEYS] : FALLBACK_KEYS;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      const collapsed = value.replace(/\s+/g, ' ').trim();
      if (collapsed !== '') return collapsed;
    }
  }
  return '';
}
