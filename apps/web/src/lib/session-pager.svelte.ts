import { appendSessionRows, fetchSessionPage, type SessionPageRow } from './housekeeping';

/**
 * The "Load more" pagination state one view holds (ux Phase 6 T7), shared by the board's ended group
 * and the archived view so the guard/fetch/append/advance dance lives once. The server load delivers
 * page 1 + its cursor; `reset` re-arms on every layout refresh (an invalidate after archive/delete
 * supersedes whatever was stacked on the stale first page); `loadMore` appends the next page.
 * Svelte-runes module (`.svelte.ts`) so the fields are reactive in the consuming components.
 */
export interface SessionPager {
  readonly extraRows: SessionPageRow[];
  readonly cursor: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
  reset(initialCursor: string | null): void;
  loadMore(): Promise<void>;
}

export function createSessionPager(
  options: {
    archived?: boolean;
    /** Runs on each fetched page BEFORE it merges (e.g. seed sealed titles into the shared maps). */
    onPage?: (rows: SessionPageRow[]) => void;
  } = {},
): SessionPager {
  let extraRows = $state<SessionPageRow[]>([]);
  let cursor = $state<string | null>(null);
  let loading = $state(false);
  let failed = $state(false);

  return {
    get extraRows() {
      return extraRows;
    },
    get cursor() {
      return cursor;
    },
    get loading() {
      return loading;
    },
    get failed() {
      return failed;
    },
    reset(initialCursor: string | null): void {
      cursor = initialCursor;
      extraRows = [];
      failed = false;
    },
    async loadMore(): Promise<void> {
      if (cursor === null || loading) return;
      loading = true;
      failed = false;
      const page = await fetchSessionPage({
        cursor,
        ...(options.archived ? { archived: true } : {}),
      });
      loading = false;
      if (!page) {
        failed = true;
        return;
      }
      options.onPage?.(page.rows);
      extraRows = appendSessionRows(extraRows, page.rows);
      cursor = page.nextCursor;
    },
  };
}
