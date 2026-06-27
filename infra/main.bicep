targetScope = 'subscription'

param name string
param location string

@description('The name of the resource group to create')
param resourceGroupName string = 'PoMiniGames'

@description('The name of the existing shared resource group')
param sharedResourceGroupName string = 'PoShared'

var tags = {
  'azd-env-name': name
}

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module resources './resources.bicep' = {
  name: 'resources'
  scope: rg
  params: {
    name: name
    location: location
    tags: tags
    sharedResourceGroupName: sharedResourceGroupName
  }
}

module kvAccess './kv-access.bicep' = {
  name: 'kv-access'
  scope: resourceGroup(sharedResourceGroupName)
  params: {
    keyVaultName: 'kv-poshared'
    principalId: resources.outputs.WEB_APP_PRINCIPAL_ID
  }
}

// Cross-RG role assignments live in their own module deployed at
// subscription scope. resources.bicep is RG-scoped (PoMiniGames), so a
// `scope: <PoShared-resource>` on a resource declaration there triggers
// BCP139. The role-assignment module declares `targetScope='subscription'`
// so it can grant on PoShared resources from a subscription-scoped
// deployment while still being orchestrated by main.bicep (also
// subscription-scoped). See shared-rbac.bicep header.
module sharedRbac './shared-rbac.bicep' = {
  name: 'shared-rbac'
  scope: subscription()
  params: {
    sharedResourceGroupName: sharedResourceGroupName
    sharedAIFoundryName: resources.outputs.AI_FOUNDRY_NAME
    webAppPrincipalId: resources.outputs.WEB_APP_PRINCIPAL_ID
  }
}

// Mirror the storage account name and AI Foundry endpoint into Key Vault so
// the app reads them via the centralized PrefixKeyVaultSecretManager at
// startup, and so secrets-rotation scripts have a single source of truth.
module kvSecrets './kv-secrets.bicep' = {
  name: 'kv-secrets'
  scope: resourceGroup(sharedResourceGroupName)
  params: {
    keyVaultName: 'kv-poshared'
    storageAccountName: resources.outputs.STORAGE_ACCOUNT_NAME
    aiFoundryEndpoint: resources.outputs.AI_FOUNDRY_ENDPOINT
  }
}

output API_URI string = resources.outputs.API_URI
output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output WEB_APP_NAME string = resources.outputs.WEB_APP_NAME
output AI_FOUNDRY_ENDPOINT string = resources.outputs.AI_FOUNDRY_ENDPOINT
