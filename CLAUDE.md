# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The rules for working in this repository live in `AGENTS.md` and apply to every session:

@AGENTS.md

For the project tour and the list of games, see `README.md`. `CAPABILITY-MAP.md` says which module
owns what; `DOCS/20261003/architecture_overview.md` is the long-form architecture write-up.

## Commands

```powershell
docker compose up -d azurite                                   # storage emulator (ports 10000-10002)
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj # API + Blazor WASM client on http://localhost:5080
dotnet build PoMiniGames.slnx                                  # warnings are errors (Directory.Build.props)
dotnet format PoMiniGames.slnx --verify-no-changes             # CI style gate
pwsh scripts/css-lint.ps1                                      # CI CSS gate; run after any scripted CSS edit
pwsh scripts/test-ceilings.ps1                                 # test-count ceiling guards only

dotnet test tests/PoMiniGames.Unit --filter "FullyQualifiedName~PoMule"   # one test / one area
dotnet test tests/PoMiniGames.E2EUI -p:SkipPlaywrightInstall=true --filter "..."
node --test tests/pomule-world.test.mjs                        # JS engine tests (not run by CI)
```

- The API host serves the client on one origin, so there is no separate client dev server. Never
  build `PoMiniGames.Client` alone while the host is running, because the fingerprinted wasm assets
  stop matching. Under a running host, build with
  `--artifacts-path artifacts/<name>` (it must stay inside the repo).
- `scripts/test-all.ps1` runs all four tiers. The AGENTS.md rules say not to run it for routine
  changes.
- CI (`.github/workflows/deploy.yml`) runs on every push to master and deploys to Azure App
  Service. A push is a production deploy. Infra is Bicep under `infra/`, and `azure.yaml` drives
  `azd up`.

## Tests

- There are four tiers. **Unit** is hermetic. **Integration** uses a Testcontainers Azurite.
  **E2EAPI** runs HTTP contract tests against the compose Azurite. **E2EUI** runs C# Playwright
  against a Kestrel host in the `Test` environment.
- Each tier has a ceiling on its test-method count, enforced by `*CeilingTests.cs` via
  `tests/Shared/TierCeilingGuard.cs`: Unit 140, Integration 50, E2EAPI 25, E2EUI 25. When a tier
  is full, merge tests or move one to another tier rather than raising the cap.
- Every fixture applies `tests/Shared/TestBudgetGuard.cs`, which forces mock or stub AI and
  disables Key Vault. Any new paid-AI boundary needs a key there so tests never spend money.

## Architecture

- **Projects:** `src/` holds five projects.
  - `PoMiniGames.API`: the ASP.NET Core host. It contains vertical slices in `Features/<Game>`
    and also serves the client.
  - `PoMiniGames.Client`: Blazor WASM, assembly name `PoMiniGamesClient`.
  - `PoMiniGames.Domain`: `GameKey`, `ScoreRules`, Elo and the high-score models.
  - `PoMiniGames.Infrastructure`: the `StorageService` partials and `HighScoreDescriptor<T>`.
  - `PoMiniGames.Shared`: the DTOs and pure game logic shared by client and server.
  - NuGet versions live only in `Directory.Packages.props` (Central Package Management).
- **Adding a game** touches several files:
  1. Add a `GameKey` value to the WellKnown list in Domain `Primitives/GameKey.cs`. It is a
     string value-object, not an enum.
  2. Add a `ScoreRules` bounds entry and a high-score model.
  3. In `StorageService`, add the table and partition constants and a `HighScoreDescriptor`.
  4. Create `Features/<Game>/*Endpoints.cs` and map it in
     `API/Infrastructure/EndpointRouteExtensions.cs` on the `gameApi` group, which requires
     authorization. Map hubs there too.
  5. Add a case to `Features/Leaderboard/UnifiedLeaderboardEndpoints.cs`.
  6. Register services and options in `Infrastructure/GameServicesExtensions.cs`.
  7. On the client, add `Models/GameKeys`, `Models/GameCatalog.cs`, and a page at
     `Games/<Game>/<Game>Page.razor` with routes `/game` and `/game/{Mode}`.
- **JS engines:** heavy games are JS engines in `Client/wwwroot/js/<game>/`.
  `wwwroot/js/engineLoader.js` (`loadEngine(name)`) loads them on demand, and the page's
  `.razor.cs` drives them over IJSRuntime. The PWA service worker precaches them automatically
  through the asset manifest.
- **Results flow:**
  - Every game reports to `Client/Services/Play/GameResultService`.
  - It records local stats (`GameStatsService`) and submits the score through `ApiService`.
  - A score that fails to submit is parked in `PendingScoreStore`/`ScoreSyncService` and
    retried.
  - On the server, `Features/Integrity` (`PlaySessionService`, `ScoreIntegrityGuard`) validates
    scores.
- **JSON:** new client DTOs need a `[JsonSerializable]` entry in
  `Client/Services/Http/ApiJsonContext.cs` (or in the game's own JSON context), because the WASM
  build is trimmed.
- **Storage:** Azure Tables and Blob, using Azurite in dev and test and managed identity in
  prod. `StorageInitializer` creates tables at startup.
- **Auth** (`Infrastructure/AuthExtensions.cs`) is a composite scheme:
  - Entra JWT bearer, signed in with MSAL in the browser.
  - A dev guest cookie, available only in Development and Test.
  - The `X-Fake-User` header, enabled by `Auth:EnableFakeAuth` in Development.
    `StartupSecretValidator` refuses to start if fake auth is on in Production.
  - Game writes need auth plus antiforgery. Leaderboard reads are anonymous.
- **SignalR:** multiplayer games use authorized hubs mapped in `EndpointRouteExtensions.cs`, and
  their state is held in memory.
- **AI:** paid AI is deliberately minimal to save money.
  - FunQuiz and CoupleQuiz use `API/AI`. `AddGameChatClient` stacks resilience, then a
    per-identity token budget, then instrumentation, then the Foundry client. Results are cached
    in `TableDistributedCache`, the HybridCache L2.
  - PoJevArena uses OpenRouter via `Features/PoJevArena/Jev`.
  - Ecosystem, Brawl and Cabinet are scripted and AI-free. Do not add paid AI back without being
    asked.
- **Constraints:**
  - PoEcosystem is observation-only: never add controls that change its world.
  - In Chromium, `wwwroot/js/app.js` turns links inside `.home-card` (the hub's game cards) into a
    full document load for the card-to-title view transition, which reboots WASM. Every other
    in-app `<a>` goes through the Blazor router.
