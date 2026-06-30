import { createConnection } from 'node:net';

/**
 * The `telecode hook` bridge: the tiny command Claude Code spawns for each hook event (configured in
 * `~/.claude/settings.json`). It pipes the hook JSON Claude writes to stdin → the daemon's Unix socket →
 * the daemon's decision → stdout (which Claude reads). The daemon does all parsing + the gate round-trip;
 * the bridge is deliberately dumb so it stays fast (it runs once per tool call).
 *
 * FAIL-CLOSED (AD-2): if the daemon is unreachable (not running, socket gone) or anything errors, the
 * bridge writes `{}` — "no decision" — so Claude Code falls back to its OWN permission flow (a local
 * prompt for a consequential tool). It never auto-allows and never blocks the session on a dead daemon.
 * Only the *connect* is bounded by a timeout; once connected the daemon may block as long as a human
 * decision takes (the hook's own `timeout` in settings.json bounds the whole call).
 */
export interface HookBridgeIo {
  readonly socketPath: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  /** Bound on establishing the socket connection (not the response wait). Default 5s. */
  readonly connectTimeoutMs?: number;
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function roundTrip(socketPath: string, request: string, connectTimeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let out = '';
    const timer = setTimeout(
      () => client.destroy(new Error('hook bridge: connect timed out')),
      connectTimeoutMs,
    );
    client.once('connect', () => {
      clearTimeout(timer); // connected — the response wait is unbounded (the hook timeout bounds it)
      client.end(request);
    });
    client.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    client.once('end', () => resolve(out));
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Run one bridge round-trip. Always resolves (fail-closed); returns the process exit code (always 0). */
export async function runHookBridge(io: HookBridgeIo): Promise<number> {
  const request = await readAll(io.input);
  let response: string;
  try {
    response = await roundTrip(io.socketPath, request, io.connectTimeoutMs ?? 5000);
  } catch {
    response = ''; // daemon unreachable — fail closed below
  }
  io.output.write(response.length > 0 ? response : '{}');
  return 0;
}
