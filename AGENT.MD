# AGENT.MD — PoMiniGames

Primary context layer for autonomous coding agents. Keep this current.

## What this is
Mobile-first **Blazor WebAssembly** mini-games suite, hosted inside an **ASP.NET Core (.NET 10)** API. The WASM client is served by the host project; there is **no separate frontend server and no CORS** (same origin).

## Architecture
**Hybrid**: a layered core (Domain / Application / Infrastructure) under a **host that
organises its own endpoints as vertical slices** (`Features/<Slice>/`). This is deliberate —
the layered projects hold cross-cutting platform code; each game owns its HTTP/hub surface,
contracts, and (where it has its own tables) persistence inside its slice folder.

### Persistence boundary rule (authoritative — keep drift out)
There is exactly one home for each kind of persistence:
- **Per-game tables/blobs** → live in that game's slice: `Features/<Slice>/Storage/`
  (e.g. `PoFunQuiz/Storage/LeaderboardRepository`, `PoCoupleQuiz/Storage/TeamsRepository`).
- **Shared platform persistence** → `src/PoMiniGames.Infrastructure`
  (`StorageService` = the shared `TableServiceClient` factory + Elo, the PoSurvive
  `Persistence/TableStorage` repos, and the storage health checks).
- **Host composition root** → `src/PoMiniGames/PoMiniGames/Infrastructure/`
  (registration + lifecycle only: `StorageExtensions`, `StorageInitializer`, DataProtection).
A new game adds its repo under its own `Storage/` folder; it must NOT add a repository to
the shared Infrastructure project unless the data is genuinely cross-slice.

## Solution layout (`PoMiniGames.slnx`)
- `src/PoMiniGames/PoMiniGames` — **host/API** project (Program.cs, feature-sliced Minimal API
  endpoints + SignalR hubs, serves the WASM client). Acts as the `.API` project. The full route
  table is registered in one place: `Infrastructure/EndpointRouteExtensions.MapPoMiniGamesEndpoints`.
- `src/PoMiniGames.Client` — Blazor WASM client. **`wwwroot` lives only here.**
  - `Games/` — **11 client-only mini-games** with no server slice (no Features/ counterpart, no telemetry, no leaderboard back-end). Pure local-first: `BabyTouch`, `ConnectFive`, `DropSquare`, `Fight`, `HorseRace`, `PoMarbleRace`, `PoRacer` (UI only — scores post to `/api/leaderboard`), `PoRunner`, `SnakeGame`, `TicTacToe`, `VoxelShooter`. Keep them in the client project; do **not** mirror them under `src/PoMiniGames/PoMiniGames/Features/`.
- `src/PoMiniGames.Application` — application services, DTOs, diagnostics contracts.
- `src/PoMiniGames.Domain` — domain models / services.
- `src/PoMiniGames.Infrastructure` — shared platform persistence + health checks (Azure Table Storage). AI resilience helpers live exclusively under `PoMiniGames.AI` (see host project) — the migration window with two AI namespaces is closed.
- AI namespace policy: every AI-touching type lives under `PoMiniGames.AI` and is reachable from the host project via `src/PoMiniGames/PoMiniGames/GlobalUsings.cs`. Per-slice files (PoCoupleQuiz / PoFace / PoFunQuiz / PoJoker / PoSurvive) do not need `using PoMiniGames.AI;` — the global using wires it. New AI consumers must use the same flat namespace; no `PoMiniGames.Infrastructure.AI` or other AI sub-namespace is permitted (the analyzer will flag any new duplicates).
- `src/PoShared` — shared models/business logic used by both client and API (the `.Shared` library). Trim-clean (no IL suppressions). `PoShared/Games/` holds game-agnostic DTOs (e.g. `PoJoker/JokeDtos.cs`, `PoRacerShared.cs`) shared between client and host.
- `tests/PoMiniGames.Unit` — xUnit unit tests, mirrored under `Features/<Slice>/`. Project name = `PoMiniGames.Unit`, namespace `PoMiniGames.Unit.*` (`<sln>.<Tier>` convention).
- `tests/PoMiniGames.Integration` — `WebApplicationFactory` + **Testcontainers.Azurite** (v4 module). Project name = `PoMiniGames.Integration`, namespace `PoMiniGames.Integration.*`.
- `tests/E2EAPI` — C# end-to-end **API** tests: in-process host via `WebApplicationFactory`, pure HTTP-contract asserts (no browser). (Namespace `PoMiniGames.E2EAPI` unchanged.)
- `tests/E2EUI` — C# end-to-end **UI** tests: Microsoft.Playwright drives a real browser against the host on a live Kestrel port. (Namespace `PoMiniGames.E2EUI` unchanged.)
- `tests/Shared/` (`PoMiniGames.TestUtilities.csproj`) — shared test utilities (assertion helpers, budget guards) referenced by all four test projects.

## Build & run
- Target framework **net10.0**, pinned via `global.json`. Central settings in `Directory.Build.props` (Nullable + TreatWarningsAsErrors **on** — warnings break the build; TFM/Nullable/ImplicitUsings are inherited, **do not redeclare them in csproj**) and CPM in `Directory.Packages.props`.
- **Security gate**: NuGet vulnerability auditing is on (`NuGetAudit`/`NuGetAuditMode=all`) and **not** suppressed — a known-CVE package fails the build. Transitive security pins (e.g. `OpenTelemetry.Api`, IdentityModel) live in `Directory.Packages.props`.
- Run: `dotnet run --project src/PoMiniGames/PoMiniGames`. Hardcoded ports **HTTP 5000 / HTTPS 5001**.
- `F5` in VS Code uses `.vscode/launch.json` + `tasks.json`. The `prelaunch` task runs in sequence: `kill-dotnet` (frees port 5000) → `start-azurite` (`docker compose up -d azurite`, so local storage is always the Docker container) → `start-api`. Disable any non-Docker Azurite (e.g. the VS Code Azurite extension) so the `pominigames` container can bind ports 10000–10002.
- First-run setup: `scripts/setup.ps1` (WinGet installs, Azurite container, `az login` check).

## Branches
- **master is the only branch.** No local or remote feature branches. All work lands
  directly on `master` via PRs. Delete any branch (local or remote) the moment a
  change is merged.

## Data & local dev
- Persistence: **Azure Table Storage** via `Azure.Data.Tables` (`StorageService`). DTOs are POCOs converted to `TableEntity` at the persistence boundary.
- Local dev/test storage: **Azurite** in Docker (`docker-compose.yml`, container named `pominigames`). Integration tests start their own Azurite via Testcontainers.
- Prod uses Managed Identity + Key Vault (`PoShared` resource group).
- **Caching**: native `HybridCache` (`AddHybridCache`) memoizes deterministic, expensive Azure OpenAI
  calls (PoCoupleQuiz answer-similarity scoring). Non-deterministic generations (questions) stay uncached.

## Auth (see `Features/Auth/` + `Infrastructure/AuthExtensions.cs`)
- **Auth gate is unconditional.** `App.razor` wraps the entire `<Router>` in
  `<AuthGate>`, which shows `<LoginScreen />` until `AuthState.IsAuthenticated`.
  No route renders for unauthenticated users — the home page is gated just like
  any other route.
- Real auth: Microsoft OAuth (JWT bearer). `ValidateIssuer = true` with a custom
  `MicrosoftAuthIssuerValidator` that allow-lists `common`/`organizations`/`consumers`
  plus any tenant IDs in `PoMiniGames:MicrosoftAuth:AllowedTenantIds`.
- **Authority**: `https://login.microsoftonline.com/common/v2.0` (multitenant + personal).
  AAD app registration must be created with
  `--sign-in-audience AzureADandPersonalMicrosoftAccount`. See [`docs/auth/README.md`](docs/auth/README.md).
- **Environment → auth-surface map** (canonical; `AuthEndpoints` + `AuthExtensions` + `LoginScreen.razor`):
  | Environment | Sign-in options | Notes |
  |---|---|---|
  | `Development` (local dotnet run / Azure dev slot) | Microsoft OAuth **+** Continue as Guest | LoginScreen shows both buttons. `Auth:AutoGuestLogin` opt-in via `?autoGuest=1`. |
  | `Test` (integration / E2E / E2E-UI fixtures) | Guest dev-bypass only (auto via `?autoGuest=1` or `X-Fake-User` header) | No manual OAuth in tests. StartupSecretValidator skips secrets check. |
  | `Production` (Azure App Service) | Microsoft OAuth **only** | Guest button hidden. `Auth:AutoGuestLogin` forbidden. `FakeAuth` scheme forbidden. StartupSecretValidator throws if `MicrosoftAuth:ClientId`/`ApiClientId` are missing. |
- Dev: **`FakeAuthHandler`** (scheme `FakeAuth`, headers `X-Fake-User` / `X-Fake-Roles`),
  gated on `(IsDevelopment() || IsEnvironment("Test")) && Auth:EnableFakeAuth`. Tests register it additively in
  `TestWebApplicationFactory`.
- Dev/Test: **DevCookie** (scheme `PoMiniGames.DevAuth`, HttpOnly, SameSite=Lax) +
  `/auth/login/fake` route mints a guest identity. Gated on `IsDevelopment() || IsEnvironment("Test")`
  **and** loopback peer — 404 in Production and from non-loopback clients.
- **Production guards**:
  1. `Program.cs` throws if `FakeAuth` scheme is registered in Production.
  2. `Program.cs` throws if `Auth:AutoGuestLogin` is `true` in Production.
  3. `StartupSecretValidator` throws if `PoMiniGames:KeyVault:Uri`,
     `PoMiniGames:Storage:TableService:Endpoint`, `MicrosoftAuth:ClientId`, or
     `MicrosoftAuth:ApiClientId` are missing in Production.
- Routes: `/auth/login/microsoft`, `/auth/login/fake` (Dev/Test), `/auth/logout`,
  `/auth/me` (reports auth state + `oauthConfigured` flag; `returnUrl` must be a
  local relative path). Legacy `/api/auth/*` dev-login routes remain.
- **Test environment wiring** (canonical — every test fixture uses `UseEnvironment("Test")`):
  `tests/PoMiniGames.Integration/TestWebApplicationFactory.cs`, `LocalAuthWebApplicationFactory.cs`,
  `AzuriteHealthIntegrationTests.cs`; `tests/E2EAPI/PoMiniGamesE2EFixture.cs`;
  `tests/E2EUI/KestrelServerFixture.cs`. The Test branch in
  `StartupSecretValidator` (line 79-83) and `AuthExtensions` (line 30) was
  defensive dead code before 2026-06-27; it now activates on every test run.

## Observability
- Serilog → Console + File (dev) + **Application Insights** (non-dev when a connection string is present). Enriched with `UserId` / `SessionId` / `CorrelationId`.
- OpenTelemetry via `UseAzureMonitor` for traces/metrics/dependencies + **Live Metrics**.
  `cloud_RoleName` is bound to the compile-time constant `TelemetryExtensions.CloudRoleName`
  = `"PoMiniGames"` — never reflect against the executing assembly (which can collide on
  trimming / single-file publish). Sampling: 100% in dev/test, ~10% in prod; errors always logged.
- Diagnostics: a single `/api/health/*` surface — `/api/health` (full health report),
  `/api/health/liveness` (Kubernetes/App Service liveness probe, alias of `/api/health`),
  `/api/health/ping` (zero-dependency `pong` — the cheapest liveness probe the platform
  supports) — plus the legacy `/health` alias kept only for App Service default probes
  (excluded from OpenAPI so new code prefers the `/api/health` shape). `/api/diag`
  exposes masked keys + integration status, feature-flag gated; the SPA only shows raw
  JSON in Development. OpenAPI via **Scalar**. `.http` files in the host project.

## CI/CD
- `.github/workflows/deploy.yml` is **build-only — no tests run in CI.** Tests are
  environment-coupled (Azurite, Playwright Chromium) and execute locally via
  `scripts/test-all.ps1` (tiered Unit → Integration → E2E-API → E2E-UI). This is a
  deliberate policy (header comment in `deploy.yml`): the GitHub runner has no
  Azurite or Playwright browsers.
- Build job compiles every project in the solution (src + tests) under
  `TreatWarningsAsErrors=true` (`Directory.Build.props`), so a broken test file
  fails the build — but tests are NOT *run* in CI.
- Deploy job needs `build`, publishes the host, resolves the App Service by RG name
  (self-healing), zips `publish/`, then runs the three curl smoke tests
  (`/api/health/ping`, `/api/health`, `/api/diag`).

## Secrets & environment config (Azure)
- **Key Vault `kv-poshared`** (PoShared RG) holds the secrets the host reads via
  `PrefixKeyVaultSecretManager("PoMiniGames")` (`--` → `:`). Written at deploy
  time by `infra/kv-secrets.bicep`:
  - `PoMiniGames--StorageAccountName` (mirrored from `resources.bicep` output)
  - `PoMiniGames--AI--FoundryEndpoint` (mirrored from `resources.bicep` output)
  Web App's MI gets `get + list` on the vault via `infra/kv-access.bicep`.
- **App Service app settings** (set by `infra/resources.bicep`):
  `ASPNETCORE_ENVIRONMENT=Production`, `PoMiniGames__ApplicationInsights__ConnectionString`,
  `PoMiniGames__KeyVault__Uri`, `PoMiniGames__Storage__TableService__AccountName|Endpoint|TableName`,
  `PoMiniGames__AI__FoundryEndpoint`, and (since 2026-06-27)
  `PoMiniGames__MicrosoftAuth__ClientId|ApiClientId|Authority`.
- **Microsoft (Entra ID) OAuth client IDs** are NOT secrets — they live as App
  Service app settings, supplied as Bicep parameters (`microsoftAuthClientId`,
  `microsoftAuthApiClientId`, `microsoftAuthTenantId` in `infra/main.bicep`,
  defaulted in `infra/main.parameters.json`). Override per environment via
  `azd env set PoMiniGamesMicrosoftAuthClientId <APP_ID>` (same for
  ApiClientId). A deploy that ships empty ClientIds is caught by
  `StartupSecretValidator` (fails-fast in Production).
- **Local dev** uses `dotnet user-secrets` for Microsoft Auth values (never
  committed); the dev-only fallback path (`Auth:AutoGuestLogin=true` +
  `?autoGuest=1`) keeps iteration unblocked even when no App Registration is
  wired.

## Conventions
- Solution prefix `Po`. New games are split across multiple files (mirroring existing games), never one mega-file.
- Web Audio API for all sound effects (no `<audio>` tags).
- A `USING MOCK DATA` banner shows in the nav when `FeatureFlags:UseMockData` is set (mock-service environments).
- Document GoF/SOLID patterns with `<remarks>` explaining the architectural reasoning.

## Documentation
- **AGENT.MD (this file) is the single source of truth.** [`docs/README.md`](docs/README.md) is the
  doc index; the prose docs under `docs/` are point-in-time analysis (may have drifted) and the
  `.mmd` files are diagrams catalogued in the root `README.md`.

See `C:\Users\…\.claude\CLAUDE.md` NET_1_RULES for the full engineering standard this repo targets.
