# PoMiniGames — PRD Master (Project Source of Truth)

> **Authority:** This document is the canonical product requirements record for
> `PoMiniGames`. It is referenced by [`AGENT.md`](../../AGENT.md) and every
> diagram in this folder. When code, docs, and PRD drift apart, the PRD wins
> only after a recorded update here.
>
> **Stack standard (binding):** **.NET 10** + **C# 14/15**, Blazor WebAssembly
> client, ASP.NET Core Minimal API host, Azure Table Storage. The host organises
> its endpoints as vertical slices (`Features/<Slice>/`); only the cross-cutting
> platform code (storage, AI resilience, telemetry, auth) lives in the layered
> projects (`PoMiniGames.{Application,Domain,Infrastructure}`) plus the trim-clean
> `PoShared` library.

---

## 1. Product overview

### 1.1 Mission
A mobile-first, instant-play mini-games suite running in the browser, served
by a single same-origin ASP.NET Core 10 host. Every game must be playable on a
phone in portrait orientation, optionally offline, and optionally without an
auth round-trip (Guest dev-bypass in non-Production environments).

### 1.2 Personas
| Persona | Goal | Entry point | Success metric |
|---|---|---|---|
| Casual player | Quick, low-friction fun | Tap a tile on `/` | ≥1 game started in < 30 s |
| Competitive player | Win matches, climb leaderboard | `/leaderboards`, `/profile` | ≥3 submissions / week |
| Returning player | Resume stats / multiplayer | `/profile`, Lobby | Match rejoin in < 10 s |

### 1.3 Non-goals
- Native mobile binaries (iOS/Android stores).
- Real-money gambling (PoRacer betting is purely virtual).
- Cross-game unified accounts beyond what Entra ID already provides.
- Persistent worlds across page reloads (PoSurvive simulation is in-memory).

---

## 2. Vertical Slice boundaries

A **Vertical Slice** in this project is a folder under
`src/PoMiniGames/Features/<Slice>/` that owns the HTTP/hub
surface, contracts, persistence repos, and (when needed) AI integrations
for **one feature**. The single composition point is
`src/PoMiniGames/Infrastructure/EndpointRouteExtensions.cs`,
which calls every `MapXxxEndpoints()` extension.

| Slice | Owns | Endpoints (`/api/…`) | SignalR hubs | Repos (Azure Tables) |
|---|---|---|---|---|
| `Auth` | Sign-in / token / cookie lifecycle | `/api/auth/config`, `/api/auth/me`, `/auth/login/*`, `/auth/logout` | — | — |
| `Health` | Probes | `/api/health`, `/api/health/liveness`, `/api/health/ping` | — | — |
| `Diagnostics` | Masked keys + integration status | `/api/diag` | — | — |
| `HighScores` | MarbleRace + PoBrawl scores | `/api/marblerace/scores`, `/api/pobrawl/scores` | — | shared |
| `Leaderboard` | Player stats, unified leaderboard | `/api/{game}/players/{name}/stats`, `/api/leaderboard/*` | — | shared |
| `MatchHistory` | Read-only match log | `/api/matchhistory/*` | — | shared |
| `PoCoupleQuiz` | Real-time couples quiz | `/api/couplequiz/*` | `/couplequiz/hubs/game` | local tables |
| `PoFunQuiz` | Solo quiz + leaderboard | `/api/funquiz/*` | `/funquiz/gamehub` | local tables |
| `PoJoker` | Joke fetch + LLM analysis | `/api/joker/*` | — | shared |
| `PoRacer` | Lobby + race + high scores | `/api/poracer/scores/*` | `/poracer/lobby-hub`, `/poracer/race-hub` | local table |
| `PoSurvive` | Session persistence + inference | `/api/sessions`, `/api/infer` | — | local tables |

### 2.1 Slice discipline (do not violate)
- **New feature code lives in a slice.** A new game = new `Features/<Slice>/`
  folder with at minimum: `*Endpoints.cs`, optional `<Slice>Hub.cs`,
  optional `Storage/Repository.cs`.
- **Shared types that cross the network go to `PoShared/Games/`.** A wire DTO
  shared between client and host has no home inside `Features/<Slice>/`
  because the client cannot reference the host project.
- **Cross-cutting platform code (storage factory, OpenAI resilience, telemetry)
  lives in the layered projects** (`PoMiniGames.Infrastructure`,
  `PoMiniGames.AI`). Never duplicate it inside a slice.

### 2.2 Route registration rule (§1)
Every slice declares routes via **`app.MapGroup("/api/<slice>")` +
`.WithTags("<Slice>")`** at the group boundary. Per-route handlers attach to
the group; auth and rate-limit policies are applied once at the group, not
per route.

```csharp
// canonical slice signature
var group = app.MapGroup("/api/<slice>").WithTags("<Slice>");
group.MapPost("/...", ...)
      .RequireRateLimiting("<policy>")
      .WithName("<Slice>_Action");
```

The legacy unprefixed `/auth/login/*`, `/auth/logout`, `/auth/me` paths stay
**outside** the group because external monitors reference them by exact URL.

---

## 3. Trimmer-compatibility criteria

Every type that crosses into the Blazor WASM client's closure (transitively
referenced from `PoMiniGames.Client`) must satisfy:

| Rule | Why | How |
|---|---|---|
| **No reflection-only metadata** | `<EnableTrimAnalyzer>` + `<IsTrimmable>true</IsTrimmable>` deletes unreferenced private members | Decorate JSON DTOs with `[JsonSerializable]` on a `partial` source-gen `JsonSerializerContext` |
| **Public surface must be reachable from a public call site** | The trimmer cannot see runtime reflection into `internal` types | Keep DTOs `public`, expose them through a `public` typed HttpClient call site |
| **No `dynamic`, no `ExpandoObject`** | These emit IL2012 / IL2026 warnings → build break under `TreatWarningsAsErrors` | Use `record` types and `System.Text.Json` |
| **Use `LibraryImport` not `DllImport`** | Source-gen friendly | — |
| **`AOT`-friendly logging** | `LoggerMessage.Define` source generators | See §5 |

CI enforces via:
```bash
dotnet publish src/PoMiniGames.Client/PoMiniGamesClient.csproj \
    -p:PublishTrimmed=true -p:TrimMode=partial
```
IL2xxx warnings fail the build. The current trim baseline for `_framework/`
is ≈ 20 MB; the CI budget (`FRAMEWORK_BUDGET_MB`) is **25 MB** — over-budget
PRs are rejected by `scripts/coverage-matrix.ps1`.

---

## 4. Zero-allocation source-generated logging

All slice-level log messages must use **`LoggerMessage` source generators**;
**never** `ILogger.LogInformation("…{Foo}…", foo)` with composite formats.

```csharp
// ✅ canonical
private static readonly Action<ILogger, string, Exception?> _joined =
    LoggerMessage.Define<string>(
        LogLevel.Information,
        new EventId(10, "Joined"),
        "PoRacer lobby: conn joined as {Name}");
_logger.Joined(displayName);             // extension defined in <Slice>.cs

// ❌ forbidden — allocates a string + params array per call
_logger.LogInformation("PoRacer lobby: conn joined as {Name}", displayName);
```

Required by `Directory.Build.props` (`<TreatWarningsAsErrors>true`) via the
`LoggerMessageAnalyzer`. Slices declare their events in a `<Slice>Log.cs`
partial-class extension file referenced by `GlobalUsings.cs`.

---

## 5. API endpoint mapping (canonical surface)

| Method | Path | Slice | Auth | Rate-limit | Purpose |
|---|---|---|---|---|---|
| GET | `/api/auth/config` | Auth | Anon | none | SPA bootstrap (MSAL config + flags) |
| GET | `/api/auth/handshake` | Auth | Anon | none | Combined config + me (single RTT) |
| POST | `/api/auth/dev-login` | Auth | Anon (Dev/Test) | none | Mint DevCookie identity |
| POST | `/api/auth/dev-bypass` | Auth | Anon (Dev/Test) | none | Dev guest login by name |
| POST | `/api/auth/dev-logout` | Auth | Anon (Dev/Test) | none | Clear DevCookie |
| GET | `/api/auth/me` | Auth | Auth | none | Current user profile |
| GET | `/auth/login/microsoft` | Auth | Anon | none | OIDC challenge (legacy URL) |
| GET | `/auth/login/fake` | Auth | Anon (Dev/Test, loopback) | none | Guest via legacy URL |
| GET | `/auth/logout` | Auth | Anon | none | Clear DevCookie |
| GET | `/auth/me` | Auth | Anon | none | Cookie state + oauthConfigured |
| GET | `/api/health` | Health | Anon | none | Full health report |
| GET | `/api/health/ping` | Health | Anon | none | `pong` — cheapest liveness |
| GET | `/api/diag` | Diagnostics | Anon (Dev/ff) | none | Masked keys + status |
| GET | `/api/{game}/players/{playerName}/stats` | Leaderboard | Auth | none | Read stats |
| PUT | `/api/{game}/players/{playerName}/stats` | Leaderboard | Auth | none | Upsert stats |
| GET | `/api/{game}/statistics/leaderboard` | Leaderboard | Auth | none | Per-game leaderboard |
| GET | `/api/leaderboard/unified` | Leaderboard | Auth | none | Cross-game ranking |
| GET | `/api/marblerace/scores` | HighScores | Auth | none | MarbleRace top N |
| GET | `/api/pobrawl/scores` | HighScores | Auth | none | PoBrawl top N |
| GET | `/api/matchhistory` | MatchHistory | Auth | none | Recent matches |
| POST | `/api/couplequiz/...` | PoCoupleQuiz | Auth | ai-generation | Couple flow |
| GET | `/api/funquiz/quiz/questions` | PoFunQuiz | Auth | ai-generation | Cache-memoized quiz |
| GET | `/api/funquiz/leaderboard` | PoFunQuiz | Auth | none | Top players |
| POST | `/api/funquiz/leaderboard` | PoFunQuiz | Auth | submit | Submit score |
| GET | `/api/joker/random` | PoJoker | Auth | none | JokeAPI.dev (resilient) |
| POST | `/api/joker/analyze` | PoJoker | Auth | joker-analysis | LLM roast |
| GET | `/api/poracer/scores` | PoRacer | Auth | none | Top races |
| POST | `/api/poracer/scores` | PoRacer | Auth | submit | Upsert score (auth-coerced name) |
| POST | `/api/sessions` | PoSurvive | Auth | submit | Persist session summary |
| POST | `/api/infer` | PoSurvive | Auth | infer | Run inference for an agent |

SignalR hubs (all `[Authorize]`):

| Hub | Path | Slice |
|---|---|---|
| `CoupleQuizHub` | `/couplequiz/hubs/game` | PoCoupleQuiz |
| `FunQuizHub` | `/funquiz/gamehub` | PoFunQuiz |
| `PoRacerLobbyHub` | `/poracer/lobby-hub` | PoRacer |
| `PoRacerRaceHub` | `/poracer/race-hub` | PoRacer |

---

## 6. Cross-cutting standards (binding)

### 6.1 Auth gate is unconditional
`App.razor` wraps **the entire `<Router>`** in `<AuthGate>`. No route
renders until `AuthState.IsAuthenticated` is true. `/auth/me` is the single
RTT that hydrates `AuthState` so the Login Screen does not flash.

### 6.2 Standard HttpClient resilience
Every typed `HttpClient` registered via `services.AddHttpClient(...)`
**MUST** chain `.AddStandardResilienceHandler()` (or
`AddResiliencePipeline(...)` for non-default tuning). Bare `new HttpClient()`
is CI-banned.

### 6.3 Environment → auth-surface map
| Env | Sign-in | Guest bypass | FakeAuth | AutoGuestLogin |
|---|---|---|---|---|
| `Development` | MS OAuth **+** Guest | opt-in `?autoGuest=1` | gated | opt-in |
| `Test` | Guest dev-bypass only | auto via `?autoGuest=1` / `X-Fake-User` | gated | gated |
| `Production` | MS OAuth **only** | forbidden | throws at startup | forbidden |

`Program.cs` throws if `FakeAuth` is registered in Production, if
`Auth:AutoGuestLogin` is true in Production, or if required Microsoft Auth
config (`MicrosoftAuth:ClientId` / `ApiClientId`) is missing.

### 6.4 Logging standard
- Serilog → console + file (Dev) + Application Insights (non-Dev when
  connection string present). Enriched with `UserId`, `SessionId`,
  `CorrelationId`.
- OpenTelemetry via `UseAzureMonitor`, `cloud_RoleName` bound to the
  compile-time constant `"PoMiniGames"` (`TelemetryExtensions.CloudRoleName`)
  — never reflect against the executing assembly.
- Source-generated events per §5; no composite-format log strings.

### 6.5 Persistence boundary (authoritative — keep drift out)
- Per-game tables/blobs → live in that game's slice:
  `Features/<Slice>/Storage/`
- Shared platform persistence → `src/PoMiniGames.Infrastructure`
  (`StorageService` = shared `TableServiceClient` factory + Elo calculator).
- Host composition root (registration + lifecycle only) →
  `src/PoMiniGames/Infrastructure/`.

---

## 7. Testing standards

| Project | Type | Stack | Scope |
|---|---|---|---|
| `PoMiniGames.Unit` | Pure logic | xUnit | Mirrored under `Features/<Slice>/` |
| `PoMiniGames.Integration` | Host + DB | `WebApplicationFactory` + **Testcontainers.Azurite** | API-level integration |
| `E2EAPI` | Pure HTTP-contract | `WebApplicationFactory` | No browser |
| `E2EUI` | Real browser | Microsoft.Playwright + Kestrel | Live Kestrel port |

`tests/Shared/` (`PoMiniGames.TestUtilities.csproj`) holds assertion helpers
and budget guards shared by all four test projects.

In CI: only Unit runs (cheapest gate). Integration + E2E run locally via
`scripts/test-all.ps1`.

---

## 8. Diagrams in this folder

Every diagram below exists in two forms: a **baseline** (full detail) and a
**`_simplified`** variant (executive-review size). Both have a generated
`.svg` sibling for embedding into design reviews and READMEs.

| File | Type | Purpose |
|---|---|---|
| [PRD_Master.md](PRD_Master.md) | markdown | This file — Project Source of Truth |
| [User_Journey.mmd](User_Journey.mmd) | journey | Mobile-portrait cognitive tasks × system impact |
| [UI_Screen_Matrix.mmd](UI_Screen_Matrix.mmd) | stateDiagram-v2 | Routes + auth-gate states |
| [Flow_Identity_BFF.mmd](Flow_Identity_BFF.mmd) | graph TD | Entra ID OIDC + cookie + /auth/me |
| [Flow_Validation_Failures.mmd](Flow_Validation_Failures.mmd) | graph TD | UI validation ↔ backend exceptions per slice |
| [Flow_RealTime_Lobby.mmd](Flow_RealTime_Lobby.mmd) | graph LR | SignalR lifecycle, server-validated state |
| [Architecture_VSA_Blueprint.mmd](Architecture_VSA_Blueprint.mmd) | graph TD | Slice topology, client/server/shared bounds |
| [Interaction_Trace.mmd](Interaction_Trace.mmd) | sequenceDiagram | End-to-end BFF trace |
| [DatabaseSchema.mmd](DatabaseSchema.mmd) | erDiagram | Tables, PK/RK, index relations |

---

## 9. Change log

| Date | Change | Reason |
|---|---|---|
| 2026-07-09 | Net regeneration of `docs/`; 8 baseline + 8 simplified `.mmd` + PRD | Archive pre-2026-07-09 versions in `_archive/` |
| 2026-07-09 | PRD authored from `AGENT.md` + slice source trees | Single source of truth |
