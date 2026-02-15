# DevOps.md - Deployment Pipeline + Environment Secrets

## Simplified Version (AI-Friendly)

### Environments
- Development: Local with Azurite
- Production: Azure App Service

### Secrets
- AzureTableStorage: Connection string
- KeyVault:Uri: Azure Key Vault URL

### Pipeline
- Build: dotnet build + npm build
- Test: xUnit + Playwright
- Deploy: Docker to Azure

---

## Detailed Version (Human Developers)

## 1. Environment Overview

### 1.1 Development Environment

| Component | Value |
|-----------|-------|
| API URL | http://localhost:5000 |
| Client URL | http://localhost:5173 |
| Storage | Azurite (Docker) |
| Framework | .NET 10, React 18 |

### 1.2 Production Environment

| Component | Value |
|-----------|-------|
| API URL | https://pominigames.azure.com |
| Storage | Azure Table Storage |
| Key Vault | Azure Key Vault |

## 2. Environment Variables

### 2.1 Development (appsettings.Development.json)

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information"
    }
  },
  "ConnectionStrings": {
    "Tables": "UseDevelopmentStorage=true"
  },
  "Cors": {
    "AllowedOrigins": [
      "http://localhost:5000",
      "http://localhost:5173"
    ]
  }
}
```

### 2.2 Production (appsettings.json)

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Warning"
    }
  },
  "KeyVault": {
    "Uri": "https://pominigames-kv.vault.azure.net/"
  },
  "Cors": {
    "AllowedOrigins": [
      "https://pominigames.azure.com"
    ]
  }
}
```

## 3. Secrets Management

### 3.1 Azure Key Vault Secrets

| Secret Name | Description |
|-------------|-------------|
| AzureTableStorage | Connection string for Azure Storage |
| AppInsights-ConnectionString | Application Insights key |

### 3.2 Secret Loading Order

1. **Development:** Load from `appsettings.Development.json`
2. **Production:** Load from Azure Key Vault via `KeyVault:Uri`

### 3.3 Key Vault Configuration (Program.cs)

```csharp
var keyVaultUri = builder.Configuration["KeyVault:Uri"];
if (!string.IsNullOrEmpty(keyVaultUri))
{
    builder.Configuration.AddAzureKeyVault(
        new Uri(keyVaultUri),
        new DefaultAzureCredential(),
        new KeyVaultSecretManager());
}
```

## 4. CI/CD Pipeline

### 4.1 GitHub Actions Workflow

```yaml
name: Build and Deploy

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup .NET
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'
      
      - name: Restore dependencies
        run: dotnet restore
        
      - name: Build
        run: dotnet build --configuration Release
        
      - name: Test
        run: dotnet test --configuration Release
        
  deploy:
    needs: build
    runs-on: ubuntu-latest
    
    steps:
      - name: Login to Azure
        uses: azure/login@v2
        
      - name: Deploy to Azure
        uses: azure/webapps-container-deploy@v1
```

### 4.2 Build Process

```
1. Checkout code
2. Install .NET 10 SDK
3. Restore NuGet packages
4. Build solution (Release)
5. Run unit tests
6. Run integration tests
7. Build React client (npm run build)
8. Publish .NET application
9. Deploy to Azure App Service
```

## 5. Docker Configuration

### 5.1 Dockerfile

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY bin/Release/net10.0/publish/ .
COPY wwwroot ./wwwroot
ENTRYPOINT ["dotnet", "PoMiniGames.dll"]
```

### 5.2 Docker Compose (Local)

```yaml
services:
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite
    ports:
      - "10000:10000"
      - "10001:10001"
      - "10002:10002"
    volumes:
      - azurite-data:/data
    command: "azurite --blobHost 0.0.0.0 --queueHost 0.0.0.0 --tableHost 0.0.0.0 --loose"
    restart: unless-stopped

volumes:
  azurite-data:
```

## 6. Azure Infrastructure

### 6.1 Required Resources

| Resource | Type | Purpose |
|----------|------|---------|
| PoMiniGames | App Service | Hosting |
| pomigamesstorage | Storage Account | Table Storage |
| pomigames-kv | Key Vault | Secrets |
| Application Insights | Monitor | Logging |

### 6.2 Network Configuration

- Public access enabled (for now)
- Future: VNet integration
- CORS configured per environment

## 7. Monitoring

### 7.1 Application Insights

**Configuration:**
- Connection string stored in Key Vault
- Custom events for game plays
- Request tracking for API calls

### 7.2 Logging (Serilog)

**Development:**
- Console output with timestamp
- Log level: Information

**Production:**
- File output (rolling daily)
- Log level: Warning
- Retention: 7 days

## 8. Health Checks

### 8.1 Endpoint

```
GET /api/health
```

**Response:**
```json
{
  "status": "Healthy",
  "checks": [
    {
      "name": "AzureTableStorage",
      "status": "Healthy"
    }
  ]
}
```

### 8.2 Azure Health Checks

- Configured in Azure Portal
- Interval: 30 seconds
- Timeout: 10 seconds
- Unhealthy threshold: 3

## 9. Rollback Procedure

### 9.1 Azure Portal Rollback

1. Navigate to App Service
2. Go to Deployment Center
3. Select previous deployment
4. Click "Redeploy"

### 9.2 Manual Rollback

```bash
az webapp deployment slot swap \
  --resource-group PoMiniGames \
  --name PoMiniGames \
  --slot production \
  --target-slot staging
```

## 10. Security Checklist

- [ ] Azure Managed Identity enabled
- [ ] Key Vault firewall configured
- [ ] CORS restricted to known origins
- [ ] HTTPS enforced in production
- [ ] Logging sensitive data avoided
- [ ] Secrets not in source control

## 11. Deployment Checklist

- [ ] Tests pass locally
- [ ] Version bumped in Directory.Build.props
- [ ] Release build successful
- [ ] Docker image builds
- [ ] Azure resources exist
- [ ] Key Vault secrets set
- [ ] Health check passes
- [ ] Smoke test passes
