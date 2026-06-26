// Telecode production infrastructure on Azure Container Apps.
//
// Provisions, in one resource group: an Azure Container Registry, a Container Apps Environment (with Log
// Analytics), Azure Cache for Redis, a user-assigned managed identity (with AcrPull), and the two apps —
// the relay (relay.telecode.io, single replica) and the web app (app.telecode.io, autoscaling).
//
// Postgres is NOT provisioned here — telecode uses managed Supabase; pass its connection string as the
// `databaseUrl` secure parameter.
//
// Custom domains + managed TLS certificates are added AFTER deployment (they require the validation DNS
// records to exist first) — see docs/deploy-azure.md. The apps come up on their default Container Apps
// FQDNs; bind app./relay. hostnames once DNS is in place.
//
//   az deployment group create -g <rg> -f infra/azure/main.bicep -p @infra/azure/main.parameters.json \
//     -p databaseUrl=… channelTokenSecret=… relayServiceSecret=… tokenEncryptionKey=… \
//        vapidPrivateKey=… githubClientSecret=…

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Short prefix for resource names (lowercase alphanumeric).')
param namePrefix string = 'telecode'

@description('Public hostname for the product web app.')
param appHostname string = 'app.telecode.io'

@description('Public hostname for the relay (browsers + daemons connect here over wss).')
param relayHostname string = 'relay.telecode.io'

@description('Web app image. Defaults to a placeholder for the first provision; the deploy workflow then pushes the real image and updates the app.')
param webImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Relay image. Defaults to a placeholder for the first provision (see webImage).')
param relayImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

// --- Non-secret config -----------------------------------------------------------------------------------
@description('VAPID public key for web push (safe to expose; the browser needs it).')
param vapidPublicKey string = ''
@description('Contact subject for VAPID push, e.g. mailto:admin@telecode.io.')
param vapidSubject string = 'mailto:admin@telecode.io'
@description('GitHub OAuth App client id (not secret).')
param githubClientId string = ''
@description('Comma-separated IPs exempt from relay rate limiting — set to the web tier egress IP(s) after the environment exists (see docs/deploy-azure.md).')
param ratelimitAllowlist string = ''
@description('Opt-in relay telemetry: empty (off) or "on".')
param telemetryEnabled string = ''

// --- Secrets (pass at deploy time; never commit) ---------------------------------------------------------
@secure()
@description('Supabase production Postgres connection string.')
param databaseUrl string
@secure()
@description('Signs short-lived browser channel tokens (shared relay+web).')
param channelTokenSecret string
@secure()
@description('Shared secret the web tier presents on server-to-server relay calls.')
param relayServiceSecret string
@secure()
@description('Base64 32-byte key encrypting the stored GitHub token at rest (relay).')
param tokenEncryptionKey string
@secure()
@description('VAPID private key for web push (relay).')
param vapidPrivateKey string = ''
@secure()
@description('GitHub OAuth App client secret (web).')
param githubClientSecret string = ''

var tags = { project: 'telecode', managedBy: 'bicep' }
var acrName = toLower(take('${namePrefix}acr${uniqueString(resourceGroup().id)}', 50))
var redisName = '${namePrefix}-redis-${uniqueString(resourceGroup().id)}'

// --- Observability + Container Apps Environment ----------------------------------------------------------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// --- Container Registry + pull identity ------------------------------------------------------------------
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-pull'
  location: location
  tags: tags
}

// AcrPull for the managed identity both apps use to pull images.
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, uami.id, 'AcrPull')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// --- Redis (rate-limit store for the relay) --------------------------------------------------------------
resource redis 'Microsoft.Cache/redis@2024-03-01' = {
  name: redisName
  location: location
  tags: tags
  properties: {
    sku: { name: 'Basic', family: 'C', capacity: 0 }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
  }
}

var redisUrl = 'rediss://:${redis.listKeys().primaryKey}@${redis.properties.hostName}:${redis.properties.sslPort}'

var registries = [
  {
    server: acr.properties.loginServer
    identity: uami.id
  }
]

// --- Relay: relay.telecode.io. SINGLE replica — routing state is in-memory with no backplane. ------------
resource relay 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-relay'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${uami.id}': {} }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registries
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        { name: 'database-url', value: databaseUrl }
        { name: 'channel-token-secret', value: channelTokenSecret }
        { name: 'relay-service-secret', value: relayServiceSecret }
        { name: 'token-encryption-key', value: tokenEncryptionKey }
        { name: 'vapid-private-key', value: vapidPrivateKey }
        { name: 'redis-url', value: redisUrl }
      ]
    }
    template: {
      // Pinned to a single instance: the relay's daemon/browser routing maps + ciphertext cache are
      // in-memory with no cross-instance backplane, so >1 replica would split routing. Scaling needs a
      // Redis pub/sub backplane (future work) — do NOT raise maxReplicas.
      scale: { minReplicas: 1, maxReplicas: 1 }
      containers: [
        {
          name: 'relay'
          image: relayImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'RELAY_PORT', value: '8080' }
            { name: 'LOG_LEVEL', value: 'info' }
            { name: 'TRUST_PROXY', value: 'true' }
            { name: 'RATELIMIT_ALLOWLIST', value: ratelimitAllowlist }
            { name: 'TELECODE_TELEMETRY', value: telemetryEnabled }
            { name: 'VAPID_SUBJECT', value: vapidSubject }
            { name: 'VAPID_PUBLIC_KEY', value: vapidPublicKey }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'CHANNEL_TOKEN_SECRET', secretRef: 'channel-token-secret' }
            { name: 'RELAY_SERVICE_SECRET', secretRef: 'relay-service-secret' }
            { name: 'TOKEN_ENCRYPTION_KEY', secretRef: 'token-encryption-key' }
            { name: 'VAPID_PRIVATE_KEY', secretRef: 'vapid-private-key' }
            { name: 'REDIS_URL', secretRef: 'redis-url' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 15 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 3, periodSeconds: 10 }
          ]
        }
      ]
    }
  }
}

// --- Web: app.telecode.io. Stateless SSR — safe to autoscale. -------------------------------------------
resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-web'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${uami.id}': {} }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registries
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        { name: 'relay-service-secret', value: relayServiceSecret }
        { name: 'github-client-secret', value: githubClientSecret }
      ]
    }
    template: {
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '80' } } }
        ]
      }
      containers: [
        {
          name: 'web'
          image: webImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            // ORIGIN must be the public https origin so SvelteKit's CSRF check accepts the sign-in POST.
            { name: 'ORIGIN', value: 'https://${appHostname}' }
            { name: 'APP_URL', value: 'https://${appHostname}' }
            { name: 'RELAY_HTTP_URL', value: 'https://${relayHostname}' }
            { name: 'PUBLIC_TELECODE_RELAY_URL', value: 'wss://${relayHostname}/ws' }
            { name: 'PUBLIC_VAPID_KEY', value: vapidPublicKey }
            { name: 'GITHUB_CLIENT_ID', value: githubClientId }
            { name: 'RELAY_SERVICE_SECRET', secretRef: 'relay-service-secret' }
            { name: 'GITHUB_CLIENT_SECRET', secretRef: 'github-client-secret' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 3000 }, initialDelaySeconds: 5, periodSeconds: 15 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 3000 }, initialDelaySeconds: 3, periodSeconds: 10 }
          ]
        }
      ]
    }
  }
}

// --- Outputs (feed the runbook + the deploy workflow) ---------------------------------------------------
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output environmentName string = env.name
@description('Environment static outbound IP(s) — set this as the relay RATELIMIT_ALLOWLIST so the web tier is not self-throttled.')
output environmentStaticIp string = env.properties.staticIp
output relayAppName string = relay.name
output webAppName string = web.name
output relayDefaultFqdn string = relay.properties.configuration.ingress.fqdn
output webDefaultFqdn string = web.properties.configuration.ingress.fqdn
output pullIdentityClientId string = uami.properties.clientId
