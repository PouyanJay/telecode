/**
 * The seam that isolates cloud-scaling control from the rest of the relay. Operator-only "scale-to-zero"
 * toggles flip a deployed app between always-on (minReplicas ≥ 1) and scale-to-zero (minReplicas 0). The
 * cloud itself is the source of truth — `getSettings` reads the live minReplicas, `setAlwaysOn` writes it —
 * so there is no local persistence to drift. The concrete Azure implementation lives behind this interface
 * (in `azure-infra-scaler.ts`) so the cloud SDK touches one file and tests use {@link createFakeInfraScaler}.
 * A future adapter for another platform (Fly, k8s, …) slots in the same way.
 *
 * The interface, its sibling types, and the in-memory fake are co-located as tightly-coupled siblings.
 */

/** Which deployed app a toggle targets. */
export type ScaleTarget = 'web' | 'relay';

/** Whether each app is pinned always-on (true) or allowed to scale to zero when idle (false). */
export interface InfraSettings {
  readonly webAlwaysOn: boolean;
  readonly relayAlwaysOn: boolean;
}

export interface InfraScaler {
  /** Read each app's current always-on state from the cloud (minReplicas ≥ 1 ⇒ always-on). */
  getSettings(): Promise<InfraSettings>;
  /** Pin an app always-on (minReplicas 1) or let it scale to zero (minReplicas 0). */
  setAlwaysOn(target: ScaleTarget, alwaysOn: boolean): Promise<void>;
}

/**
 * In-memory fake for tests: both apps start always-on; `setAlwaysOn` mutates the recorded state, which
 * `getSettings` returns. Exposes `settings` so a test can assert what was applied without a cloud call.
 */
export function createFakeInfraScaler(
  initial: InfraSettings = { webAlwaysOn: true, relayAlwaysOn: true },
): InfraScaler & { readonly settings: InfraSettings } {
  let state: InfraSettings = { ...initial };
  return {
    get settings(): InfraSettings {
      return state;
    },
    getSettings(): Promise<InfraSettings> {
      return Promise.resolve(state);
    },
    setAlwaysOn(target: ScaleTarget, alwaysOn: boolean): Promise<void> {
      state =
        target === 'web'
          ? { ...state, webAlwaysOn: alwaysOn }
          : { ...state, relayAlwaysOn: alwaysOn };
      return Promise.resolve();
    },
  };
}
