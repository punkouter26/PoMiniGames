# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
# Build (TreatWarningsAsErrors is on; NuGet CVE audit fails the build)
dotnet build PoMiniGames.slnx

# Lint / format. CI runs this but the step is explicitly non-blocking
# (`continue-on-error: true`) — a formatting drift will not fail master, so keep
# the tree clean locally rather than relying on the gate.
dotnet format PoMiniGames.slnx --verify-no-changes --verbosity minimal
dotnet format PoMiniGames.slnx
# Line endings are pinned to LF by .gitattributes (`* text=auto eol=lf`). That file is
# load-bearing: .editorconfig mandates LF while Windows `core.autocrlf=true` rewrites to
# CRLF, and without the override the format gate failed on ~150 files on every fresh
# clone. Do not remove it, and do not "fix" a CRLF diff by hand.

# Full CI-equivalent test suite (Unit → Integration → E2E-API → E2E-UI).
# Handles preflight itself: frees port 5080, starts Azurite, installs Playwright.
pwsh scripts/test-all.ps1

# Single tier
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj
dotnet test tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj

# Single test
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~EloCalculatorTests"

# Local storage emulator (required — API boot is slow/errors on ports 10000-10002 without it)
docker compose up -d azurite

# Run the app: one host serves API + Blazor WASM client at http://localhost:5080
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj
# `dotnet run` recompiles and can thrash while .razor files are being edited; for a
# stable instance, build once and run the compiled DLL from src/PoMiniGames.API/bin directly.

# Deploy (Azure Bicep + azd; CI is .github/workflows/deploy.yml)
azd up
```

Requires .NET SDK 10.0.203 (global.json) and Docker (Azurite + Testcontainers).

### What CI actually gates (`.github/workflows/deploy.yml`)

Only the **Unit** tier runs in CI — Integration/E2E need Azurite and Playwright and stay local via `test-all.ps1`. But the build job carries two further hard gates that are easy to trip without touching a test:

- **Trim audit**: the WASM client is published with `PublishTrimmed=true` + `EnableTrimAnalyzer`. Combined with `TreatWarningsAsErrors`, a single IL2xxx warning from new reflection-heavy code fails master. The host's own publish does not exercise this, so the analyzer only ever sees the client here. `src/PoMiniGames.Client/TrimmerRoots.xml` is the escape hatch.
- **WASM bundle-size budget**: the trimmed `_framework` output must stay ≤ 25 MB (baseline ≈ 20 MB, driven by the PoSurvive simulation engine shipping client-side by design).

The format check is non-blocking; a missing `v*` tag at HEAD is a warning, not a failure (MinVer just stamps a pre-release). Deploy targets the `PoMiniGames` resource group and **discovers** the App Service name from it rather than hardcoding it — a resource rename can no longer silently 404 the deploy. It runs on F1, which cannot enable AlwaysOn, hence the prewarm loop before the smoke tests; `WEBSITE_RUN_FROM_PACKAGE=1` means the zip is mounted atomically.

## Test structure rules

- **100/50/25/25 rule**: *every* tier has its own ceiling, each enforced by its own guard test — Unit 100 (`TestCountCeilingTests`), Integration 50 (`IntegrationTestCountCeilingTests`), E2E-API 25, E2E-UI 25. They count `[Fact]`/`[Theory]` **methods**, not discovered cases. When one trips, consolidate or relocate — never raise the cap. Unit is at/near its ceiling, so route new tests to Integration by default, but note Integration has only 50 slots and is not a dumping ground. Current headroom (2026-08-31 audit): Unit **0 slots**, Integration 2, E2E-API 4, E2E-UI 16. A new Unit test must displace an existing one (merge two facts into one theory) — adding a 101st fails CI via the guard.
- The two enforcement paths deliberately disagree: the guard tests **fail** the tier, while `test-all.ps1` reports overage as a loud non-fatal **WARN** so coverage is never deleted just to satisfy a counter.
- Tiers: `PoMiniGames.Unit` (hermetic, no I/O) → `PoMiniGames.Integration` (Testcontainers Azurite) → `PoMiniGames.E2EAPI` (WebApplicationFactory HTTP contract) → `PoMiniGames.E2EUI` (Playwright; host runs under the "Test" environment) → `PoMiniGames.Component` (bUnit in-process renders, ceiling 25, guard `ComponentTestCountCeilingTests`). A fifth, non-xUnit tier runs first: **SimJs** (`npm test`, Vitest over `tests/PoEcosystem.Sim`, 80 % line-coverage threshold in `vitest.config.js`, not counted by the 100/50/25/25 rule). Pre-commit hooks (Husky.Net, `.husky/task-runner.json`) run staged-file `dotnet format`, ESLint and Vitest; `HUSKY=0` skips the install on restore.
- **Any test that POSTs/PUTs/DELETEs `/api/*` must call `client.ArmAntiforgeryAsync()`** (`tests/Shared/AntiforgeryTestExtensions.cs`) or it gets a 403, not the status it asserts. Re-arm after a sign-in — the token is bound to identity claims. Antiforgery is deliberately NOT disabled for the Test environment.
- **`tests/Shared/TestBudgetGuard.cs` is the single source of truth for AI mocking.** Every fixture (Unit harness, Integration factory, E2E-API host, E2E-UI Kestrel host) applies `TestBudgetGuard.Overrides` before serving traffic, so the suite can never spend live tokens even when real keys sit in `appsettings.Development.json` or user-secrets. **Adding a new AI boundary means exactly one edit there** — the earlier inline-duplicated dictionaries drifted, which is how `IFaceAnalysisService` ended up unmocked.
- Without Docker, storage-backed tests fail with `connection refused (127.0.0.1:10002)`. That is the environment, not a regression — `docker compose up -d azurite` first. Integration/E2E tiers are slow (E2EAPI is ~13 min); prefer `--filter` while iterating.

## Architecture

Instant-play mini-games platform: .NET 10 Minimal API host that also serves the Blazor WebAssembly client (single origin, port 5080), with SignalR for real-time multiplayer and Azure Table Storage for persistence.

### Projects (`src/`)

- **PoMiniGames.API** — API host (assembly `PoMiniGames.API`, but `RootNamespace` is pinned to `PoMiniGames` — every file declares `namespace PoMiniGames.*` explicitly and new files must match). Vertical slice architecture: each feature lives in `Features/<Slice>` (Auth, Diagnostics, Health, HighScores, Leaderboard, MatchHistory, PoCoupleQuiz, PoFunQuiz, PoJoker, PoMarbleRace, PoRacer, PoSports, PoSurvive) containing its endpoints, hubs, and services. **Every HTTP route and SignalR hub is registered in exactly one place**: `Infrastructure/EndpointRouteExtensions.MapPoMiniGamesEndpoints()`. Auth is applied at the route-group boundary — leaderboard reads are anonymous, all game-data writes require auth; rate limits are declared per slice (policy names: `highscores`, `infer`, `ai-generation`, `face-analysis`, in `Infrastructure/RateLimitingExtensions`).
- Slice names do not map 1:1 to client games. **PoBrawl has no API slice** — its endpoints live in `Features/HighScores/PoBrawlHighScoresEndpoints.cs` alongside PoSports'. `PoMarbleRace` was moved out of `Features.HighScores` so its namespace matches its folder; don't reintroduce the split.
- **PoMiniGames.Client** — Blazor WASM client. Note the assembly/namespace is `PoMiniGamesClient` (csproj `PoMiniGamesClient.csproj`). Each game is a self-contained folder under `Games/` (TicTacToe, ConnectFive, PoBrawl, PoCoupleQuiz, PoFunQuiz, PoJoker, PoMarbleRace, PoRacer, PoSports, PoSurvive) with its page, board/AI logic in C#. JS-heavy games (three.js/cannon-es) keep their engine code under `wwwroot/js/<game>/` — these files are served live from source in dev, no rebuild needed.
- **PoMiniGames.Infrastructure** — Table Storage access. `StorageService` + `HighScoreDescriptor<T>` implement a strategy pattern: one generic save/rank/get flow, one descriptor per game leaderboard. To add a leaderboard, write a descriptor; declare `RowKeyFields` explicitly (immutable identity fields only — usually the player, not the score) and use `ShouldOverwrite` to keep a better score from being clobbered.
- Two boards deliberately sit **outside** the descriptor pattern because they are accumulators rather than best-result ratchets, and a descriptor cannot express "move this value both ways": the PoBrawl presidents ladder, and the PoBrawl demo-mode fighter Elo (`PoBrawlFighterRatings` table). Both go straight through `TableConcurrency.UpdateWithRetryAsync`. The Elo board applies its rating change as an **increment**, never as an absolute computed from the read — increments commute, so two demo matches finishing at once compose instead of one clobbering the other.
- **PoMiniGames.Shared** — models shared between client and server (game state DTOs, identity helpers). **PoMiniGames.Application** / **PoMiniGames.Domain** — application services and domain primitives (EloCalculator, GameKey, PlayerStats).
- **Two Elo systems, deliberately not unified.** `EloCalculator` rates a *player* against a fixed virtual AI rating per difficulty tier; because it depends only on accumulated win/loss/draw counts it is recomputable from scratch and safe to backfill. `PairwiseEloCalculator` rates *fighters* head-to-head for the PoBrawl demo board; each match is priced against the opponent's rating at that moment, so it is path-dependent and the stored value is the only record of the history. That difference is the reason there are two classes — don't merge them.
- Identity strings are hardcoded constants, never reflected from the assembly name: `TelemetryExtensions.CloudRoleName`, `PrefixKeyVaultSecretManager`'s secret prefix, and `DataProtectionExtensions.SetApplicationName("PoMiniGames")`. That last one keys the cookie key-ring purpose — deriving it from the assembly name would invalidate every live auth cookie on the next deploy. Keep them constant.
- Note `PoShared` still appears in the codebase meaning the **Azure resource group** and the Key Vault DNS name `kv-poshared`. It is not the project name; do not rename those.

### Cross-cutting facts

- Auth: Microsoft Entra (MSAL) with a BFF cookie pattern (`BffAuthenticationStateProvider`, encrypted cookies via Data Protection), plus a dev-only DevAuth bypass and guest login. Client gates most pages on auth.
- CSRF: `Infrastructure/AntiforgeryExtensions` validates a synchroniser token on every POST/PUT/PATCH/DELETE under `/api/*`. Scope is exact and load-bearing — SignalR hubs live at their own roots (`/poracer/lobby-hub`, …) so their POST `/negotiate` stays ungated, because the SignalR client cannot be taught to attach the header. `app.UseAntiforgery()` alone would NOT cover this app: since .NET 8 it auto-validates only form-bound endpoints, and every endpoint here takes JSON.
- The client `HttpClient` is an explicit four-deep handler pipeline built in `Client/Program.cs`, and **the order is a contract**: `TransientRetryHandler → AntiforgeryHandler → IncludeCredentialsHandler → HttpClientHandler`. Retry is outermost so every replayed clone re-enters `IncludeCredentialsHandler` and gets its credentials mode re-applied before hitting the browser transport; `AntiforgeryHandler` sits directly above `IncludeCredentialsHandler` because its token fetch must carry the cookie the server pairs the header against. A `window.fetch` patch (`js/crossOriginFetchPatch.js`) is a belt-and-braces duplicate of the credentials behaviour, scoped to the API origin only — a blanket patch previously broke MSAL sign-in.
- **AI (Azure AI Foundry)** — `src/PoMiniGames.API/AI/`, ~20 files, the most expensive thing to get wrong. One `PoMiniGames:AI` binding replaced the old per-game `*:AzureOpenAI:*` sections, resolved from Key Vault (`PoMiniGames--AI--FoundryEndpoint`, `--DefaultDeployment`, `--Deployments`). Chat clients compose as decorators: `BudgetedChatClient` → `ResilientChatClient` → `InstrumentedChatClient`. Spend is bounded by a per-identity daily ceiling (`TokenBudget:DailyTokensPerIdentity`, 250k) because the `infer` rate limit shapes burst but bounds no spend — one tab left open is ~36k calls/hour. `ValidateDeploymentsOnStartup` lists the account's real deployments and fails Production boot on a name that isn't there; that check exists because `gpt-4o-mini`/`gpt-4o` were configured for months and never existed on the shared account (real names: `gpt-5.4-nano`, `gpt-5-nano`, `gpt-5.4-mini`, `Phi-4-mini-instruct`, `Phi-4`). `AIFoundryOptions.Deployments` must stay a **plain settable `Dictionary`** — the configuration binder does not populate an `IDictionary` property through the indexer, and the silent failure was every game running on the default deployment while `/api/infer/status` reported a different answer.
- **PoSurvive inference has two backends and defaults to neither.** Client-side `Inference:UseMock` defaults to **true** to avoid a multi-hundred-MB WebLLM download; set it false to activate `InferenceRouter` (in-browser WebLLM ↔ server relay). Server-side, `Inference:UseCloudFallback` gates whether `POST /api/infer` is mapped at all, and `Inference:RemoteModelOptions` is an allowlist of model ids a client may name, mapped to real deployments. `/api/infer/status` reports the truth either way. If the PoSurvive AI appears to do nothing, check these before assuming a bug.
- **PWA / offline resilience.** `service-worker.js` + `service-worker.published.js`, `manifest.webmanifest`, with `OnlineStatusService` (offline banner) and `AppUpdateService` (new-version prompt) initialized once from `MainLayout`. Score submission is durable: `PendingScoreStore` (localStorage queue) → `ScoreSyncService` (flusher) → `GameResultService`. A failed leaderboard submit is parked, not lost. This is also why anonymous leaderboard *reads* never became anonymous writes — guests park scores locally and flush them on sign-in.
- `GET /health` serves two audiences by `Accept`: `text/html` returns the Blazor shell so `Pages/HealthPage.razor` renders the human status page; anything else (monitors, `HttpClient`, the deploy smoke tests) keeps the legacy JSON report. Content negotiation exists because server routes match ahead of `MapFallbackToFile`, so a Blazor `@page "/health"` would otherwise be permanently shadowed. `/api/health/*` is the canonical JSON surface; `/api/diag` is the developer configuration dump (JSON-only — the Blazor `/diag` page was deliberately removed 2026-08-07 because it shipped 505 lines of developer chrome in every player's WASM bundle and only rendered JSON the API endpoints already expose).
- Storage tables are created automatically on startup; dev uses `UseDevelopmentStorage=true` against Azurite, production uses Managed Identity. Application Insights is intentionally NOT configured in local dev (`PoMiniGames:ApplicationInsights:ConnectionString` empty by design — same standing exception as `dotnet user-secrets`): the connection string is treated as a Key Vault secret, never committed, and `/api/diag` reports `applicationInsightsConfigured: not-configured`. Local telemetry goes to console / Serilog only; trace a session locally with logs + the existing health snapshot.
- SignalR hubs are per-game (`/couplequiz/hubs/game`, `/funquiz/gamehub`, `/poracer/lobby-hub`, …) and all require auth; JSON protocol uses camelCase string enums.
- Central package management via `Directory.Packages.props`; versioning via MinVer from git tags.
- `dotnet user-secrets` (id `pomini-games-secret-id`) holds dev auth ClientIds; Key Vault load in dev is non-fatal. (The external NET_RULES doc forbids user-secrets in favour of Key Vault everywhere; this repo keeps them for local dev. Treat that as a standing exception, not an unfixed violation.)

## Conventions and constraints

- **Do not run test tiers after making changes** (`dotnet test`, `scripts/test-all.ps1`, single-filter runs included) unless the user explicitly asks for a test run. The tiers are slow (E2EAPI ≈ 13 min) and the user prefers to run them themselves. `dotnet build` is still fine — compile errors are not tests.

- **No Radzen.Blazor** (or similar heavy component libraries) — deliberately rejected for bundle size (~1.2 MB). Use native Blazor (`<Virtualize>`, plain CSS). Note that the external NET_RULES doc mandates Radzen; this repo's rejection overrides it — do not reintroduce the dependency to satisfy that rule.
- **Docs were rewritten in the 2026-08-18 cleanup.** `README.md` and `scripts/README.md` are now accurate summaries; `scripts/` holds working scripts only (the ~28 one-off debug files were deleted). The tree is still the truth when docs drift: trust `src/PoMiniGames.Client/Games/` and `src/PoMiniGames.API/Features/` over any doc table. `docs/*.html` report output is gitignored — build it via `node docs/build.mjs`.
- Source comments reference an `AGENT.MD` that is not in this repo. It's a dangling pointer, not a file you failed to find.
- Theming is entirely token-driven: `wwwroot/css/app.css` `:root` defines the palette and a `prefers-color-scheme: light` block re-points only the surface/text/elevation tokens. Components must read colour through those variables, never raw hex, or they will be unthemed in light mode. Accent hues and per-game/canvas tokens are intentionally scheme-invariant.
- `style="..."` in `.razor` files is acceptable **only** to pass a runtime value into a CSS custom property (`style="--hp: @Percent%"`); the static rule still belongs in the scoped `.razor.css`.
- Default branch is `master`. Development is on Windows; repo scripts are PowerShell (`pwsh`).
- Comments in this codebase are dense and contract-oriented (audit/bug-fix annotations); match that style only when a real constraint needs recording.
