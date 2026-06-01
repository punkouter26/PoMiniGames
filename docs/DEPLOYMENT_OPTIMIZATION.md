# Deployment Optimization Guide

This document outlines optimization strategies for PoMiniGames deployment to reduce costs and improve resource utilization.

## 6. App Service Plan Tier Optimization

### Current State
- Production uses `asp-poshared-linux` (Basic tier) in PoShared resource group
- FREE tier `asp-pofunquiz-free` exists in PoShared and can be utilized

### Recommendations

#### Development/Staging Environments
Use the FREE App Service plan for non-production environments:

```bicep
// In your environment-specific bicep files
resource appServicePlan 'Microsoft.Web/serverfarms@2022-09-01' existing = {
  name: 'asp-pofunquiz-free'
  scope: resourceGroup('PoShared')
}

resource webApp 'Microsoft.Web/sites@2022-09-01' = {
  name: '${appName}-dev'
  properties: {
    serverFarmId: appServicePlan.id
    // ... other configuration
  }
}
```

#### Cost Savings
| Tier | Monthly Cost | Use Case |
|------|--------------|----------|
| Free | $0 | Development, testing, staging |
| Basic (B1) | ~$13 | Production with moderate traffic |
| Basic (B2) | ~$26 | Production with higher traffic |

#### Implementation Steps
1. Create environment-specific deployment scripts
2. Use GitHub Environments for staging/production separation
3. Configure deployment slots for zero-downtime swaps

## 7. Storage Account Consolidation

### Current State
- Each app has its own Storage Account in its resource group
- This leads to multiple storage accounts across the subscription

### Recommendations

#### Option A: Shared Storage Account (Non-Production)
For development and staging environments, use a shared storage account:

```bicep
// Reference shared storage in PoShared
resource sharedStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: 'stpoagentdemo26' // Or create a dedicated shared storage
  scope: resourceGroup('PoShared')
}

// Use table prefixes for data isolation
resource appTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  name: 'pominigames-dev' // Prefix with app name
  parent: sharedStorage
}
```

#### Option B: Keep Separate for Production
Production should maintain separate storage accounts for:
- Security isolation
- Performance isolation
- Compliance requirements
- Easier backup/restore

#### Configuration Pattern
```json
{
  "PoMiniGames": {
    "Storage": {
      "TableService": {
        "AccountName": "[shared-storage-name]",
        "Endpoint": "https://[shared-storage-name].table.core.windows.net",
        "TableName": "pominigames-[environment]"
      }
    }
  }
}
```

#### Managed Identity Access
Both options use Managed Identity for authentication:
- No connection strings in configuration
- RBAC-based access control
- Automatic credential rotation

### Implementation Checklist
- [ ] Identify apps suitable for storage consolidation
- [ ] Create shared storage account in PoShared (if needed)
- [ ] Configure Managed Identity access with proper RBAC
- [ ] Update application configuration to use table prefixes
- [ ] Test data isolation between environments

## Additional Optimizations

### 8. Azure Monitor Alerts
See `infra/alerts.bicep` for implementing:
- App Service downtime alerts
- High error rate alerts
- Slow response time alerts

### 9. Managed Identity
The application already uses Managed Identity for:
- Azure Table Storage access (via `DefaultAzureCredential`)
- Key Vault access
- Application Insights

No connection strings are required when using endpoint-based configuration.

### 10. .gitignore Optimization
Updated `.gitignore` includes:
- SQLite runtime files (*.sqlite3, *.db-shm, *.db-wal)
- JetBrains Rider files
- Platform-specific files (macOS, Linux, Windows)
- Build tool caches