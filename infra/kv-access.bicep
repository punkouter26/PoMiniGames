param keyVaultName string
param principalId string

@description('Built-in role: Key Vault Secrets User (data-plane read for get/list secrets).')
var keyVaultSecretsUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6')

resource keyVault 'Microsoft.KeyVault/vaults@2023-02-01' existing = {
  name: keyVaultName
}

// §3.1 best-practice: prefer RBAC over legacy accessPolicies. Requires the vault
// to be deployed with `enableRbacAuthorization: true` (see PoShared/main.bicep).
resource kvSecretsUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, principalId, keyVaultSecretsUserRoleId)
  properties: {
    principalId: principalId
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalType: 'ServicePrincipal'
  }
}
