import { permissionModeSchema, type PermissionModeName } from '@telecode/protocol';

/**
 * The default launch permission mode the operator picks once and reuses (the launch drawer seeds from it,
 * Settings edits it). The persistence is split into pure read/write over a `Storage`-shaped seam so it
 * unit-tests without a DOM; the Svelte surfaces call these with the real `localStorage` (browser-guarded).
 *
 * All four modes are surfaced, ordered least → most autonomous. `bypassPermissions` is CHOOSABLE but
 * never the shipped default (invariant #4 keeps the fresh-install default conservative): the operator
 * who picks it explicitly surrenders the gate — everything runs unattended, except questions, which
 * always stop for a human (the daemon's policy enforces that exception, not this list).
 */
export interface PermissionModeOption {
  readonly value: PermissionModeName;
  readonly label: string;
  readonly hint: string;
}

export const PERMISSION_MODES: readonly PermissionModeOption[] = [
  { value: 'plan', label: 'Plan only', hint: 'The agent explores and plans but makes no changes.' },
  {
    value: 'default',
    label: 'Approve edits',
    hint: 'You approve each consequential action before it runs.',
  },
  {
    value: 'acceptEdits',
    label: 'Auto-accept edits',
    hint: 'File edits apply automatically; other actions still ask.',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass permissions',
    hint: 'Everything runs without asking — full access to your machine. Questions still stop for you.',
  },
];

/** The conservative fallback for an unset or unrecognized stored value. */
export const DEFAULT_PERMISSION_MODE: PermissionModeName = 'default';

const STORAGE_KEY = 'telecode:default-permission-mode';

/** Read the saved default mode, falling back to {@link DEFAULT_PERMISSION_MODE} for unset/invalid values. */
export function readPermissionMode(storage: Pick<Storage, 'getItem'>): PermissionModeName {
  const parsed = permissionModeSchema.safeParse(storage.getItem(STORAGE_KEY));
  return parsed.success ? parsed.data : DEFAULT_PERMISSION_MODE;
}

/** Persist the default launch permission mode. */
export function writePermissionMode(
  storage: Pick<Storage, 'setItem'>,
  mode: PermissionModeName,
): void {
  storage.setItem(STORAGE_KEY, mode);
}
