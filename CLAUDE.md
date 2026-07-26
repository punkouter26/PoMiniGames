# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
# Build (TreatWarningsAsErrors is on; NuGet CVE audit fails the build)
dotnet build PoMiniGames.slnx

# Lint / format (CI enforces --verify-no-changes)
dotnet format PoMiniGames.slnx --verify-no-changes --verbosity minimal
dotnet format PoMiniGames.slnx

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
dotnet run --project src/PoMiniGames/PoMiniGames.csproj
# `dotnet run` recompiles and can thrash while .razor files are being edited; for a
# stable instance, build once and run the compiled DLL from src/PoMiniGames/bin directly.

# Deploy (Azure Bicep + azd; CI is .github/workflows/deploy.yml)
azd up
```

Requires .NET SDK 10.0.203 (global.json) and Docker (Azurite + Testcontainers). CI runs only the Unit tier before deploy; the other tiers are local via `test-all.ps1`.

## Test structure rules

- **100/50/25/25 rule**: the Unit tier is capped at 100 test methods, enforced by `tests/PoMiniGames.Unit/TestCountCeilingTests.cs`. When it trips, consolidate tests or move them to the Integration tier — never raise the cap. The Unit tier is currently at/near the ceiling, so route new tests to Integration by default.
- Tiers: `PoMiniGames.Unit` (hermetic, no I/O) → `PoMiniGames.Integration` (Testcontainers Azurite) → `E2EAPI` (WebApplicationFactory HTTP contract) → `E2EUI` (Playwright; host runs under the "Test" environment).

## Architecture

Instant-play mini-games platform: .NET 10 Minimal API host that also serves the Blazor WebAssembly client (single origin, port 5000), with SignalR for real-time multiplayer and Azure Table Storage for persistence.

### Projects (`src/`)

- **PoMiniGames** — API host. Vertical slice architecture: each feature lives in `Features/<Slice>` (Auth, Health, Leaderboard, HighScores, MatchHistory, PoSports, PoRacer, PoJoker, PoSurvive, PoCoupleQuiz, PoFunQuiz, MarbleRace, …) containing its endpoints, hubs, and services. **Every HTTP route and SignalR hub is registered in exactly one place**: `Infrastructure/EndpointRouteExtensions.MapPoMiniGamesEndpoints()`. Auth is applied at the route-group boundary — leaderboard reads are anonymous, all game-data writes require auth; rate limits are declared per slice.
- **PoMiniGames.Client** — Blazor WASM client. Note the assembly/namespace is `PoMiniGamesClient` (csproj `PoMiniGamesClient.csproj`). Each game is a self-contained folder under `Games/` (TicTacToe, ConnectFive, PoBrawl, PoCoupleQuiz, PoFunQuiz, PoJoker, PoMarbleRace, PoRacer, PoSports, PoSurvive) with its page, board/AI logic in C#. JS-heavy games (three.js/cannon-es) keep their engine code under `wwwroot/js/<game>/` — these files are served live from source in dev, no rebuild needed.
- **PoMiniGames.Infrastructure** — Table Storage access. `StorageService` + `HighScoreDescriptor<T>` implement a strategy pattern: one generic save/rank/get flow, one descriptor per game leaderboard. To add a leaderboard, write a descriptor; declare `RowKeyFields` explicitly (immutable identity fields only — usually the player, not the score) and use `ShouldOverwrite` to keep a better score from being clobbered.
- **PoShared** — models shared between client and server (game state DTOs, identity helpers). **PoMiniGames.Application** / **PoMiniGames.Domain** — application services and domain primitives (EloCalculator, GameKey, PlayerStats).

### Cross-cutting facts

- Auth: Microsoft Entra (MSAL) with a BFF cookie pattern (`BffAuthenticationStateProvider`, encrypted cookies via Data Protection), plus a dev-only DevAuth bypass and guest login. Client gates most pages on auth.
- Storage tables are created automatically on startup; dev uses `UseDevelopmentStorage=true` against Azurite, production uses Managed Identity.
- SignalR hubs are per-game (`/couplequiz/hubs/game`, `/funquiz/gamehub`, `/poracer/lobby-hub`, …) and all require auth; JSON protocol uses camelCase string enums.
- Central package management via `Directory.Packages.props`; versioning via MinVer from git tags.
- `dotnet user-secrets` (id `pomini-games-secret-id`) holds dev auth ClientIds; Key Vault load in dev is non-fatal.

## Conventions and constraints

- **No Radzen.Blazor** (or similar heavy component libraries) — deliberately rejected for bundle size (~1.2 MB). Use native Blazor (`<Virtualize>`, plain CSS). The README's "Radzen UI" mention is outdated, as is its game list — trust `src/PoMiniGames.Client/Games/` and `Features/` over the README tables.
- Default branch is `master`. Development is on Windows; repo scripts are PowerShell (`pwsh`).
- Comments in this codebase are dense and contract-oriented (audit/bug-fix annotations); match that style only when a real constraint needs recording.
