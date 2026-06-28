/**
 * Resolve the relay WebSocket URL the daemon dials out to. Precedence (highest first):
 *   1. the `--relay-url <url>` / `--relay-url=<url>` CLI flag,
 *   2. the `TELECODE_RELAY_URL` environment variable,
 *   3. the default — the hosted relay (`wss://relay.telecode.io/ws`).
 *
 * The default targets the managed instance so `npx telecode` connects with no configuration. Self-hosters
 * point at their own relay via the flag or env (local dev sets `TELECODE_RELAY_URL` in `scripts/run.sh`).
 * The result is validated as a `ws://`/`wss://` URL so a typo fails immediately with a clear message
 * instead of a cryptic socket error (and so the HTTP base derived from it stays well-formed).
 */
const DEFAULT_RELAY_URL = 'wss://relay.telecode.io/ws';
const FLAG = '--relay-url';

/** Read `--relay-url` from argv: `provided` distinguishes "absent" from "present with no value". */
function readFlag(argv: readonly string[]): { provided: boolean; value: string | undefined } {
  const index = argv.findIndex((arg) => arg === FLAG || arg.startsWith(`${FLAG}=`));
  if (index === -1) return { provided: false, value: undefined };
  const arg = argv[index] ?? '';
  if (arg.startsWith(`${FLAG}=`)) return { provided: true, value: arg.slice(FLAG.length + 1) };
  return { provided: true, value: argv[index + 1] };
}

export function resolveRelayUrl(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const flag = readFlag(argv);
  if (flag.provided && !flag.value) {
    throw new Error(`${FLAG} requires a ws:// or wss:// URL`);
  }
  const url = flag.value ?? env.TELECODE_RELAY_URL ?? DEFAULT_RELAY_URL;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid relay URL: ${url}`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`relay URL must be ws:// or wss:// (got ${url})`);
  }
  return url;
}
