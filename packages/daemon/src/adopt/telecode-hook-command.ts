/**
 * A hook entry is telecode's when its command invokes the `telecode hook` bridge — i.e. it mentions
 * `telecode` (the bin, `@telecode/cli`, or a `telecode.mjs` path) and then the `hook` subcommand. Used for
 * idempotent install and a clean uninstall, so we only ever touch entries telecode created.
 */
export function isTelecodeHookCommand(command: string): boolean {
  return /telecode\b[\s\S]*\bhook\b/.test(command);
}
