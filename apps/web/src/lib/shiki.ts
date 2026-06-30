import type { Highlighter, ThemeRegistrationRaw } from 'shiki';

/**
 * Shiki (VS-Code-grade) syntax highlighting for agent-message code blocks, themed to telecode's own
 * `--syntax-*` palette so highlighting matches the rest of the instrument UI rather than a stock theme. The
 * highlighter is a lazy singleton: `shiki` (and its Oniguruma WASM + per-language grammars) is dynamically
 * imported on first use, so it never weighs down the initial bundle or the SSR path — code renders plain
 * until it resolves, then upgrades (see MessageBody). The container (background, hairline border) is styled
 * with tokens in the consuming component; this theme only colors the tokens.
 */
export const MARKDOWN_THEME = 'telecode-dark';

// Scope → color, using the exact dark `--syntax-*` values from packages/ui/src/tokens.css.
const TELECODE_DARK_THEME: ThemeRegistrationRaw = {
  name: MARKDOWN_THEME,
  type: 'dark',
  colors: { 'editor.background': '#0f1115', 'editor.foreground': '#e9ebee' },
  settings: [
    { settings: { foreground: '#e9ebee', background: '#0f1115' } },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: '#838d99', fontStyle: 'italic' },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.control',
        'keyword.operator',
        'variable.language',
        'support.type.primitive',
        'entity.name.tag',
        'entity.name.function',
        'support.function',
      ],
      settings: { foreground: '#c191d6' },
    },
    {
      scope: [
        'string',
        'string.quoted',
        'string.template',
        'constant.character',
        'punctuation.definition.string',
        'entity.other.attribute-name',
      ],
      settings: { foreground: '#9ab87f' },
    },
    {
      scope: [
        'constant.numeric',
        'constant.language',
        'constant.character.escape',
        'support.constant',
        'entity.name.type',
        'support.type',
        'support.class',
        'entity.name.class',
      ],
      settings: { foreground: '#6cb6b0' },
    },
    {
      scope: [
        'punctuation',
        'meta.brace',
        'punctuation.separator',
        'punctuation.terminator',
        'meta.delimiter',
      ],
      settings: { foreground: '#8a909b' },
    },
  ],
};

// Curated languages a coding agent is likely to emit; unknown languages fall back to plain text.
const HIGHLIGHTED_LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'python',
  'bash',
  'shell',
  'yaml',
  'html',
  'css',
  'markdown',
  'sql',
  'rust',
  'go',
  'diff',
  'dockerfile',
  'toml',
];

let highlighterPromise: Promise<Highlighter> | null = null;

/** Resolve the shared highlighter (created once). The import is dynamic so Shiki loads only in the browser. */
export function getMarkdownHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= (async () => {
    const { createHighlighter } = await import('shiki');
    return createHighlighter({ themes: [TELECODE_DARK_THEME], langs: HIGHLIGHTED_LANGUAGES });
  })().catch((err: unknown) => {
    // A transient failure (WASM/grammar load) shouldn't permanently disable highlighting — allow a retry.
    highlighterPromise = null;
    throw err;
  });
  return highlighterPromise;
}
