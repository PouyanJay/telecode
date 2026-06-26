import type { Logger } from 'pino';

/**
 * Opt-in telemetry seam (Phase 5).
 *
 * telecode collects **nothing** by default — privacy is the product. This module exists so an operator of
 * a hosted relay *can* opt into aggregate operational metrics, while the default stays a no-op and the
 * events never carry user content or identifiers. There is deliberately **no network sink** in this
 * codebase: when enabled, events go to the operator's own logger (their own infrastructure), never to
 * telecode or any third party. Plugging in a real sink is the operator's choice, made explicitly.
 *
 * Events are aggregate only — a role, never a `user_id` / `device_id` / `channel`, never a prompt, payload,
 * or any session content. This keeps telemetry honest against the threat model's metadata caveat.
 */
export type TelemetryEvent =
  | { readonly name: 'peer_connected'; readonly role: 'daemon' | 'browser' }
  | { readonly name: 'peer_disconnected'; readonly role: 'daemon' | 'browser' };

/** Where opt-in events go. The default is the local logger; never a network/third-party destination. */
export type TelemetrySink = (event: TelemetryEvent) => void;

export interface Telemetry {
  /** Fire-and-forget: record an aggregate event. Must never throw into the caller's hot path. */
  record(event: TelemetryEvent): void;
}

export interface CreateTelemetryOptions {
  /** Opt-in switch. When false/absent the returned telemetry is a no-op (nothing is recorded). */
  readonly enabled?: boolean;
  /** Logger used by the default sink (events become structured log lines on the operator's own stack). */
  readonly logger?: Logger;
  /** Override the sink (mainly for tests). Still local — this codebase wires no network sink. */
  readonly sink?: TelemetrySink;
}

const NOOP: Telemetry = { record: () => undefined };

/**
 * Build the telemetry instance. Returns a no-op unless `enabled` is explicitly true — so the privacy
 * default is structural, not a config value someone can forget to set.
 */
export function createTelemetry(options: CreateTelemetryOptions = {}): Telemetry {
  if (!options.enabled) return NOOP;
  const sink: TelemetrySink =
    options.sink ?? ((event) => options.logger?.info({ telemetry: event }, 'telemetry'));
  return {
    record(event) {
      try {
        sink(event);
      } catch {
        // Telemetry is best-effort: a failing sink must never disrupt relay request handling.
      }
    },
  };
}
