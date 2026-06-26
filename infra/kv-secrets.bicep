param keyVaultName string
param storageAccountName string
param aiFoundryEndpoint string = ''
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
