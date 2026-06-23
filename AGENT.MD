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
- `src/PoMiniGames.Application` — application services, DTOs, diagnostics contracts.
- `src/PoMiniGames.Domain` — domain models / services.
- `src/PoMiniGames.Infrastructure` — shared platform persistence + health checks (Azure Table Storage).
- `src/PoShared` — shared models/business logic used by both client and API (the `.Shared` library). Trim-clean (no IL suppressions).
- `tests/PoMiniGames.UnitTests` — xUnit unit tests, mirrored under `Features/<Slice>/`.
- `tests/PoMiniGames.IntegrationTests` — `WebApplicationFactory` + **Testcontainers.Azurite** (v4 module).
- `tests/PoMiniGames.E2EAPI` — C# end-to-end **API** tests: in-process host via `WebApplicationFactory`, pure HTTP-contract asserts (no browser).
- `tests/PoMiniGames.E2EUI` — C# end-to-end **UI** tests: Microsoft.Playwright drives a real browser against the host on a live Kestrel port.

## Build & run
- Target framework **net10.0**, pinned via `global.json`. Central settings in `Directory.Build.props` (Nullable + TreatWarningsAsErrors **on** — warnings break the build; TFM/Nullable/ImplicitUsings are inherited, **do not redeclare them in csproj**) and CPM in `Directory.Packages.props`.
- **Security gate**: NuGet vulnerability auditing is on (`NuGetAudit`/`NuGetAuditMode=all`) and **not** suppressed — a known-CVE package fails the build. Transitive security pins (e.g. `OpenTelemetry.Api`, IdentityModel) live in `Directory.Packages.props`.
- Run: `dotnet run --project src/PoMiniGames/PoMiniGames`. Hardcoded ports **HTTP 5000 / HTTPS 5001**.
- `F5` in VS Code uses `.vscode/launch.json` + `tasks.json`. The `prelaunch` task runs in sequence: `kill-dotnet` (frees port 5000) → `start-azurite` (`docker compose up -d azurite`, so local storage is always the Docker container) → `start-api`. Disable any non-Docker Azurite (e.g. the VS Code Azurite extension) so the `pominigames` container can bind ports 10000–10002.
- First-run setup: `scripts/setup.ps1` (WinGet installs, Azurite container, `az login` check).

## Data & local dev
- Persistence: **Azure Table Storage** via `Azure.Data.Tables` (`StorageService`). DTOs are POCOs converted to `TableEntity` at the persistence boundary.
- Local dev/test storage: **Azurite** in Docker (`docker-compose.yml`, container named `pominigames`). Integration tests start their own Azurite via Testcontainers.
- Prod uses Managed Identity + Key Vault (`PoShared` resource group).
- **Caching**: native `HybridCache` (`AddHybridCache`) memoizes deterministic, expensive Azure OpenAI
  calls (PoCoupleQuiz answer-similarity scoring). Non-deterministic generations (questions) stay uncached.

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

## Documentation
- **AGENT.MD (this file) is the single source of truth.** [`docs/README.md`](docs/README.md) is the
  doc index; the prose docs under `docs/` are point-in-time analysis (may have drifted) and the
  `.mmd` files are diagrams catalogued in the root `README.md`.

See `C:\Users\…\.claude\CLAUDE.md` NET_1_RULES for the full engineering standard this repo targets.
