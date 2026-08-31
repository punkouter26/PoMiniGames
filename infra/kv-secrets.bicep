param keyVaultName string
param storageAccountName string
param aiFoundryEndpoint string = ''
param aiEmbeddingDeployment string = ''
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

// Optional: deployment serving embedding requests (e.g. text-embedding-3-small). When set,
// PoCoupleQuiz's answer-similarity scoring switches from a chat completion per answer pair to
// an embedding pair + cosine — cheaper by orders of magnitude and deterministic, so the result
// is permanently cacheable. Dormant while empty: AiEmbeddingService.IsConfigured is false and
// the chat fallback serves. Deploy the model on the foundry account FIRST; this secret only
// names it.
resource aiEmbeddingDeploymentSecret 'Microsoft.KeyVault/vaults/secrets@2023-02-01' = if (!empty(aiEmbeddingDeployment)) {
  parent: sharedKeyVault
  name: '${solutionName}--AI--EmbeddingDeployment'
  properties: {
    value: aiEmbeddingDeployment
  }
}
