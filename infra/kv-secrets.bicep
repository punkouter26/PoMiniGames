param keyVaultName string
param storageAccountName string
param aiFoundryEndpoint string = ''
@secure()
@description('OpenRouter API key for TypeSafe Jev, the decision model PoJevArena requires. Empty leaves any existing PoMiniGames--Jev--ApiKey secret untouched.')
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

// Jev (TypeSafe System One, hosted on OpenRouter) is PoJevArena's only decision source. The
// secret is an OpenRouter API key, NOT an Azure token; the Web App's MI reads it through
// PrefixKeyVaultSecretManager as PoMiniGames:Jev:ApiKey like every other PoMiniGames--* secret.
// Written only when a key is passed, so a deploy without one never blanks a key set by hand.
// A missing key is not a startup failure: the arena reports "Jev unavailable" instead.
resource jevApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-02-01' = if (!empty(jevApiKey)) {
  parent: sharedKeyVault
  name: '${solutionName}--Jev--ApiKey'
  properties: {
    value: jevApiKey
  }
}
