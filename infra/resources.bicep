param name string
param location string
param tags object

@description('The name of the existing Key Vault in PoShared')
param sharedKeyVaultName string = 'kv-poshared'

@description('The name of the existing App Insights in PoShared')
param sharedAppInsightsName string = 'poappideinsights8f9c9a4e'

@description('The name of the existing App Service Plan in PoShared')
param sharedAppServicePlanName string = 'asp-poshared-linux'

@description('The name of the resource group containing shared resources')
param sharedResourceGroupName string = 'PoShared'

var abbreviations = loadJsonContent('./abbreviations.json')
var resourceToken = toLower(uniqueString(subscription().id, name, location))

// Existing App Service Plan in PoShared
resource appServicePlan 'Microsoft.Web/serverfarms@2022-09-01' existing = {
  name: sharedAppServicePlanName
  scope: resourceGroup(sharedResourceGroupName)
}

// Web App
resource webApp 'Microsoft.Web/sites@2022-09-01' = {
  name: '${abbreviations.webApp}${resourceToken}'
  location: location
  tags: union(tags, { 'azd-service-name': 'api' })
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'DOTNETCORE|10.0'
      alwaysOn: false
      ftpsState: 'FtpsOnly'
      minTlsVersion: '1.2'
      appSettings: [
        {
          name: 'Sqlite__DataDirectory'
          value: '/home/data'
        }
        {
          name: 'PoMiniGames__ApplicationInsights__ConnectionString'
          value: sharedAppInsights.properties.ConnectionString
        }
        {
          name: 'PoMiniGames__KeyVault__Uri'
          value: sharedKeyVault.properties.vaultUri
        }
        {
          name: 'PoMiniGames__Cors__AllowedOrigins__0'
          value: 'https://${staticWebApp.properties.defaultHostname}'
        }
        {
          name: 'PoMiniGames__Cors__AllowedOrigins__1'
          value: 'http://localhost:5173'
        }
      ]
    }
    httpsOnly: true
  }
}

// Existing Resources in PoShared
resource sharedKeyVault 'Microsoft.KeyVault/vaults@2023-02-01' existing = {
  name: sharedKeyVaultName
  scope: resourceGroup(sharedResourceGroupName)
}

resource sharedAppInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: sharedAppInsightsName
  scope: resourceGroup(sharedResourceGroupName)
}

// Static Web App (React)
resource staticWebApp 'Microsoft.Web/staticSites@2022-09-01' = {
  name: '${abbreviations.staticWebApp}${resourceToken}'
  location: location // SWA location is specific, but usually 'westus2' works or 'centralus'
  tags: union(tags, { 'azd-service-name': 'web' })
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {}
}

output API_URI string = 'https://${webApp.properties.defaultHostName}'
output WEB_APP_NAME string = webApp.name
output WEB_APP_PRINCIPAL_ID string = webApp.identity.principalId
output STATIC_WEB_APP_NAME string = staticWebApp.name
output STATIC_WEB_APP_DEFAULT_HOSTNAME string = staticWebApp.properties.defaultHostname
