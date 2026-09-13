// Cross-resource-group role assignments for PoMiniGames.
//
// `resources.bicep` is deployed at scope = RG 'PoMiniGames', so any
// `scope: <resource-in-another-RG>` reference on a resource declaration
// triggers BCP139 ("A resource's scope must match the scope of the Bicep
// file"). The fix per Microsoft guidance: put the cross-scope resource
// into its OWN module file deployed at the matching scope — this file is
// deployed by main.bicep with `scope: resourceGroup(sharedResourceGroupName)`,
// so PoShared resources are local here and can be targeted directly.
//
// This module is RG-scoped ON PURPOSE. It used to declare
// `targetScope = 'subscription'` with a role assignment carrying no `scope`
// at all, which does not grant on the AI account — an unscoped assignment in
// a subscription-scoped file is created at the SUBSCRIPTION, handing the web
// app Cognitive Services User over every resource in it. The assignment below
// names the account it is for.
//
// Today this module only needs one assignment (Web App MI → Cognitive
// Services User on the shared AI Foundry hub in PoShared). If a future
// release adds more PoShared-role grants, they live here.

@description('Name of the shared AI Foundry account (kind=AIServices)')
param sharedAIFoundryName string

@description('ObjectId of the Web App\'s system-assigned MI')
param webAppPrincipalId string

// Built-in role: Cognitive Services User. Data-plane inference calls on the
// AI Foundry hub require this; control-plane (deployment, model management)
// remains on a separate Contributor role held by humans, not the Web App.
//
// Without it every model call fails authorization before it is ever billed:
// PoFunQuiz's JoinLobby (which generates the quiz), PoCoupleQuiz and PoJoker
// all report failures with zero calls and zero tokens on /api/health/ai.
var cognitiveServicesUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'a97b65f3-24c7-47ba-9cc6-fcb3e1e0d1cf')

resource sharedAIFoundry 'Microsoft.CognitiveServices/accounts@2023-05-01' existing = {
  name: sharedAIFoundryName
}

resource webAppAIFoundryRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sharedAIFoundry.id, webAppPrincipalId, cognitiveServicesUserRoleId)
  scope: sharedAIFoundry
  properties: {
    principalId: webAppPrincipalId
    roleDefinitionId: cognitiveServicesUserRoleId
    principalType: 'ServicePrincipal'
  }
}
