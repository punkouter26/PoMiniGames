targetScope = 'subscription'

param name string
param location string

@description('The name of the resource group to create')
param resourceGroupName string = 'rg-PoMiniGames-prod'

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

module kvSecrets './kv-secrets.bicep' = {
  name: 'kv-secrets'
  scope: resourceGroup(sharedResourceGroupName)
  params: {
    keyVaultName: 'kv-poshared'
    storageAccountName: resources.outputs.AZURE_STORAGE_ACCOUNT_NAME
  }
}

module kvAccess './kv-access.bicep' = {
  name: 'kv-access'
  scope: resourceGroup(sharedResourceGroupName)
  params: {
    keyVaultName: 'kv-poshared'
    principalId: resources.outputs.WEB_APP_PRINCIPAL_ID
    tenantId: tenant().tenantId
  }
}

output API_URI string = resources.outputs.API_URI
output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output WEB_APP_NAME string = resources.outputs.WEB_APP_NAME
output STATIC_WEB_APP_NAME string = resources.outputs.STATIC_WEB_APP_NAME
