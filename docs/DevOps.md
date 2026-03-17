# DevOps.md — Deployment, Onboarding & Operations

**Project:** PoMiniGames | **IaC:** Azure Bicep + `azd` | **CI/CD:** GitHub Actions

---

## Environments

| Environment | API | Client | Storage | Auth |
|---|---|---|---|---|
| **Local Dev** | `http://localhost:5000` | `http://localhost:5173` | SQLite `data/pominigames.db` | DevCookie fake auth |
| **Production** | Azure App Service (HTTPS) | Azure Static Web App (CDN) | SQLite `/home/data/` + Key Vault | Microsoft OAuth2 JWT |

---

## Day 1: Local Setup

### Prerequisites

- .NET 10 SDK (`dotnet --version` → `10.x`)
- Node.js 20+ (`node --version`)
- Git

### Run Backend (API)

```bash
cd src/PoMiniGames/PoMiniGames
dotnet user-secrets set "PoMiniGames:MicrosoftAuth:ClientId" "<your-client-id>"
dotnet run
# API available at http://localhost:5000
# Scalar UI at http://localhost:5000/scalar
```

### Run Frontend (React)

```bash
cd src/PoMiniGames.Client
npm install
npm run dev
# Client at http://localhost:5173
```

### Run Both (VS Code)

Use the `prelaunch` task in `.vscode/tasks.json` — kills any running dotnet processes then starts the client.

---

## Day 1: Docker Compose (Template)

> Create a `Dockerfile` at `src/PoMiniGames/PoMiniGames/Dockerfile` first (template below), then use this compose.

**Dockerfile** (`src/PoMiniGames/PoMiniGames/Dockerfile`):
```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
WORKDIR /app
EXPOSE 5000

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app/publish

FROM base AS final
COPY --from=build /app/publish .
VOLUME ["/app/data"]
ENV ASPNETCORE_URLS=http://+:5000
ENV Sqlite__DataDirectory=/app/data
ENTRYPOINT ["dotnet", "PoMiniGames.dll"]
```

**docker-compose.yml** (place at workspace root):
```yaml
version: '3.8'
services:
  api:
    build:
      context: ./src/PoMiniGames/PoMiniGames
    ports:
      - "5000:5000"
    volumes:
      - sqlite_data:/app/data
    environment:
      - ASPNETCORE_URLS=http://+:5000
      - Sqlite__DataDirectory=/app/data
      - FeatureFlags__EnableSwagger=true

  client:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./src/PoMiniGames.Client:/app
    ports:
      - "5173:5173"
    command: sh -c "npm install && npm run dev -- --host"
    depends_on:
      - api

volumes:
  sqlite_data:
```

---

## Configuration & Secrets

### Config Loading Order

```
appsettings.json
  → appsettings.Development.json
    → dotnet user-secrets (local dev)
      → Environment variables
        → Azure Key Vault (production)
```

### Key Environment Variables

| Variable | Description | Where |
|---|---|---|
| `PoMiniGames:ApplicationInsights:ConnectionString` | App Insights telemetry key | Key Vault / App Service settings |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Alternate AI key (fallback) | App Service settings |
| `PoMiniGames:KeyVault:Uri` | Key Vault URI — enables secret pull | App Service settings |
| `PoMiniGames:MicrosoftAuth:ClientId` | OAuth2 app client ID | Key Vault → `PoMiniGames--MicrosoftAuth--ClientId` |
| `PoMiniGames:MicrosoftAuth:ApiClientId` | API client ID for JWT audience | Key Vault |
| `Sqlite__DataDirectory` | SQLite file directory | App Service settings (set to `/home/data`) |

### Shared Key Vault

- **Name:** `kv-poshared` in `rg-PoShared`
- **Access:** App Service Managed Identity granted `Key Vault Secrets User`
- **Naming convention:** `PoMiniGames--Section--Key` (double dash = colon in config)

### Local Secrets

```bash
cd src/PoMiniGames/PoMiniGames
dotnet user-secrets set "PoMiniGames:MicrosoftAuth:ClientId"    "<value>"
dotnet user-secrets set "PoMiniGames:MicrosoftAuth:ApiClientId" "<value>"
dotnet user-secrets set "PoMiniGames:ApplicationInsights:ConnectionString" "<value>"
```

---

## CI/CD Pipeline (GitHub Actions)

### Trigger

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
```

### Stages

```
1. Checkout → 2. Install .NET 10 → 3. dotnet build → 4. dotnet publish
                                                          ↓
5. Install Node 20 → 6. npm install → 7. npm run build
                                          ↓
8. Upload API artifact ─────────────────────────────────────────────┐
9. Upload dist artifact ────────────────────────────────────────────┤
                                                                     ↓
10. Deploy API → Azure App Service (azd deploy / zip deploy)
11. Deploy Client → Azure Static Web App (SWA CLI)
12. POST /api/health → smoke test
```

### Azure Resources

| Resource | Type | Tier | RG |
|---|---|---|---|
| `app-{token}` | App Service (Linux) | Shared B1 plan | rg-PoMiniGames |
| `stapp-{token}` | Static Web App | Free | rg-PoMiniGames |
| `kv-poshared` | Key Vault | Standard | rg-PoShared |
| `poappideinsights8f9c9a4e` | Application Insights | Pay-as-you-go | rg-PoShared |
| `asp-poshared-linux` | App Service Plan | B1 Linux | rg-PoShared |

### Required GitHub Secrets

| Secret | Description |
|---|---|
| `AZURE_CREDENTIALS` | Service principal JSON for `az login` |
| `AZURE_SUBSCRIPTION_ID` | Subscription: `Bbb8dfbe-9169-432f-9b7a-fbf861b51037` |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | SWA deployment token |

---

## IaC — Azure Bicep / azd

```bash
# First-time provision
azd auth login
azd provision          # creates rg-PoMiniGames, deploys resources.bicep

# Deploy code only (no infra changes)
azd deploy

# Provision + deploy together
azd up
```

`main.bicep` targets `subscription` scope and creates `rg-PoMiniGames`. It also deploys `kv-access.bicep` to grant the Web App's Managed Identity `Key Vault Secrets User` on `kv-poshared` in `rg-PoShared`.

---

## Health & Observability

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health/ping` | None | Liveness probe — returns 200 OK |
| `GET /api/health` | None | Full health — checks SQLite, config |
| `GET /diag` | None | Masked config dump (EnableDiagnostics flag) |

**Monitoring stack:**
- Serilog → rolling file `logs/pominigames-{date}.log` (dev) + console + AI sink (prod)
- OpenTelemetry Azure Monitor exporter wired to App Insights
- App Insights traces, dependencies, exceptions, custom metrics

---

## Blast Radius Assessment

> Impact analysis for common refactors. Review before merging infrastructure or breaking API changes.

| Change | Downstream Impact | Safe to Deploy Without |
|---|---|---|
| Rename SQLite schema (column/table) | Breaks `StorageService` and all `PlayerStats`, `SnakeHighScore`, `PoDropSquareHighScore` reads | DB migration script |
| Change `/api/{game}/players/{id}/stats` shape | Breaks `statsService.ts` sync; offline queue stores stale format | Client deploy in same release |
| Change JWT audience (`ApiClientId`) | All authenticated SignalR connections and stats PUTs fail | Coordinated auth config update |
| Remove `DevCookie` auth scheme | E2E tests break (Playwright uses `/dev-login`); integration tests (`LocalAuthWebApplicationFactory`) fail | Update test infra first |
| Change CORS allowed origins | Client blocked from API in any environment not listed | Config update before code deploy |
| Modify Key Vault secret names | App fails to start if required secrets not found | Dual-write period: keep old name until deploy settles |
| Update `StorageService` partition key logic | Existing leaderboard data becomes invisible (queries return empty) | Data migration before deploy |
| Replace SQLite with SQL Server/Redis | Breaks `StorageServiceInitializer`, all CRUD services, integration tests (Testcontainers config) | Full service layer rewrite + test update |
| Remove `MultiplayerHub` / `LobbyHub` | Breaks Online PvP and Lobby page in React client | Feature-flag gate before removal |

---

## Testing Strategy

| Layer | Tool | Location | Command |
|---|---|---|---|
| Unit | xUnit | `tests/PoMiniGames.UnitTests/` | `dotnet test tests/PoMiniGames.UnitTests/` |
| Integration | xUnit + Testcontainers | `tests/PoMiniGames.IntegrationTests/` | `dotnet test tests/PoMiniGames.IntegrationTests/` |
| E2E | Playwright (TS) | `tests/e2e/` | `npx playwright test` |
| Smoke (local) | PowerShell | `scripts/smoke-local.ps1` | `.\scripts\smoke-local.ps1` |

**Auth bypass for tests:** `TestWebApplicationFactory` uses `TestAuthHandler`; `LocalAuthWebApplicationFactory` uses `AddTestAuth()` + `/dev-login` to fake Microsoft OAuth without real credentials.

---

## Microsoft OAuth Setup

```bash
# Register app in Azure AD, then:
cd scripts
.\setup-microsoft-oauth.ps1
```

Configure redirect URI in Azure Portal:
- Dev: `http://localhost:5000/auth/callback`
- Prod: `https://<your-app-service>.azurewebsites.net/auth/callback`
