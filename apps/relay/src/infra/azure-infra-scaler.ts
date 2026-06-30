import { ContainerAppsAPIClient } from '@azure/arm-appcontainers';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';

import type { InfraScaler, InfraSettings, ScaleTarget } from './infra-scaler';

/**
 * The Azure Container Apps implementation of {@link InfraScaler}. It reads/writes each app's
 * `properties.template.scale.minReplicas` via the ARM management API, authenticated by the relay's own
 * user-assigned managed identity (so no client secret is stored). A least-privilege role
 * (`Microsoft.App/containerApps` read+write on these apps) is granted to that identity in the Bicep.
 *
 * Constructed only when the full Azure config is present (composition root); otherwise the operator
 * toggles are simply not offered. The config + factory are tightly-coupled siblings.
 */
export interface AzureInfraScalerConfig {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly webAppName: string;
  readonly relayAppName: string;
  /** Client id of the user-assigned managed identity; falls back to DefaultAzureCredential when unset. */
  readonly managedIdentityClientId?: string;
}

/** minReplicas that pins an app always-on vs. lets it scale to zero when idle. */
const MIN_REPLICAS_ALWAYS_ON = 1;
const MIN_REPLICAS_SCALE_TO_ZERO = 0;

export function createAzureInfraScaler(config: AzureInfraScalerConfig): InfraScaler {
  const credential: TokenCredential = config.managedIdentityClientId
    ? new ManagedIdentityCredential({ clientId: config.managedIdentityClientId })
    : new DefaultAzureCredential();
  const client = new ContainerAppsAPIClient(credential, config.subscriptionId);
  const appName = (target: ScaleTarget): string =>
    target === 'web' ? config.webAppName : config.relayAppName;

  async function minReplicasOf(target: ScaleTarget): Promise<number> {
    const app = await client.containerApps.get(config.resourceGroup, appName(target));
    return app.template?.scale?.minReplicas ?? 0;
  }

  return {
    async getSettings(): Promise<InfraSettings> {
      const [web, relay] = await Promise.all([minReplicasOf('web'), minReplicasOf('relay')]);
      return {
        webAlwaysOn: web >= MIN_REPLICAS_ALWAYS_ON,
        relayAlwaysOn: relay >= MIN_REPLICAS_ALWAYS_ON,
      };
    },

    async setAlwaysOn(target: ScaleTarget, alwaysOn: boolean): Promise<void> {
      const name = appName(target);
      // GET-modify-update so we change ONLY minReplicas and preserve everything else (maxReplicas, scale
      // rules, the container image/env, ingress, secrets…). We send the whole retrieved app with minReplicas
      // changed; the update is a PATCH, so read-only fields on the retrieved app are ignored.
      const app = await client.containerApps.get(config.resourceGroup, name);
      const updated = {
        ...app,
        template: {
          ...app.template,
          scale: {
            ...app.template?.scale,
            minReplicas: alwaysOn ? MIN_REPLICAS_ALWAYS_ON : MIN_REPLICAS_SCALE_TO_ZERO,
          },
        },
      };
      await client.containerApps.beginUpdateAndWait(config.resourceGroup, name, updated);
    },
  };
}
