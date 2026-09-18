param keyVaultName string
param storageAccountName string
param aiFoundryEndpoint string = ''
@description('OpenRouter API key that hosts the Jev System One model. Override via `azd env set PoMiniGamesJevApiKey <key>`; empty by default so a forgotten override fails the deploy rather than silently serving a 401-bypass loop.')
param jevApiKey string = ''
param solutionName string = 'PoMiniGames'

resource sharedKeyVault 'Microsoft.KeyVault/vaults@2023-02-01' existing = {
  name: keyVaultName
}

resource storageAccountSecret 'Microsoft.KeyVault/vaults/secrets@2023-02-01' = {
  parent: sharedKeyVault
  name: '${solutionName}--StorageAccountName'
  properties: {
    value: storageAccountName
  }
}

// Centralized Azure AI Foundry hub endpoint (in PoShared RG). The Web App's
// system-assigned MI acquires an AAD bearer via DefaultAzureCredential at
// runtime; no API key is stored.
resource aiFoundryEndpointSecret 'Microsoft.KeyVault/vaults/secrets@2023-02-01' = {
  parent: sharedKeyVault
  name: '${solutionName}--AI--FoundryEndpoint'
  properties: {
    value: aiFoundryEndpoint
  }
}

// Jev (TypeSafe System One) — the pre-call gate before every AI chat call on
// PoJoker and PoEcosystem. Hosted on OpenRouter; the secret is the OpenRouter
// API key, NOT an Azure token. The Web App's MI reads it via
// PrefixKeyVaultSecretManager (binding key `PoMiniGames:Jev:ApiKey`), the same
// path every other PoMiniGames--* secret travels. Local dev reads it from
// the user-secrets-free appsettings.Development.json or the
// PoMiniGames__Jev__ApiKey env var (see CLAUDE.md "No dotnet user-secrets").
//
// Empty by default. StartupSecretValidator must NOT trip on this — a missing
// Jev key is the documented bypass path (the gate falls through to the chat
// call when Jev is down). The `PoJoker:AzureOpenAI:Strict` check, if any,
// stays out of this path.
resource jevApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-02-01' = if (!empty(jevApiKey)) {
  parent: sharedKeyVault
  name: '${solutionName}--Jev--ApiKey'
  properties: {
    value: jevApiKey
  }
}

