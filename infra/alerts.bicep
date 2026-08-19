// NOT DEPLOYED (2026-08-18 audit): this file is not a `module` in main.bicep and no
// pipeline references it, so none of these alerts exist in Azure. To activate, add a
// module block in main.bicep and pass the four params below — do not assume any alert
// here is live until that lands.
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

// Ingestion-budget alert: flags hourly spike > 50k items so a runaway loop
// can't silently exhaust the App Insights budget. The hard ceiling
// (MaxTelemetryItemsPerSecond = 5 in Production, set in TelemetryExtensions.cs)
// is the primary control; this alert is the safety net for misconfiguration.
resource ingestionBudgetAlert 'Microsoft.Insights/scheduledQueryRules@2021-02-01-preview' = {
  name: '${appName}-IngestionBudget'
  location: location
  properties: {
    enabled: true
    frequency: 15
    windowSize: 60
    severity: 3 // Warning — not critical; the budget cap will still shed load
    evaluationFrequency: 15
    criteria: {
      allOf: [
        {
          query: '''
AppMetrics
| where TimeGenerated > ago(1h)
| where Name == "traceCount" or Name == "requestCount"
| summarize HourlyCount = sum(Sum) by bin(TimeGenerated, 1h), Name
| where HourlyCount > 50000
'''
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: 1
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
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
      'Microsoft.Insights/components'
    ]
    autoMitigate: true
  }
}
