# PoMiniGames — DevOps & Onboarding

## Day 1: Local Development Setup

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| .NET SDK | 10.0+ | `winget install Microsoft.DotNet.SDK.10` |
| Node.js | 24 LTS | `winget install OpenJS.NodeJS.LTS` |
| Azure CLI | latest | `winget install Microsoft.AzureCLI` |
| azd | latest | `winget install Microsoft.Azd` |
| Git | latest | `winget install Git.Git` |

### Clone and Run (API + Client)

```bash
git clone https://github.com/<org>/PoMiniGames.git
cd PoMiniGames

# Restore .NET packages
dotnet restore

# Install client dependencies
cd src/PoMiniGames.Client && npm install && cd ../..

# Set local dev secrets (Microsoft OAuth)
cd src/PoMiniGames/PoMiniGames
dotnet user-secrets set "PoMiniGames:MicrosoftAuth:ClientId" "<your-client-id>"
dotnet user-secrets set "PoMiniGames:MicrosoftAuth:ApiClientId" "<your-api-client-id>"
dotnet user-secrets set "PoMiniGames:MicrosoftAuth:Authority" "https://login.microsoftonline.com/<tenant>/v2.0"
cd ../../..

# Launch API (port 5000/5001) and Vite dev server (port 5173) via VS Code
# Press F5 — runs prelaunch tasks: kill-dotnet, start-client
```

### Dev Auth Bypass (no Microsoft account needed)

```bash
# Create a dev session as any user
curl -X POST http://localhost:5000/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"userId":"dev-alice","displayName":"Alice","email":"alice@dev.local"}'

# Or use URL-param bypass
curl -s "http://localhost:5000/api/auth/dev-bypass?user=Alice"

# Verify identity
curl http://localhost:5000/api/auth/me --cookie "PoMiniGames.DevAuth=..."
```

### Docker Compose (All-in-one)

```yaml
# docker-compose.yml — run locally without VS Code
version: "3.9"
services:
  api:
    build:
      context: .
      dockerfile: src/PoMiniGames/PoMiniGames/Dockerfile
    ports:
      - "5000:8080"
    environment:
      - ASPNETCORE_ENVIRONMENT=Development
      - Sqlite__DataDirectory=/data
      - PoMiniGames__MicrosoftAuth__ClientId=${MSAL_CLIENT_ID}
      - PoMiniGames__MicrosoftAuth__ApiClientId=${MSAL_API_CLIENT_ID}
      - PoMiniGames__MicrosoftAuth__Authority=${MSAL_AUTHORITY}
    volumes:
      - sqlite-data:/data

  client:
    build:
      context: src/PoMiniGames.Client
      dockerfile: Dockerfile
    ports:
      - "5173:80"
    environment:
      - VITE_API_BASE_URL=http://localhost:5000

volumes:
  sqlite-data:
```

```bash
# Copy secrets to .env
cp .env.example .env   # fill MSAL_CLIENT_ID, MSAL_API_CLIENT_ID, MSAL_AUTHORITY

docker compose up --build
# API: http://localhost:5000
# Client: http://localhost:5173
```

---

## CI/CD Pipeline

### Pipeline Overview (`/.github/workflows/deploy.yml`)

```
Trigger: push to master  |  manual workflow_dispatch
                ↓
          [build] job
          ├── checkout
          ├── setup .NET 10
          ├── dotnet build → PoMiniGames.csproj
          ├── setup Node 24
          ├── npm install + npm run build (Vite)
          ├── dotnet publish (Release, linux-x64)
          └── upload artifacts: api-publish, client-build
                ↓
        [deploy-services] job   (needs: build)
          ├── az login (OIDC federation)
          ├── az resource list → resolve App Service name
          ├── zip api-deploy.zip → az webapp deploy
          └── azure/static-web-apps-deploy → client bundle
```

### Required GitHub Secrets

| Secret | Description |
|---|---|
| `AZURE_CLIENT_ID` | OIDC federated service principal client ID |
| `AZURE_TENANT_ID` | Azure tenant ID (Punkouter26) |
| `AZURE_SUBSCRIPTION_ID` | `Bbb8dfbe-9169-432f-9b7a-fbf861b51037` |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | SWA deployment token (from Azure portal) |

### OIDC Federation Setup (one-time)

```bash
# Create app registration for GitHub Actions
az ad app create --display-name "PoMiniGames-GH-Actions"

# Add federated credential (GitHub OIDC)
az ad app federated-credential create \
  --id <APP_ID> \
  --parameters '{"name":"gh-actions","issuer":"https://token.actions.githubusercontent.com","subject":"repo:<org>/PoMiniGames:ref:refs/heads/master","audiences":["api://AzureADTokenExchange"]}'

# Assign Contributor on the resource group
az role assignment create \
  --assignee <APP_ID> \
  --role Contributor \
  --scope /subscriptions/Bbb8dfbe-9169-432f-9b7a-fbf861b51037/resourceGroups/PoMiniGames
```

---

## Azure Provisioning (First Time)

```bash
azd auth login

# Provision all Azure resources (creates rg-PoMiniGames)
azd provision
# Parameters: name=pominigames-prod, location=westus2

# Deploy code after provisioning
azd deploy

# Or do both in one command
azd up
```

### Resources Created by `azd provision`

| Resource | Type | Tier |
|---|---|---|
| App Service | Linux Web App | B1 (asp-poshared-linux shared plan) |
| Static Web App | SWA | Free |
| Key Vault | kv-poshared (shared) | Standard |
| Application Insights | Workspace-based | Pay-as-you-go |

### App Service Configuration (set automatically by Bicep)

| App Setting | Value |
|---|---|
| `Sqlite__DataDirectory` | `/home/data` |
| `PoMiniGames__ApplicationInsights__ConnectionString` | From Key Vault ref |
| `PoMiniGames__KeyVault__Uri` | `https://kv-poshared.vault.azure.net/` |
| `PoMiniGames__Cors__AllowedOrigins__0` | SWA default hostname |
| `PoMiniGames__Cors__AllowedOrigins__1` | `http://localhost:5173` |

---

## Environment Secrets (Key Vault — kv-poshared)

All secrets stored in Azure Key Vault and fetched at API startup via Managed Identity:

| Secret Name | Description |
|---|---|
| `PoMiniGames--MicrosoftAuth--ClientId` | OAuth2 app client ID (SPA registration) |
| `PoMiniGames--MicrosoftAuth--ApiClientId` | API audience (JWT validation) |
| `PoMiniGames--MicrosoftAuth--Authority` | `https://login.microsoftonline.com/{tenant}/v2.0` |
| `PoMiniGames--ApplicationInsights--ConnectionString` | Application Insights connection string |

> Locally use `dotnet user-secrets` — format mirrors Key Vault names with `--` replaced by `:`.

---

## Testing

### Unit Tests
```bash
dotnet test tests/PoMiniGames.UnitTests/PoMiniGames.UnitTests.csproj
```

### Integration Tests (requires Docker for Testcontainers)
```bash
dotnet test tests/PoMiniGames.IntegrationTests/PoMiniGames.IntegrationTests.csproj
```

### E2E Tests (Playwright)
```bash
cd tests/e2e
npm install
npx playwright install chromium

# Run headless (CI mode)
npx playwright test

# Run headed (dev mode)
npx playwright test --headed

# Run single spec
npx playwright test tictactoe.spec.js --headed
```

### Smoke Test (Post-Deploy)
```bash
# Run the smoke script against a live environment
powershell -File scripts/smoke-local.ps1

# Or manually
curl https://<api-hostname>/api/health/ping   # expect: "pong"
curl https://<api-hostname>/api/health        # expect: {"status":"Healthy",...}
```

---

## Monitoring & Observability

| Signal | Tool | Access |
|---|---|---|
| Traces | Application Insights | Azure portal → Application Insights |
| Logs (file) | Serilog → `/home/logs/` | Kudu console or Log Stream |
| Metrics | App Service metrics | Azure portal → App Service |
| Health | `/api/health` endpoint | HTTP GET — JSON response |
| Diagnostics | `/diag` endpoint | HTTP GET — masked config (dev/staging only) |

### View Live Logs
```bash
az webapp log tail \
  --resource-group PoMiniGames \
  --name <APP_NAME>
```
