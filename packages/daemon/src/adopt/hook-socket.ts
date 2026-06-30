import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import { type Logger } from 'pino';

import { hookEventSchema, type HookEvent } from './hook-event';

/**
 * The hook IPC server (architecture invariant #1: outbound-only — nothing reaches *into* the laptop). The
 * `telecode hook` bridge that Claude Code spawns connects to a **Unix domain socket** (never a TCP port),
 * writes one hook-event JSON, and half-closes; this server parses it at the trust boundary, runs the
 * injected handler (which correlates it to an adopted session and routes it through telecode's gate), and
 * writes the handler's response back. The socket lives under the user's run dir, `0600` (same-uid only),
 * so no other local user can inject a fake approval or read session activity.
 *
 * Transport only — the gate/correlation logic is injected as `handle` (composition root in `main.ts`), so
 * this stays substitutable and unit-testable. Factory + its two contract types are tightly-coupled siblings.
 */
export interface HookSocketServer {
  /** Bind the Unix socket (run dir `0700`, socket `0600`) and start accepting hook events. */
  start(): Promise<void>;
  /** Stop accepting connections and remove the socket file. */
  stop(): Promise<void>;
}

export interface HookSocketOptions {
  /** Absolute path to the Unix socket (e.g. `~/.telecode/run/hook.sock`); the run dir is created `0700`. */
  readonly socketPath: string;
  /**
   * Handle one parsed hook event and resolve with the object to write back to the bridge (which prints it
   * to Claude Code). May block for as long as a human decision takes — the bridge's hook `timeout` bounds it.
   */
  readonly handle: (event: HookEvent) => Promise<unknown>;
  /** Injected at the composition root (the daemon's child logger) — never created here (TYPESCRIPT.md). */
  readonly logger: Logger;
}

export function createHookSocketServer(options: HookSocketOptions): HookSocketServer {
  const log = options.logger;
  const { socketPath } = options;
  let server: Server | undefined;
  // Track live connections so stop() can force-close any whose handler is still blocked on a human
  // decision — otherwise server.close() would wait on them forever and the daemon couldn't shut down.
  const connections = new Set<Socket>();

  function onConnection(socket: Socket): void {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', (err) => log.warn({ err }, 'hook-socket: connection error'));
    // The bridge sends one request then half-closes (FIN); read until then, then reply on the still-open
    // write half. Fail-closed by construction: any parse/handler failure returns `{}` (no decision), which
    // makes Claude Code fall back to its own permission flow — it never auto-allows a consequential tool.
    socket.once('end', () => {
      void respond(socket, Buffer.concat(chunks).toString());
    });
  }

  async function respond(socket: Socket, raw: string): Promise<void> {
    let response: unknown = {};
    try {
      const parsed = hookEventSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        response = await options.handle(parsed.data);
      } else {
        log.warn('hook-socket: dropped malformed hook event');
      }
    } catch (err) {
      log.warn({ err }, 'hook-socket: error handling hook event');
    }
    socket.end(JSON.stringify(response));
  }

  return {
    async start(): Promise<void> {
      const runDir = dirname(socketPath);
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      // Tighten the dir even if it pre-existed with a looser mode (mkdir's mode only applies on creation).
      await chmod(runDir, 0o700);
      // Clear a stale socket from a prior run; a *live* one makes listen() throw EADDRINUSE (another daemon).
      await rm(socketPath, { force: true });
      // allowHalfOpen: the bridge half-closes after sending its request; we must keep the write half open to
      // reply. Without it Node auto-ends the socket on the client FIN and the response is dropped.
      const listening = createServer({ allowHalfOpen: true }, (socket) => onConnection(socket));
      await new Promise<void>((resolve, reject) => {
        listening.once('error', reject);
        listening.listen(socketPath, () => resolve());
      });
      await chmod(socketPath, 0o600);
      server = listening;
      log.info('hook-socket: listening for adopted-session hooks');
    },

    async stop(): Promise<void> {
      const listening = server;
      server = undefined;
      if (listening) {
        // Force-close any in-flight connection first (a handler may still be blocked on a human decision),
        // then close the server — otherwise server.close() would await those connections indefinitely.
        for (const socket of connections) socket.destroy();
        connections.clear();
        await new Promise<void>((resolve) => listening.close(() => resolve()));
      }
      await rm(socketPath, { force: true });
    },
  };
}
