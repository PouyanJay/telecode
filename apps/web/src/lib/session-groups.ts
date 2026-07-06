import {
  firstRealPromptText,
  isInjectedPrompt,
  type SessionMetaPayload,
  type SessionOrigin,
  type SessionStatusName,
} from '@telecode/protocol';

import type { SessionState, SessionStatus } from './session';

/**
 * The dashboard presentation layer: how the session list is bucketed, ordered, and tallied. Kept apart
 * from the live frame reducer (`sessions.ts`) so each file owns one concern. Pure and unit-tested.
 *
 * One dashboard row: a persisted-registry session overlaid with live status, plus the watching device's
 * display name for the row meta. Built in the page from `data.sessions` + the live session map.
 */
export interface SessionRow {
  readonly id: string;
  readonly title: string | null;
  readonly status: SessionStatus;
  /** The device the session runs on — the registry row's, or the live routing map's (ux Phase 5). */
  readonly deviceId: string | null;
  readonly deviceName: string | null;
  /** `external` rows are adopted from the user's own Claude Code runs; the dashboard marks them. */
  readonly origin: SessionOrigin;
  /**
   * True when this session is a forked continuation of another (it has a `parentSessionId` — a free-form
   * handover the user took over, Journey 4). The dashboard marks it so a continuation is distinguishable
   * from a plain launch in the list, not only inside the session view.
   */
  readonly isContinuation: boolean;
  /**
   * The session this one continues, when known — the chain link `buildThreadRows` collapses into one
   * thread row (ux Phase 3). From the registry, or a live `session.chained` frame for a fresh fork.
   */
  readonly parentSessionId: string | null;
  /** The repo identity from decrypted metadata ('owner/name' or a checkout folder name), if sent. */
  readonly repo: string | null;
  /** The session's working directory (decrypted metadata) — the repo-tag fallback source. */
  readonly cwd: string | null;
  readonly createdAt: Date;
  /**
   * When the session last did something (T7): the registry's `updated_at` — status flips, metadata,
   * endings all bump it. Groups sort by THIS, so a recently-touched old session leads. A live-only row
   * (launched this visit, no registry row yet) stamps the injected clock.
   */
  readonly lastActivityAt: Date;
}

/** A persisted-registry session, as the layout load delivers it (the fields the dashboard renders). */
export interface RegistrySessionRow {
  readonly id: string;
  readonly title: string | null;
  readonly status: SessionStatusName;
  readonly deviceId: string;
  readonly origin: SessionOrigin;
  readonly parentSessionId: string | null;
  readonly createdAt: Date;
  /** Last activity (`updated_at`) — the board's sort key (T7). */
  readonly updatedAt: Date;
  /**
   * The persisted sealed `session.meta` blob + nonce (ux Phase 6) — decoded client-side into the meta
   * map (`seedRegistryMetas`); ciphertext blobs stay opaque until this browser holds the session key.
   * Null against a pre-Phase-6 relay (deploy skew) or for rows that never got metadata.
   */
  readonly sealedMeta: string | null;
  readonly sealedMetaNonce: string | null;
  /**
   * The persisted sealed rename override blob + nonce (ux Phase 6 T6) — decoded client-side into the
   * title-override map (`seedRegistryTitles`), which beats `sealedMeta`'s title on display. Both null
   * until a rename (and after a reset), or against a pre-T6 relay.
   */
  readonly sealedTitle: string | null;
  readonly sealedTitleNonce: string | null;
}

/**
 * The first title candidate that is real — empty values and injected-machinery strings are skipped.
 * Titles sealed/persisted BEFORE the classifier existed can be tag soup ("<local-command-caveat>…");
 * filtering at display time heals those rows without rewriting their blobs. A user rename override is
 * exempt by construction — callers put it ahead of this pick.
 */
export function pickDisplayTitle(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate != null && candidate !== '' && !isInjectedPrompt(candidate)) return candidate;
  }
  return null;
}

/**
 * The last segment of a path-ish value ('owner/name' or a directory), or null. Splits on both
 * separators — the browser can't know which OS's daemon produced the path.
 */
export function repoTagOf(path: string | null | undefined): string | null {
  if (path === null || path === undefined) return null;
  const segment = path
    .split(/[\\/]+/)
    .filter((part) => part !== '')
    .pop();
  return segment ?? null;
}

/**
 * The repo tag a session card wears: the sealed meta's repo identity when the daemon sent one, else
 * the working directory's basename (adopted sessions run in the repo itself). A launched session's
 * worktree cwd ends in the session id — only `repo` names it correctly there.
 */
export function sessionRepoTag(row: Pick<SessionRow, 'repo' | 'cwd'>): string | null {
  return repoTagOf(row.repo ?? row.cwd);
}

/** A persisted registry row as a dashboard row (live overlay happens in {@link mergeLiveRow}). */
function rowFromRegistry(input: {
  readonly session: RegistrySessionRow;
  readonly deviceNameOf: (deviceId: string) => string | null;
  readonly meta: SessionMetaPayload | undefined;
  readonly titleOverride: string | undefined;
}): SessionRow {
  const { session, meta, titleOverride } = input;
  return {
    id: session.id,
    // Precedence: the user's rename override (ux Phase 6 T6) beats decrypted metadata, which beats the
    // registry's legacy cleartext title (each is a fresher source than the next).
    title: titleOverride ?? pickDisplayTitle(meta?.title, session.title),
    status: session.status,
    deviceId: session.deviceId,
    deviceName: input.deviceNameOf(session.deviceId),
    origin: session.origin,
    isContinuation: session.parentSessionId !== null,
    parentSessionId: session.parentSessionId,
    repo: meta?.repo ?? null,
    cwd: meta?.cwd ?? null,
    createdAt: session.createdAt,
    lastActivityAt: session.updatedAt,
  };
}

/** Overlay one live session state onto its registry row (or mint a row for an unpersisted one). */
function mergeLiveRow(input: {
  readonly id: string;
  readonly state: SessionState;
  readonly existing: SessionRow | undefined;
  readonly meta: SessionMetaPayload | undefined;
  readonly titleOverride: string | undefined;
  readonly deviceNameOf: (deviceId: string) => string | null;
  readonly deviceIdOf: (sessionId: string) => string | null;
  readonly now: Date | undefined;
}): SessionRow {
  const { id, state, existing } = input;
  // A live state that is still `idle` carries no frames yet — keep what the registry says.
  const status = state.status === 'idle' ? (existing?.status ?? 'starting') : state.status;
  // Title precedence: user rename override (T6) → decrypted metadata → registry/legacy title → the first
  // prompt seen this visit.
  const title =
    input.titleOverride ??
    pickDisplayTitle(input.meta?.title) ??
    existing?.title ??
    firstRealPromptText(state.entries) ??
    null;
  // Continuation link from either source: the persisted registry, or a live `session.chained` frame.
  const parentSessionId = existing?.parentSessionId ?? state.parentSessionId;
  const deviceId = existing?.deviceId ?? input.deviceIdOf(id);
  return {
    id,
    title,
    status,
    deviceId,
    deviceName: existing?.deviceName ?? (deviceId ? input.deviceNameOf(deviceId) : null),
    // A session launched this visit is `launched`; an adopted one carries its origin from the registry.
    origin: existing?.origin ?? 'launched',
    isContinuation: parentSessionId !== null,
    parentSessionId,
    repo: input.meta?.repo ?? existing?.repo ?? null,
    cwd: input.meta?.cwd ?? existing?.cwd ?? null,
    createdAt: existing?.createdAt ?? input.now ?? new Date(),
    // The registry's stamp survives a live overlay — frames alone must not resort the board.
    lastActivityAt: existing?.lastActivityAt ?? input.now ?? new Date(),
  };
}

/**
 * THE single merge of the persisted registry with the live channels — every surface that shows session
 * rows or tallies (dashboard list, system bar, sidebar badge) builds from this one function, so their
 * numbers can never disagree. Registry rows are overlaid with live status; sessions launched this visit
 * but not yet persisted are appended, attributed via the store's live routing map (`deviceIdOf` — which
 * device's channel their frames arrived on, ux Phase 5).
 */
export function buildSessionRows(input: {
  readonly registry: readonly RegistrySessionRow[];
  readonly live: ReadonlyMap<string, SessionState>;
  /** Decrypted session metadata (ux Phase 6) — its title beats the registry's and the first prompt. */
  readonly metas?: ReadonlyMap<string, SessionMetaPayload>;
  /** User rename overrides (ux Phase 6 T6) — the highest-precedence title source (override-wins). */
  readonly titleOverrides?: ReadonlyMap<string, string>;
  readonly deviceNameOf: (deviceId: string) => string | null;
  /** The live routing map: which device a not-yet-persisted session's frames arrived on. */
  readonly deviceIdOf: (sessionId: string) => string | null;
  /** Clock for the createdAt of not-yet-persisted live sessions (injected so the merge stays pure). */
  readonly now?: Date;
}): SessionRow[] {
  const byId = new Map<string, SessionRow>();
  for (const session of input.registry) {
    byId.set(
      session.id,
      rowFromRegistry({
        session,
        deviceNameOf: input.deviceNameOf,
        meta: input.metas?.get(session.id),
        titleOverride: input.titleOverrides?.get(session.id),
      }),
    );
  }
  for (const [id, state] of input.live) {
    byId.set(
      id,
      mergeLiveRow({
        id,
        state,
        existing: byId.get(id),
        meta: input.metas?.get(id),
        titleOverride: input.titleOverrides?.get(id),
        deviceNameOf: input.deviceNameOf,
        deviceIdOf: input.deviceIdOf,
        now: input.now,
      }),
    );
  }
  return [...byId.values()];
}

/** The dashboard's three buckets (the mockup's "Needs your decision" / "Active" / "Recent"). */
export type SessionGroupKey = 'awaiting' | 'active' | 'recent';

/** Generic over the row so a collapsed thread row (ux Phase 3) keeps its type through grouping. */
export interface SessionGroups<Row extends SessionRow = SessionRow> {
  readonly awaiting: readonly Row[];
  readonly active: readonly Row[];
  readonly recent: readonly Row[];
}

/**
 * Which bucket a status belongs to. Every status is listed explicitly so adding a new one to the protocol
 * is a compile error here (via the `never` check) rather than a silent fall into "recent".
 */
function groupKey(status: SessionStatus): SessionGroupKey {
  switch (status) {
    case 'awaiting_input':
      return 'awaiting';
    case 'running':
    case 'starting':
      return 'active';
    case 'done':
    case 'error':
    case 'turn_limit':
    case 'needs_restart':
    case 'offline_paused':
    case 'idle':
      return 'recent';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Partition rows into the dashboard's three groups, most recent activity first within each (T7). */
export function groupSessions<Row extends SessionRow>(rows: readonly Row[]): SessionGroups<Row> {
  const groups: Record<SessionGroupKey, Row[]> = { awaiting: [], active: [], recent: [] };
  for (const row of rows) groups[groupKey(row.status)].push(row);
  const byActivity = (a: Row, b: Row): number =>
    b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
  return {
    awaiting: groups.awaiting.sort(byActivity),
    active: groups.active.sort(byActivity),
    recent: groups.recent.sort(byActivity),
  };
}

/** Live tallies for the system bar / dashboard header: agents doing work, and those blocked on you. */
export interface SessionCounts {
  /** Sessions actively working (running or starting). */
  readonly running: number;
  /** Sessions blocked awaiting a human decision — the loud signal. */
  readonly awaiting: number;
}

export function sessionCounts(rows: readonly Pick<SessionRow, 'status'>[]): SessionCounts {
  let running = 0;
  let awaiting = 0;
  for (const row of rows) {
    if (row.status === 'awaiting_input') awaiting += 1;
    else if (row.status === 'running' || row.status === 'starting') running += 1;
  }
  return { running, awaiting };
}
