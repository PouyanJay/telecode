import { describe, expect, it } from 'vitest';

import { resolveRelayUrl } from './relay-url';

/**
 * The daemon's relay URL resolution. Precedence: the `--relay-url` CLI flag overrides the
 * `TELECODE_RELAY_URL` env, which overrides the default. The default targets the hosted relay so a user who
 * runs `npx @telecode/cli` connects to the managed instance with no flags; a self-hoster points at their own
 * relay via `--relay-url` / `TELECODE_RELAY_URL` (local dev sets the env in `scripts/run.sh`). The resolved
 * value is validated as a ws/wss URL so a typo fails fast with a clear message instead of a cryptic socket
 * error.
 */
describe('resolveRelayUrl', () => {
  it('defaults to the hosted relay when no flag or env is set', () => {
    expect(resolveRelayUrl([], {})).toBe('wss://relay.telecode.io/ws');
  });

  it('uses TELECODE_RELAY_URL when set', () => {
    expect(resolveRelayUrl([], { TELECODE_RELAY_URL: 'wss://relay.example.com/ws' })).toBe(
      'wss://relay.example.com/ws',
    );
  });

  it('the --relay-url flag overrides the env (space-separated form)', () => {
    expect(
      resolveRelayUrl(['--relay-url', 'wss://flag.example.com/ws'], {
        TELECODE_RELAY_URL: 'wss://env.example.com/ws',
      }),
    ).toBe('wss://flag.example.com/ws');
  });

  it('accepts the --relay-url=value form', () => {
    expect(resolveRelayUrl(['--relay-url=wss://eq.example.com/ws'], {})).toBe(
      'wss://eq.example.com/ws',
    );
  });

  it('ignores unrelated args', () => {
    expect(resolveRelayUrl(['--other', 'x', '--relay-url', 'ws://1.2.3.4:9/ws'], {})).toBe(
      'ws://1.2.3.4:9/ws',
    );
  });

  it('rejects a non-ws(s) URL from either source', () => {
    expect(() => resolveRelayUrl(['--relay-url', 'https://relay.example.com'], {})).toThrow(
      /ws:\/\/ or wss:\/\//,
    );
    expect(() => resolveRelayUrl([], { TELECODE_RELAY_URL: 'not a url' })).toThrow();
  });

  it('rejects --relay-url with no value', () => {
    expect(() => resolveRelayUrl(['--relay-url'], {})).toThrow(/requires/);
    expect(() => resolveRelayUrl(['--relay-url='], {})).toThrow(/requires/);
  });
});
