# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
# Build (TreatWarningsAsErrors is on; NuGet CVE audit fails the build)
dotnet build PoMiniGames.slnx

# Lint / format (CI enforces --verify-no-changes)
dotnet format PoMiniGames.slnx --verify-no-changes --verbosity minimal
dotnet format PoMiniGames.slnx
# Line endings are pinned to LF by .gitattributes (`* text=auto eol=lf`). That file is
# load-bearing: .editorconfig mandates LF while Windows `core.autocrlf=true` rewrites to
# CRLF, and without the override the format gate failed on ~150 files on every fresh
# clone. Do not remove it, and do not "fix" a CRLF diff by hand.

# Full CI-equivalent test suite (Unit → Integration → E2E-API → E2E-UI).
# Handles preflight itself: frees port 5000, starts Azurite, installs Playwright.
pwsh scripts/test-all.ps1

# Single tier
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj
dotnet test tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj

# Single test
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~EloCalculatorTests"

# Local storage emulator (required — API boot is slow/errors on ports 10000-10002 without it)
docker compose up -d azurite

# Run the app: one host serves API + Blazor WASM client at http://localhost:5000
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj
# `dotnet run` recompiles and can thrash while .razor files are being edited; for a
# stable instance, build once and run the compiled DLL from src/PoMiniGames.API/bin directly.

# Deploy (Azure Bicep + azd; CI is .github/workflows/deploy.yml)
azd up
```

Requires .NET SDK 10.0.203 (global.json) and Docker (Azurite + Testcontainers). CI runs only the Unit tier before deploy; the other tiers are local via `test-all.ps1`.

## Test structure rules

- **100/50/25/25 rule**: the Unit tier is capped at 100 test methods, enforced by `tests/PoMiniGames.Unit/TestCountCeilingTests.cs`. When it trips, consolidate tests or move them to the Integration tier — never raise the cap. The Unit tier is currently at/near the ceiling, so route new tests to Integration by default.
- Tiers: `PoMiniGames.Unit` (hermetic, no I/O) → `PoMiniGames.Integration` (Testcontainers Azurite) → `PoMiniGames.E2EAPI` (WebApplicationFactory HTTP contract) → `PoMiniGames.E2EUI` (Playwright; host runs under the "Test" environment).
- **Any test that POSTs/PUTs/DELETEs `/api/*` must call `client.ArmAntiforgeryAsync()`** (`tests/Shared/AntiforgeryTestExtensions.cs`) or it gets a 403, not the status it asserts. Re-arm after a sign-in — the token is bound to identity claims. Antiforgery is deliberately NOT disabled for the Test environment.
- Without Docker, storage-backed tests fail with `connection refused (127.0.0.1:10002)`. That is the environment, not a regression — `docker compose up -d azurite` first. Integration/E2E tiers are slow (E2EAPI is ~13 min); prefer `--filter` while iterating.

## Architecture

Instant-play mini-games platform: .NET 10 Minimal API host that also serves the Blazor WebAssembly client (single origin, port 5000), with SignalR for real-time multiplayer and Azure Table Storage for persistence.

### Projects (`src/`)

- **PoMiniGames.API** — API host (assembly `PoMiniGames.API`, but `RootNamespace` is pinned to `PoMiniGames` — every file declares `namespace PoMiniGames.*` explicitly and new files must match). Vertical slice architecture: each feature lives in `Features/<Slice>` (Auth, Health, Leaderboard, HighScores, MatchHistory, PoSports, PoRacer, PoJoker, PoSurvive, PoCoupleQuiz, PoFunQuiz, MarbleRace, …) containing its endpoints, hubs, and services. **Every HTTP route and SignalR hub is registered in exactly one place**: `Infrastructure/EndpointRouteExtensions.MapPoMiniGamesEndpoints()`. Auth is applied at the route-group boundary — leaderboard reads are anonymous, all game-data writes require auth; rate limits are declared per slice.
- **PoMiniGames.Client** — Blazor WASM client. Note the assembly/namespace is `PoMiniGamesClient` (csproj `PoMiniGamesClient.csproj`). Each game is a self-contained folder under `Games/` (TicTacToe, ConnectFive, PoBrawl, PoCoupleQuiz, PoFunQuiz, PoJoker, PoMarbleRace, PoRacer, PoSports, PoSurvive) with its page, board/AI logic in C#. JS-heavy games (three.js/cannon-es) keep their engine code under `wwwroot/js/<game>/` — these files are served live from source in dev, no rebuild needed.
- **PoMiniGames.Infrastructure** — Table Storage access. `StorageService` + `HighScoreDescriptor<T>` implement a strategy pattern: one generic save/rank/get flow, one descriptor per game leaderboard. To add a leaderboard, write a descriptor; declare `RowKeyFields` explicitly (immutable identity fields only — usually the player, not the score) and use `ShouldOverwrite` to keep a better score from being clobbered.
- **PoMiniGames.Shared** — models shared between client and server (game state DTOs, identity helpers). **PoMiniGames.Application** / **PoMiniGames.Domain** — application services and domain primitives (EloCalculator, GameKey, PlayerStats).
- Identity strings are hardcoded constants, never reflected from the assembly name: `TelemetryExtensions.CloudRoleName`, `PrefixKeyVaultSecretManager`'s secret prefix, and `DataProtectionExtensions.SetApplicationName("PoMiniGames")`. That last one keys the cookie key-ring purpose — deriving it from the assembly name would invalidate every live auth cookie on the next deploy. Keep them constant.
- Note `PoShared` still appears in the codebase meaning the **Azure resource group** and the Key Vault DNS name `kv-poshared`. It is not the project name; do not rename those.

### Cross-cutting facts

- Auth: Microsoft Entra (MSAL) with a BFF cookie pattern (`BffAuthenticationStateProvider`, encrypted cookies via Data Protection), plus a dev-only DevAuth bypass and guest login. Client gates most pages on auth.
- CSRF: `Infrastructure/AntiforgeryExtensions` validates a synchroniser token on every POST/PUT/PATCH/DELETE under `/api/*`. Scope is exact and load-bearing — SignalR hubs live at their own roots (`/poracer/lobby-hub`, …) so their POST `/negotiate` stays ungated, because the SignalR client cannot be taught to attach the header. `app.UseAntiforgery()` alone would NOT cover this app: since .NET 8 it auto-validates only form-bound endpoints, and every endpoint here takes JSON. On the client, `AntiforgeryHandler` attaches the token transparently; it must sit above `IncludeCredentialsHandler` in the `HttpClient` pipeline so its token fetch carries the paired cookie.
- `GET /health` serves two audiences by `Accept`: `text/html` returns the Blazor shell so `Pages/HealthPage.razor` renders the human status page; anything else (monitors, `HttpClient`, the deploy smoke tests) keeps the legacy JSON report. Content negotiation exists because server routes match ahead of `MapFallbackToFile`, so a Blazor `@page "/health"` would otherwise be permanently shadowed. `/api/health/*` is the canonical JSON surface; `/diag` is the developer configuration dump.
- Storage tables are created automatically on startup; dev uses `UseDevelopmentStorage=true` against Azurite, production uses Managed Identity.
- SignalR hubs are per-game (`/couplequiz/hubs/game`, `/funquiz/gamehub`, `/poracer/lobby-hub`, …) and all require auth; JSON protocol uses camelCase string enums.
- Central package management via `Directory.Packages.props`; versioning via MinVer from git tags.
- `dotnet user-secrets` (id `pomini-games-secret-id`) holds dev auth ClientIds; Key Vault load in dev is non-fatal. (The external NET_RULES doc forbids user-secrets in favour of Key Vault everywhere; this repo keeps them for local dev. Treat that as a standing exception, not an unfixed violation.)

## Conventions and constraints

- **No Radzen.Blazor** (or similar heavy component libraries) — deliberately rejected for bundle size (~1.2 MB). Use native Blazor (`<Virtualize>`, plain CSS). The README's "Radzen UI" mention is outdated, as is its game list — trust `src/PoMiniGames.Client/Games/` and `Features/` over the README tables. Note that the external NET_RULES doc mandates Radzen; this repo's rejection overrides it — do not reintroduce the dependency to satisfy that rule.
- Theming is entirely token-driven: `wwwroot/css/app.css` `:root` defines the palette and a `prefers-color-scheme: light` block re-points only the surface/text/elevation tokens. Components must read colour through those variables, never raw hex, or they will be unthemed in light mode. Accent hues and per-game/canvas tokens are intentionally scheme-invariant.
- `style="..."` in `.razor` files is acceptable **only** to pass a runtime value into a CSS custom property (`style="--hp: @Percent%"`); the static rule still belongs in the scoped `.razor.css`.
- Default branch is `master`. Development is on Windows; repo scripts are PowerShell (`pwsh`).
- Comments in this codebase are dense and contract-oriented (audit/bug-fix annotations); match that style only when a real constraint needs recording.
