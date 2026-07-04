/**
 * A human-readable detail for a caught exception (an `Error` message, or `String()` of anything else).
 * Shared by the service managers so a filesystem/OS error surfaces as a clean `ServiceActionResult`
 * message rather than an unhandled rejection — the caught-exception analogue of `commandDetail`.
 */
export function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
