# AGENT.MD — PoMiniGames

Primary context layer for autonomous coding agents. Keep this current.

## What this is
Mobile-first **Blazor WebAssembly** mini-games suite, hosted inside an **ASP.NET Core (.NET 10)** API. The WASM client is served by the host project; there is **no separate frontend server and no CORS** (same origin).

## Solution layout (`PoMiniGames.slnx`)
- `src/PoMiniGames/PoMiniGames` — **host/API** project (Program.cs, Minimal API endpoints, SignalR hubs, serves the WASM client). Acts as the `.API` project.
- `src/PoMiniGames.Client` — Blazor WASM client. **`wwwroot` lives only here.**
- `src/PoMiniGames.Application` — application services, DTOs, diagnostics contracts.
- `src/PoMiniGames.Domain` — domain models / services.
- `src/PoMiniGames.Infrastructure` — storage + health checks (Azure Table Storage).
- `src/PoShared` — shared models/business logic used by both client and API (the `.Shared` library).
- `tests/PoMiniGames.UnitTests` — xUnit unit tests.
- `tests/PoMiniGames.IntegrationTests` — `WebApplicationFactory` + Testcontainers (Azurite).
- `tests/e2e` — Playwright UI/API specs.

## Build & run
- Target framework **net10.0**, pinned via `global.json`. Central settings in `Directory.Build.props` (Nullable + TreatWarningsAsErrors **on** — warnings break the build) and CPM in `Directory.Packages.props`.
- Run: `dotnet run --project src/PoMiniGames/PoMiniGames`. Hardcoded ports **HTTP 5000 / HTTPS 5001**.
- `F5` in VS Code uses `.vscode/launch.json` + `tasks.json` (the `kill-dotnet` task frees ports first).
- First-run setup: `scripts/setup.ps1` (WinGet installs, Azurite container, `az login` check).

## Data & local dev
- Persistence: **Azure Table Storage** via `Azure.Data.Tables` (`StorageService`). DTOs are POCOs converted to `TableEntity` at the persistence boundary.
- Local dev/test storage: **Azurite** in Docker (`docker-compose.yml`, container named `pominigames`). Integration tests start their own Azurite via Testcontainers.
- Prod uses Managed Identity + Key Vault (`PoShared` resource group).

## Auth (see `Features/Auth/` + `Infrastructure/AuthExtensions.cs`)
- Real auth: Microsoft OAuth (JWT bearer). `ValidateIssuer = false` for `common`/`organizations`/`consumers`.
- Dev/Test: **`FakeAuthHandler`** (scheme `FakeAuth`, headers `X-Fake-User` / `X-Fake-Roles`). Dev runtime registration is gated on `IsDevelopment() && Auth:EnableFakeAuth`. Tests register it additively in `TestWebApplicationFactory`.
- **Production guard**: Program.cs throws at startup if the `FakeAuth` scheme is ever registered while `IsProduction()`.
- Routes: `/auth/login/microsoft`, `/auth/logout`, `/auth/me` (reports auth state + whether OAuth is configured; `returnUrl` must be a local relative path). Legacy `/api/auth/*` dev-login routes remain.
- Missing OAuth config degrades gracefully (boots + logs a warning).

## Observability
- Serilog → Console + File (dev) + **Application Insights** (non-dev when a connection string is present). Enriched with `UserId` / `SessionId` / `CorrelationId`.
- OpenTelemetry via `UseAzureMonitor` for traces/metrics/dependencies + **Live Metrics**. `service.name` (→ `cloud_RoleName`) is set to the assembly name. Sampling: 100% in dev/test, ~10% in prod; errors always logged.
- Diagnostics: `/health` (clean JSON) and `/diag` (masked keys + integration status, feature-flag gated). OpenAPI via **Scalar**. `.http` files in the host project.

## Conventions
- Solution prefix `Po`. New games are split across multiple files (mirroring existing games), never one mega-file.
- Web Audio API for all sound effects (no `<audio>` tags).
- A `USING MOCK DATA` banner shows in the nav when `FeatureFlags:UseMockData` is set (mock-service environments).
- Document GoF/SOLID patterns with `<remarks>` explaining the architectural reasoning.

See `C:\Users\…\.claude\CLAUDE.md` NET_1_RULES for the full engineering standard this repo targets.
