#!/usr/bin/env bash
#
# One-shot Azure deploy for telecode (web + relay). Run it in Azure Cloud Shell (Bash) from a checkout of
# this repo — Cloud Shell is already authenticated and has az + jq + node.
#
#   git clone https://github.com/PouyanJay/telecode.git
#   cd telecode && git checkout deploy/azure-production
#   bash infra/azure/deploy.sh
#
# It provisions the infrastructure (Bicep), builds + pushes both images, runs migrations, rolls out, and
# prints the health URLs. You'll be prompted for three values. Generate-able secrets are created for you.
#
# Prerequisites you must have ready:
#   • A GitHub OAuth App with callback https://app.telecode.io/auth/github/callback (Client ID + Secret).
#   • Your Supabase PRODUCTION connection string (DATABASE_URL).
#
# Still manual afterward (browser/registrar — see docs/deploy-azure.md §4–5): custom domains + TLS, and the
# GitHub OIDC secrets for the auto-deploy workflow.
set -euo pipefail

RG="${RG:-telecode-prod}"
LOC="${LOC:-westus2}"
TAG="${TAG:-v1}"

cd "$(dirname "$0")/../.."
[ -f infra/azure/main.bicep ] || { echo "Run from the repo (infra/azure/main.bicep not found)"; exit 1; }
command -v az >/dev/null || { echo "az CLI not found — use Azure Cloud Shell"; exit 1; }
command -v jq >/dev/null || { echo "jq not found — use Azure Cloud Shell"; exit 1; }

echo "▸ Deploying telecode to resource group '$RG' in '$LOC' (subscription: $(az account show --query name -o tsv))"

# --- Prompts (secrets are hidden) -----------------------------------------------------------------------
read -rsp "Supabase DATABASE_URL: " DATABASE_URL; echo
read -rp  "GitHub OAuth Client ID: " GITHUB_CLIENT_ID
read -rsp "GitHub OAuth Client Secret: " GITHUB_CLIENT_SECRET; echo

# --- Generated secrets/keys -----------------------------------------------------------------------------
CHANNEL_TOKEN_SECRET="$(openssl rand -base64 32)"
RELAY_SERVICE_SECRET="$(openssl rand -base64 32)"
TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)"
VAPID_JSON="$(npx --yes web-push generate-vapid-keys --json)"
VAPID_PUBLIC_KEY="$(echo "$VAPID_JSON" | jq -r .publicKey)"
VAPID_PRIVATE_KEY="$(echo "$VAPID_JSON" | jq -r .privateKey)"

# --- 1. Resource group + infrastructure -----------------------------------------------------------------
az group create -n "$RG" -l "$LOC" -o none
echo "▸ Provisioning ACR, environment, and the web + relay apps (a few minutes)…"
az deployment group create -g "$RG" -n telecode -f infra/azure/main.bicep \
  -p @infra/azure/main.parameters.json \
  -p vapidPublicKey="$VAPID_PUBLIC_KEY" githubClientId="$GITHUB_CLIENT_ID" \
     databaseUrl="$DATABASE_URL" channelTokenSecret="$CHANNEL_TOKEN_SECRET" \
     relayServiceSecret="$RELAY_SERVICE_SECRET" tokenEncryptionKey="$TOKEN_ENCRYPTION_KEY" \
     vapidPrivateKey="$VAPID_PRIVATE_KEY" githubClientSecret="$GITHUB_CLIENT_SECRET" -o none

out() { az deployment group show -g "$RG" -n telecode --query "properties.outputs.$1.value" -o tsv; }
ACR="$(out acrName)"
STATIC_IP="$(out environmentStaticIp)"
ACR_SERVER="$(az acr show -n "$ACR" --query loginServer -o tsv)"

# --- 2. Exempt the web tier's egress IP from the relay's per-IP rate limit ------------------------------
az containerapp update -n telecode-relay -g "$RG" --set-env-vars "RATELIMIT_ALLOWLIST=$STATIC_IP" -o none

# --- 3. Build the real images in ACR --------------------------------------------------------------------
echo "▸ Building images in ACR…"
az acr build -r "$ACR" -t "telecode-relay:$TAG" -f apps/relay/Dockerfile . -o none
az acr build -r "$ACR" -t "telecode-web:$TAG"   -f apps/web/Dockerfile . -o none

# --- 4. Migrate the database (before serving) -----------------------------------------------------------
# Use `npx pnpm` rather than `corepack enable`: restricted shells (e.g. Azure Cloud Shell) can't symlink
# pnpm into a system bin dir, so `corepack enable` fails with EACCES.
echo "▸ Running database migrations against Supabase…"
npx --yes pnpm@9 install --frozen-lockfile --filter "@telecode/relay..."
DATABASE_URL="$DATABASE_URL" npx --yes pnpm@9 --filter @telecode/relay db:migrate

# --- 5. Roll out the real images ------------------------------------------------------------------------
az containerapp update -n telecode-relay -g "$RG" --image "$ACR_SERVER/telecode-relay:$TAG" -o none
az containerapp update -n telecode-web   -g "$RG" --image "$ACR_SERVER/telecode-web:$TAG" -o none

# --- 6. Report ------------------------------------------------------------------------------------------
RELAY_FQDN="$(az containerapp show -n telecode-relay -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
WEB_FQDN="$(az containerapp show -n telecode-web -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
echo
echo "✅ Deployed. Health checks:"
echo "   relay: https://$RELAY_FQDN/healthz"
echo "   web:   https://$WEB_FQDN/healthz"
echo
echo "Next (browser/registrar — see docs/deploy-azure.md §4–5):"
echo "  • DNS at your telecode.io registrar:"
echo "      CNAME app   → $WEB_FQDN"
echo "      CNAME relay → $RELAY_FQDN"
echo "    then: az containerapp hostname add/bind for app.telecode.io and relay.telecode.io"
echo "  • Confirm the GitHub OAuth App callback is https://app.telecode.io/auth/github/callback"
echo "  • (optional) Wire GitHub OIDC + secrets so pushes to main auto-deploy (runbook §5)"
