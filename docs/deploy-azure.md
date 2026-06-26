# Deploying telecode to Azure (app + relay)

This is the production runbook for hosting telecode's control plane on **Azure Container Apps**:

- **Web app** (`apps/web`, the SvelteKit PWA) → `https://app.telecode.io`
- **Relay** (`apps/relay`, the Fastify + ws broker) → `wss://relay.telecode.io`

**Postgres** is your **managed Supabase** (not provisioned here). The **marketing site** (`apps/site`,
`telecode.io`) is deployed separately (e.g. Vercel) and is out of scope for this guide.

> **Remember:** agents do not run in the cloud. The daemon runs on each user's own machine via
> `npx telecode`; Azure only hosts the relay + web. Execution stays local — that's the product promise.

The IaC (`infra/azure/main.bicep`) provisions: an Azure Container Registry, a Container Apps Environment
(+ Log Analytics), Azure Cache for Redis, a managed identity (with AcrPull), and the two apps. `.github/
workflows/deploy.yml` builds images, runs migrations, and rolls out on every push to `main`.

## Architecture note (read once)

- **The relay runs as a single replica** (`maxReplicas: 1`). Its browser↔daemon routing is in-memory with
  no cross-instance backplane, so a second replica would split routing. One instance handles many
  connections; horizontal scaling is future work (needs a Redis pub/sub routing backplane).
- **The web app autoscales** (1–3 replicas) — it's stateless SSR.
- The web image is **environment-agnostic**: all config is injected at runtime, no secrets baked in.

## Prerequisites

- `az` CLI logged in (`az login`) with rights to create resources in your subscription.
- The Azure Bicep extension (`az bicep install`).
- Your Supabase **production** `DATABASE_URL`.
- A **GitHub OAuth App** — github.com → Settings → Developer settings → OAuth Apps → New:
  - Homepage `https://app.telecode.io`, Authorization callback `https://app.telecode.io/auth/github/callback`.
  - Note the **Client ID** and generate a **Client secret**.
- VAPID keys for web push: `npx web-push generate-vapid-keys`.
- Three shared secrets: `openssl rand -base64 32` for `CHANNEL_TOKEN_SECRET`, `RELAY_SERVICE_SECRET`,
  `TOKEN_ENCRYPTION_KEY`.

Copy `infra/azure/.env.deploy.example` somewhere private and fill it in as you go (do not commit it).

## 1. Provision the infrastructure

```sh
RG=telecode-prod
az group create -n "$RG" -l eastus

az deployment group create -g "$RG" -f infra/azure/main.bicep \
  -p @infra/azure/main.parameters.json \
  -p vapidPublicKey="$VAPID_PUBLIC_KEY" githubClientId="$GITHUB_CLIENT_ID" \
  -p databaseUrl="$DATABASE_URL" \
     channelTokenSecret="$CHANNEL_TOKEN_SECRET" \
     relayServiceSecret="$RELAY_SERVICE_SECRET" \
     tokenEncryptionKey="$TOKEN_ENCRYPTION_KEY" \
     vapidPrivateKey="$VAPID_PRIVATE_KEY" \
     githubClientSecret="$GITHUB_CLIENT_SECRET"
```

This creates everything with **placeholder images** (the apps won't be healthy until step 2 pushes the real
images — that's expected; nothing is serving traffic yet). Capture the outputs:

```sh
az deployment group show -g "$RG" -n main --query properties.outputs
# → acrName, environmentStaticIp, relayDefaultFqdn, webDefaultFqdn, …
```

## 2. Set the rate-limit allowlist, then build + roll out the real images

The web tier calls the relay server-to-server for every user from the environment's outbound IP. Exempt it
from per-IP rate limiting (otherwise it throttles your whole user base):

```sh
STATIC_IP="$(az deployment group show -g "$RG" -n main --query properties.outputs.environmentStaticIp.value -o tsv)"
az containerapp update -n telecode-relay -g "$RG" --set-env-vars "RATELIMIT_ALLOWLIST=$STATIC_IP"
```

Build the real images into ACR and roll out (the deploy workflow does this automatically later; this is the
first manual push):

```sh
ACR="$(az deployment group show -g "$RG" -n main --query properties.outputs.acrName.value -o tsv)"
az acr build -r "$ACR" -t telecode-relay:bootstrap -f apps/relay/Dockerfile .
az acr build -r "$ACR" -t telecode-web:bootstrap   -f apps/web/Dockerfile .
SERVER="$(az acr show -n "$ACR" --query loginServer -o tsv)"
az containerapp update -n telecode-relay -g "$RG" --image "$SERVER/telecode-relay:bootstrap"
az containerapp update -n telecode-web   -g "$RG" --image "$SERVER/telecode-web:bootstrap"
```

## 3. Run database migrations (against Supabase)

```sh
DATABASE_URL="$DATABASE_URL" pnpm --filter @telecode/relay db:migrate
```

Idempotent (drizzle-tracked) — safe to re-run. After this, hit the default FQDNs to confirm health:

```sh
RELAY_FQDN="$(az containerapp show -n telecode-relay -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
WEB_FQDN="$(az containerapp show -n telecode-web -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
curl -fsS "https://$RELAY_FQDN/healthz"   # {"status":"ok"}
curl -fsS "https://$WEB_FQDN/healthz"     # {"status":"ok"}
```

## 4. Custom domains + managed TLS

At your `telecode.io` DNS provider, point the subdomains at the apps and add the validation records:

```sh
# CNAME records
#   app    → $WEB_FQDN
#   relay  → $RELAY_FQDN
# TXT validation records (get the exact values from these commands):
az containerapp hostname add    -n telecode-web   -g "$RG" --hostname app.telecode.io
az containerapp hostname add    -n telecode-relay -g "$RG" --hostname relay.telecode.io
# Each prints an `asuid.<sub>` TXT value to add at the registrar. Once DNS resolves, bind a managed cert:
az containerapp hostname bind   -n telecode-web   -g "$RG" --hostname app.telecode.io   --environment telecode-env --validation-method CNAME
az containerapp hostname bind   -n telecode-relay -g "$RG" --hostname relay.telecode.io --environment telecode-env --validation-method CNAME
```

(The apex `telecode.io` → your Vercel marketing site is configured separately at the registrar.)

## 5. Wire up CI/CD (GitHub → Azure via OIDC)

One-time, so `deploy.yml` can deploy on push to `main` without a stored password:

```sh
# Create an Entra app + service principal, give it Contributor on the resource group:
APP_ID="$(az ad app create --display-name telecode-deploy --query appId -o tsv)"
az ad sp create --id "$APP_ID"
SUB="$(az account show --query id -o tsv)"
az role assignment create --assignee "$APP_ID" --role Contributor --scope "/subscriptions/$SUB/resourceGroups/$RG"

# Federated credential for this repo's main branch:
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:PouyanJay/telecode:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

Then add to the GitHub repo:

- **Secrets:** `AZURE_CLIENT_ID` (= `$APP_ID`), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `DATABASE_URL`.
- **Variables:** `AZURE_RESOURCE_GROUP` (= `telecode-prod`), `ACR_NAME` (from step 1), `RELAY_APP_NAME`
  (`telecode-relay`), `WEB_APP_NAME` (`telecode-web`).

From now on, every push to `main` builds both images, runs migrations, and rolls out. (Delete the `push:`
trigger in `deploy.yml` to make deploys manual-only.)

## 6. Verify end-to-end

1. Browse `https://app.telecode.io` → the sign-in shows **"Continue with GitHub"** → GitHub OAuth →
   authenticated dashboard.
2. On a laptop: `npx telecode --relay-url wss://relay.telecode.io/ws` → it prints a pairing code → enter it
   in the web app → the device shows online.
3. Launch a session, watch output stream, and approve a tool call — this proves the full wss routing path
   (browser ↔ relay ↔ daemon) end-to-end.

## Rotating secrets

Update a Container Apps secret and the app picks it up on its next revision:

```sh
az containerapp secret set -n telecode-relay -g "$RG" --secrets channel-token-secret=<new>
az containerapp update     -n telecode-relay -g "$RG"   # force a new revision
```

Keep `CHANNEL_TOKEN_SECRET`, `RELAY_SERVICE_SECRET`, and `TOKEN_ENCRYPTION_KEY` identical across relay + web
where shared (see the secret matrix in `infra/azure/.env.deploy.example`).

## Hardening follow-ups (optional)

- **Static egress IP:** for a guaranteed-stable `RATELIMIT_ALLOWLIST`, attach the environment to a VNet with
  a NAT Gateway. The environment's default outbound IP works but can change on environment-level changes.
- **Key Vault:** reference secrets from Azure Key Vault instead of inline Container Apps secrets.
- **Relay scaling:** add a Redis pub/sub routing backplane before raising the relay past one replica.
