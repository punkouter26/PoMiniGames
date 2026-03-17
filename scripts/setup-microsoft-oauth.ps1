param(
    [Parameter(Mandatory = $false)]
    [string]$ResourceGroupName = "PoMiniGames",

    [Parameter(Mandatory = $false)]
    [string]$ApiDisplayName = "PoMiniGames-API",

    [Parameter(Mandatory = $false)]
    [string]$SpaDisplayName = "PoMiniGames-Client",

    [Parameter(Mandatory = $false)]
    [string]$ScopeName = "access_as_user"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-JsonValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Json,

        [Parameter(Mandatory = $true)]
        [string]$Property
    )

    return ($Json | ConvertFrom-Json).$Property
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI is required. Install it from https://learn.microsoft.com/cli/azure/install-azure-cli"
}

Write-Host "Checking Azure login..." -ForegroundColor Cyan
az account show | Out-Null

$tenantId = az account show --query tenantId -o tsv
$staticWebAppHost = az staticwebapp list -g $ResourceGroupName --query "[0].defaultHostname" -o tsv
$appServiceName = az webapp list -g $ResourceGroupName --query "[0].name" -o tsv

if ([string]::IsNullOrWhiteSpace($staticWebAppHost)) {
    throw "Static Web App not found in resource group '$ResourceGroupName'."
}

if ([string]::IsNullOrWhiteSpace($appServiceName)) {
    throw "App Service not found in resource group '$ResourceGroupName'."
}

$spaRedirectUris = @(
    "http://localhost:5173/auth/callback",
    "https://$staticWebAppHost/auth/callback"
)

Write-Host "Creating API app registration..." -ForegroundColor Cyan
$apiAppJson = az ad app create `
    --display-name $ApiDisplayName `
    --sign-in-audience AzureADandPersonalMicrosoftAccount `
    --query "{appId:appId,id:id}" -o json

$apiAppId = Get-JsonValue -Json $apiAppJson -Property appId
$apiObjectId = Get-JsonValue -Json $apiAppJson -Property id

$apiIdentifierUri = "api://$apiAppId"
az ad app update --id $apiAppId --identifier-uris $apiIdentifierUri | Out-Null

$scopeId = [guid]::NewGuid().Guid
$oauth2PermissionScopes = @(
    @{
        adminConsentDescription = "Allow the PoMiniGames client to access the API on behalf of the signed-in user."
        adminConsentDisplayName = "Access PoMiniGames API"
        id = $scopeId
        isEnabled = $true
        type = "User"
        userConsentDescription = "Allow this app to access PoMiniGames multiplayer and profile APIs."
        userConsentDisplayName = "Access PoMiniGames"
        value = $ScopeName
    }
) | ConvertTo-Json -Depth 5 -Compress

az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$apiObjectId" --headers "Content-Type=application/json" --body "{\"api\":{\"requestedAccessTokenVersion\":2,\"oauth2PermissionScopes\":$oauth2PermissionScopes}}" | Out-Null

Write-Host "Creating SPA app registration..." -ForegroundColor Cyan
$spaAppJson = az ad app create `
    --display-name $SpaDisplayName `
    --sign-in-audience AzureADandPersonalMicrosoftAccount `
    --web-redirect-uris $spaRedirectUris `
    --query "{appId:appId,id:id}" -o json

$spaAppId = Get-JsonValue -Json $spaAppJson -Property appId
$spaObjectId = Get-JsonValue -Json $spaAppJson -Property id

$spaDefinition = @{
    spa = @{
        redirectUris = $spaRedirectUris
    }
    publicClient = @{
        redirectUris = @()
    }
} | ConvertTo-Json -Depth 5 -Compress

az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$spaObjectId" --headers "Content-Type=application/json" --body $spaDefinition | Out-Null

Write-Host "Granting the SPA delegated access to the API scope..." -ForegroundColor Cyan
$graphResourceAccess = @(
    @{
        id = $scopeId
        type = "Scope"
    }
) | ConvertTo-Json -Compress

az ad app permission add --id $spaAppId --api $apiAppId --api-permissions "$scopeId=Scope" | Out-Null

try {
    az ad app permission grant --id $spaAppId --api $apiAppId --scope $ScopeName | Out-Null
}
catch {
    Write-Warning "Admin consent could not be granted automatically. Grant consent in the Entra admin center if needed."
}

Write-Host "Writing App Service settings..." -ForegroundColor Cyan
az webapp config appsettings set `
    --resource-group $ResourceGroupName `
    --name $appServiceName `
    --settings `
        "PoMiniGames__MicrosoftAuth__Authority=https://login.microsoftonline.com/common/v2.0" `
        "PoMiniGames__MicrosoftAuth__ClientId=$spaAppId" `
        "PoMiniGames__MicrosoftAuth__ApiClientId=$apiAppId" `
        "PoMiniGames__MicrosoftAuth__Scope=$apiIdentifierUri/$ScopeName" `
        "PoMiniGames__MicrosoftAuth__RedirectPath=/auth/callback" | Out-Null

Write-Host "Completed Microsoft OAuth setup." -ForegroundColor Green
Write-Host "Tenant ID: $tenantId"
Write-Host "SPA App ID: $spaAppId"
Write-Host "API App ID: $apiAppId"
Write-Host "Static Web App URL: https://$staticWebAppHost"
Write-Host "API Scope: $apiIdentifierUri/$ScopeName"