/**
 * Judge whether the executable path the background service would bake in is stable enough to survive.
 * `npx @telecode/cli` / `pnpm dlx` run from an ephemeral cache that the package manager garbage-collects,
 * so a service pinned to such a path silently breaks later. When we detect one, we return a hint telling
 * the user to install globally before enabling the service. Pure — the CLI decides how to surface it.
 */
interface ExecutableStability {
  /** True when the path looks like a durable install (global npm, homebrew, a project checkout). */
  readonly stable: boolean;
  /** Guidance to show when not stable; `null` when stable. */
  readonly hint: string | null;
}

// npm's npx cache lives under `.../_npx/<hash>/`; pnpm/yarn dlx use a `dlx-<hash>` temp directory.
const EPHEMERAL_CACHE = /[/\\](_npx|dlx-)/;

const EPHEMERAL_HINT =
  'note: telecode is running from a temporary npx/dlx cache — install it globally with ' +
  '`npm i -g @telecode/cli` before enabling the background service, or it will stop working ' +
  'once that cache is cleared.';

export function describeExecutableStability(binPath: string): ExecutableStability {
  return EPHEMERAL_CACHE.test(binPath)
    ? { stable: false, hint: EPHEMERAL_HINT }
    : { stable: true, hint: null };
}
