/**
 * Whether a "user" transcript text is actually machinery injected by the coding agent's own harness
 * (command caveats, slash-command markers, system reminders) rather than something the human typed.
 * Title derivation and first-prompt fallbacks skip these — a session must never be named
 * "<local-command-caveat>Caveat: The messages below…". Shared by the daemon (sealed-title
 * derivation) and the web (display fallbacks) so the two can never disagree on what counts as a
 * real prompt. Deliberately a KNOWN-TAG list, not "starts with <": a human pasting XML/HTML is
 * still a real prompt.
 */
const INJECTED_PROMPT_TAGS = [
  'local-command-caveat',
  'command-name',
  'command-message',
  'command-args',
  'command-contents',
  'system-reminder',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'user-memory-input',
  'task-notification',
] as const;

// The tag name must END at the match (`>`, whitespace, or `/`) — "<command-name-extra>" is an
// unknown tag, not a prefix hit on `command-name`.
const INJECTED_PROMPT_TAG = new RegExp(`^<(?:${INJECTED_PROMPT_TAGS.join('|')})(?=[\\s/>])`, 'i');

export function isInjectedPrompt(text: string): boolean {
  return INJECTED_PROMPT_TAG.test(text.trimStart());
}

/**
 * The first prompt a human actually typed in a transcript: the first `user` entry whose text is not
 * {@link isInjectedPrompt} machinery (tightly-coupled sibling — the classifier and its canonical
 * consumer change together). Structurally typed over the entry shape so the daemon's and the web's
 * transcript unions both fit without cross-package type imports.
 */
export function firstRealPromptText(
  entries: ReadonlyArray<{ readonly kind: string; readonly text?: string }>,
): string | undefined {
  const entry = entries.find(
    (e) => e.kind === 'user' && typeof e.text === 'string' && !isInjectedPrompt(e.text),
  );
  return entry?.text;
}
