/**
 * A small, pure, offline syntax highlighter (Phase 4 T10). The PWA must work offline and stay light, so
 * this is a hand-rolled position-scanning lexer rather than Shiki/WASM. It is deliberately restrained —
 * a few muted token classes, in keeping with the instrument house style (the accent is a scalpel, never a
 * syntax color) — and it is **lossless**: concatenating every token's text reproduces the input exactly,
 * so the renderer can wrap tokens in spans without ever dropping or reordering a character.
 */

/** The token classes the renderer colors (mapped to `--syntax-*` tokens). */
export type HighlightTokenType =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'punctuation'
  | 'plain';

/** One classified slice of source text. */
export interface HighlightToken {
  readonly type: HighlightTokenType;
  readonly text: string;
}

/** The languages this highlighter knows; anything else is `plain` (rendered uncolored). */
export type HighlightLanguage = 'ts' | 'js' | 'json' | 'bash' | 'plain';

/** An ordered lexer rule. `re` must be sticky (`y`) and never match the empty string. */
interface Rule {
  readonly type: HighlightTokenType | 'identifier';
  readonly re: RegExp;
}

const JS_KEYWORDS = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'keyof',
  'let',
  'namespace',
  'new',
  'null',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'void',
  'while',
  'yield',
]);

const BASH_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'return',
  'select',
  'echo',
  'cd',
  'export',
  'local',
  'set',
  'unset',
  'source',
  'read',
]);

const JSON_KEYWORDS = new Set(['true', 'false', 'null']);

const JS_RULES: readonly Rule[] = [
  { type: 'comment', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
  { type: 'string', re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/y },
  { type: 'number', re: /0[xX][0-9a-fA-F]+|0[bB][01]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/y },
  { type: 'identifier', re: /[A-Za-z_$][\w$]*/y },
  { type: 'punctuation', re: /[{}()[\].,;:?=+\-*/%<>!&|^~@]/y },
];

const JSON_RULES: readonly Rule[] = [
  { type: 'string', re: /"(?:\\.|[^"\\\n])*"/y },
  { type: 'number', re: /-?\d[\d]*(?:\.\d+)?(?:[eE][+-]?\d+)?/y },
  { type: 'identifier', re: /[A-Za-z_]\w*/y },
  { type: 'punctuation', re: /[{}[\]:,]/y },
];

const BASH_RULES: readonly Rule[] = [
  { type: 'comment', re: /#[^\n]*/y },
  { type: 'string', re: /"(?:\\.|[^"\\])*"|'[^']*'/y },
  { type: 'keyword', re: /\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?]/y },
  { type: 'number', re: /\d+/y },
  { type: 'identifier', re: /[A-Za-z_][\w-]*/y },
  { type: 'punctuation', re: /[{}()[\];|&<>=]/y },
];

function rulesFor(
  language: HighlightLanguage,
): { rules: readonly Rule[]; keywords: Set<string> } | null {
  switch (language) {
    case 'ts':
    case 'js':
      return { rules: JS_RULES, keywords: JS_KEYWORDS };
    case 'json':
      return { rules: JSON_RULES, keywords: JSON_KEYWORDS };
    case 'bash':
      return { rules: BASH_RULES, keywords: BASH_KEYWORDS };
    case 'plain':
      return null;
    default: {
      const _exhaustive: never = language;
      return _exhaustive;
    }
  }
}

/**
 * Match the first applicable rule at `pos`. Returns the consumed length and the resolved token type — an
 * `identifier` rule resolves to `keyword` or `plain` by the keyword set. A null type means no rule matched
 * (the caller advances one character as plain).
 */
function matchRuleAt(
  code: string,
  pos: number,
  spec: { rules: readonly Rule[]; keywords: Set<string> },
): { consumed: number; type: HighlightTokenType | null } {
  for (const rule of spec.rules) {
    rule.re.lastIndex = pos;
    const match = rule.re.exec(code);
    if (match && match[0].length > 0) {
      const type =
        rule.type === 'identifier'
          ? spec.keywords.has(match[0])
            ? 'keyword'
            : 'plain'
          : rule.type;
      return { consumed: match[0].length, type };
    }
  }
  return { consumed: 0, type: null };
}

/**
 * Tokenize `code` for `language`. Scans left to right: at each position the first matching rule consumes
 * its match; an unmatched character (whitespace, punctuation the grammar ignores) becomes plain. Adjacent
 * plain slices are coalesced so the DOM stays lean. `plain` (or an empty string) returns a single token.
 */
export function highlight(code: string, language: HighlightLanguage): HighlightToken[] {
  const spec = rulesFor(language);
  if (code === '') return [];
  if (!spec) return [{ type: 'plain', text: code }];

  const tokens: HighlightToken[] = [];
  let plainStart = -1;
  let pos = 0;
  const flushPlain = (end: number): void => {
    if (plainStart >= 0) {
      tokens.push({ type: 'plain', text: code.slice(plainStart, end) });
      plainStart = -1;
    }
  };

  while (pos < code.length) {
    const { consumed, type } = matchRuleAt(code, pos, spec);
    if (type !== null && type !== 'plain') {
      flushPlain(pos);
      tokens.push({ type, text: code.slice(pos, pos + consumed) });
      pos += consumed;
    } else {
      // Unmatched, or an identifier that resolved to a plain word: extend the current plain run.
      if (plainStart < 0) plainStart = pos;
      pos += consumed > 0 ? consumed : 1;
    }
  }
  flushPlain(pos);
  return tokens;
}

const EXTENSION_LANGUAGE: Record<string, HighlightLanguage> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
};

/** Pick a highlight language from a file path's extension (used by the diff viewer). */
export function languageFromPath(path: string): HighlightLanguage {
  const ext = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : '';
  return EXTENSION_LANGUAGE[ext] ?? 'plain';
}

const HINT_LANGUAGE: Record<string, HighlightLanguage> = {
  ts: 'ts',
  typescript: 'ts',
  tsx: 'ts',
  js: 'js',
  javascript: 'js',
  jsx: 'js',
  node: 'js',
  json: 'json',
  jsonc: 'json',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
};

/** Normalize a fenced-code-block language hint (```ts) to a highlight language. */
export function toHighlightLanguage(hint: string | undefined): HighlightLanguage {
  if (!hint) return 'plain';
  return HINT_LANGUAGE[hint.trim().toLowerCase()] ?? 'plain';
}
