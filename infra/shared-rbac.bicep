// Cross-resource-group role assignments for PoMiniGames.
//
// `resources.bicep` is deployed at scope = RG 'PoMiniGames', so any
// `scope: <resource-in-another-RG>` reference on a resource declaration
// triggers BCP139 ("A resource's scope must match the scope of the Bicep
// file"). The fix per Microsoft guidance: put the cross-scope resource
// into its OWN module file deployed at the matching scope.
//
// At subscription scope, role assignments can target resources in any RG
// by id without BCP139. main.bicep calls this module with
//   scope: resourceGroup(sharedResourceGroupName)
// which gives us a sub-deployment rooted at PoShared; combined with
// `targetScope = 'subscription'` here we get a *subscription-rooted*
// deployment that lives in PoShared (where main.bicep put it) but whose
// role assignment can still point at PoShared resources by id.
//
// Today this module only needs one assignment (Web App MI → Cognitive
// Services User on the shared AI Foundry hub in PoShared). If a future
// release adds more PoShared-role grants, they live here.

targetScope = 'subscription'

@description('Resource group containing the shared AI Foundry hub')
param sharedResourceGroupName string = 'PoShared'

@description('Name of the shared AI Foundry account (kind=AIServices)')
param sharedAIFoundryName string

@description('ObjectId of the Web App\'s system-assigned MI')
param webAppPrincipalId string

// Built-in role: Cognitive Services User. Data-plane inference calls on the
// AI Foundry hub require this; control-plane (deployment, model management)
// remains on a separate Contributor role held by humans, not the Web App.
var cognitiveServicesUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'a97b65f3-24c7-47ba-9cc6-fcb3e1e0d1cf')

resource sharedAIFoundry 'Microsoft.CognitiveServices/accounts@2023-05-01' existing = {
  name: sharedAIFoundryName
  scope: resourceGroup(sharedResourceGroupName)
}

resource webAppAIFoundryRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sharedAIFoundry.id, webAppPrincipalId, cognitiveServicesUserRoleId)
  properties: {
    principalId: webAppPrincipalId
    roleDefinitionId: cognitiveServicesUserRoleId
    principalType: 'ServicePrincipal'
  }
}

output AI_FOUNDRY_ROLE_ASSIGNMENT_NAME string = webAppAIFoundryRoleAssignment.name
