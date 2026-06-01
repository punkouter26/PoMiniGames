targetScope = 'resourceGroup'

param location string = 'westus2'
param appName string
param appServiceName string
param logAnalyticsWorkspaceName string
param sharedResourceGroupName string = 'PoShared'

// Get the Log Analytics workspace from PoShared
resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2021-06-01' existing = {
  name: logAnalyticsWorkspaceName
  scope: resourceGroup(sharedResourceGroupName)
}

// Action group for alerts (email notifications)
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'PoMiniGamesAlerts'
  location: 'global'
  properties: {
    groupShortName: 'PoMiniAlert'
    enabled: true
    emailReceivers: [
      {
        name: 'AdminEmail'
        emailAddress: 'admin@example.com' // Update with actual email
        useCommonAlertSchema: true
      }
    ]
  }
}

// App Service Down Alert
resource appServiceDownAlert 'Microsoft.Insights/scheduledQueryRules@2021-02-01-preview' = {
  name: '${appName}-AppDown'
  location: location
  properties: {
    enabled: true
    frequency: 1 // Check every 1 minute
    windowSize: 5 // Over 5 minute window
    severity: 1 // Critical
    evaluationFrequency: 1 // Evaluate every 1 minute
    criteria: {
      allOf: [
        {
          query: '''
AppServiceHttp2xxCount
| where TimeGenerated > ago(5m)
| where AppName == '${appServiceName}'
| summarize TotalRequests = sum(Count) by bin(Timestamp, 1m)
| where TotalRequests == 0
'''
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: 1
          failingPeriods: {
            numberOfEvaluationPeriods: 5
            minFailingPeriodsToAlert: 3
          }
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
    scopes: [
      subscription().id
    ]
    targetResourceTypes: [
      'Microsoft.Web/sites'
    ]
    autoMitigate: true
  }
}

// High Error Rate Alert
resource highErrorRateAlert 'Microsoft.Insights/scheduledQueryRules@2021-02-01-preview' = {
  name: '${appName}-HighErrorRate'
  location: location
  properties: {
    enabled: true
    frequency: 1
    windowSize: 5
    severity: 2 // Error
    evaluationFrequency: 1
    criteria: {
      allOf: [
        {
          query: '''
AppServiceHttp2xxCount
| where TimeGenerated > ago(5m)
| where AppName == '${appServiceName}'
| summarize TotalRequests = sum(Count) by bin(Timestamp, 1m)
| join kind=inner (
    AppServiceHttp4xxCount
    | where TimeGenerated > ago(5m)
    | where AppName == '${appServiceName}'
    | summarize ErrorRequests = sum(Count) by bin(Timestamp, 1m)
) on Timestamp
| extend ErrorRate = ErrorRequests * 100.0 / TotalRequests
| where ErrorRate > 5 // More than 5% error rate
'''
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: 1
          failingPeriods: {
            numberOfEvaluationPeriods: 5
            minFailingPeriodsToAlert: 3
          }
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
    scopes: [
      subscription().id
    ]
    targetResourceTypes: [
      'Microsoft.Web/sites'
    ]
    autoMitigate: true
  }
}

// Slow Response Time Alert
resource slowResponseAlert 'Microsoft.Insights/scheduledQueryRules@2021-02-01-preview' = {
  name: '${appName}-SlowResponse'
  location: location
  properties: {
    enabled: true
    frequency: 1
    windowSize: 5
    severity: 3 // Warning
    evaluationFrequency: 1
    criteria: {
      allOf: [
        {
          query: '''
AppServiceResponseTime
| where TimeGenerated > ago(5m)
| where AppName == '${appServiceName}'
| summarize AvgResponseTime = avg(ResponseTime) by bin(Timestamp, 1m)
| where AvgResponseTime > 3000 // More than 3 seconds
'''
          timeAggregation: 'Average'
          operator: 'GreaterThanOrEqual'
          threshold: 3000
          failingPeriods: {
            numberOfEvaluationPeriods: 5
            minFailingPeriodsToAlert: 3
          }
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
    scopes: [
      subscription().id
    ]
    targetResourceTypes: [
      'Microsoft.Web/sites'
    ]
    autoMitigate: true
  }
}

// Output the action group ID for use in other deployments
output actionGroupId string = actionGroup.id
