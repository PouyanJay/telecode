/**
 * The persisted width of the app-shell sidebar (the operator drags the divider to taste). Split into pure
 * clamp + read/write over a `Storage` seam — same pattern as the permission-mode setting — so the bounds
 * and persistence unit-test without a DOM; the shell binds these to the real `localStorage`.
 */
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 420;
export const DEFAULT_SIDEBAR_WIDTH = 240;

const STORAGE_KEY = 'telecode:sidebar-width';

/** Clamp a width (in px) to the allowed range, rounded to a whole pixel. */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(px)));
}

/** Read the saved sidebar width, clamped; falls back to the default for unset/invalid values. */
export function readSidebarWidth(storage: Pick<Storage, 'getItem'>): number {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return DEFAULT_SIDEBAR_WIDTH;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : DEFAULT_SIDEBAR_WIDTH;
}

/** Persist the sidebar width (clamped first, so a bad value can never be stored). */
export function writeSidebarWidth(storage: Pick<Storage, 'setItem'>, px: number): void {
  storage.setItem(STORAGE_KEY, String(clampSidebarWidth(px)));
}
