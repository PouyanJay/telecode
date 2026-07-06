import type { RegistrySessionRow } from '../session-groups';

/**
 * A {@link RegistrySessionRow} with sensible defaults for cold-load / merge tests — override only the
 * fields a test cares about. Shared by the meta and title suites so the fixture shape lives once (both
 * exercise `RegistrySessionRow` the same way — sealed blobs decoded into their respective maps).
 */
export function buildRegistryRow(
  over: Partial<RegistrySessionRow> & { id: string },
): RegistrySessionRow {
  return {
    title: null,
    status: 'done',
    deviceId: 'd1',
    origin: 'launched',
    parentSessionId: null,
    createdAt: new Date('2026-07-01T10:00:00Z'),
    sealedMeta: null,
    sealedMetaNonce: null,
    sealedTitle: null,
    sealedTitleNonce: null,
    ...over,
  };
}
