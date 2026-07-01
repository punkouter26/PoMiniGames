# PoMiniGames — Product Requirements Document (Source of Truth)

> Companion to [`AGENT.MD`](../AGENT.MD). AGENT.MD describes the runtime topology;
> this PRD is the *contract* — slice boundaries, endpoint maps, model contract rules,
> and logging standards every contributor must follow. When in doubt, AGENT.MD wins on
> topology; this file wins on contract.

---

## 1. Mission

A **mobile-first**, same-origin Blazor WebAssembly suite of 11 instant-play mini-games,
hosted by an ASP.NET Core (.NET 10) Minimal API. Every game must remain playable when
the API is unreachable (offline resilience is a hard product requirement, not a stretch
goal). Authentication is gated but never blocking — guests and signed-in players get the
same game surface, with leaderboards / multiplayer gated behind auth.

---

## 2. Vertical Slice Boundaries

### 2.1 The rule (authoritative)

Every game owns **everything** it needs inside `src/PoMiniGames/PoMiniGames/Features/<Slice>/`:

```
Features/
├── <Slice>/
│   ├── <Slice>Endpoints.cs       # MapPost / MapGet / MapHub extensions
│   ├── <Slice>Dto.cs             # Request + response DTOs (trim-safe POCOs)
│   ├── <Slice>Handler.cs         # Business logic (no I/O directly)
│   ├── <Slice>Validator.cs       # FluentValidation OR DataAnnotations
│   ├── Storage/                  # ONLY if the slice owns its own tables
│   │   └── <Slice>Repository.cs
│   └── Hub/                      # ONLY if the slice exposes a SignalR hub
│       └── <Slice>Hub.cs
```

A slice MUST NOT reach into another slice's folder. Cross-slice sharing goes through
`PoShared` or `PoMiniGames.Infrastructure` and is forbidden for game-specific logic.

### 2.2 Slice ↔ Game map (current)

| Slice folder | Game module (client) | Owns tables? | Hub? |
|---|---|---|---|
| `Auth/` | All (gate) | No | No |
| `Leaderboard/` | All (cross-cutting) | Yes (`HighScores`, `PlayerStats`) | No |
| `Lobby/` | TicTacToe, ConnectFive, Fight, PoSurvive, SnakeGame | Yes (`LobbyState`, `LobbyMembers`) | Yes (`/hubs/lobby`) |
| `PoCoupleQuiz/` | PoCoupleQuiz | No (uses Leaderboard) | No |
| `PoFace/` | PoFace | No | No |
| `PoFunQuiz/` | PoFunQuiz | Yes (`FunQuizQuestions`) | No |
| `PoJoker/` | PoJoker | No (caches via HybridCache) | No |
| `PoSurvive/` | PoSurvive | Yes (`SurviveRun`, `SurviveLoot`) | Yes (`/hubs/survive`) |

Client-only games (no slice): `BabyTouch`, `ConnectFive` (client-only when vs AI),
`DropSquare`, `Fight` (client-only when vs CPU), `HorseRace`, `PoMarbleRace`,
`PoRacer`, `PoRunner`, `SnakeGame` (client-only when vs AI), `TicTacToe`
(client-only when vs AI), `VoxelShooter`. These are pure local-first and MUST NOT
be mirrored under `Features/`.

### 2.3 Persistence boundary (drift-prevention)

| Concern | Home |
|---|---|
| Per-game tables/blobs | `Features/<Slice>/Storage/` |
| Cross-slice tables (Leaderboard, Lobby) | Same rule — colocated with owning slice |
| Shared `TableServiceClient` factory + Elo + health checks | `src/PoMiniGames.Infrastructure` |
| Composition root (DI registration, DataProtection, lifecycle) | `src/PoMiniGames/PoMiniGames/Infrastructure/` |
| Cross-slice DTOs only | `src/PoShared` |

A new game that needs its own table MUST add a `Storage/<Slice>Repository.cs` next
to its handler — never push it into `PoMiniGames.Infrastructure`.

---

## 3. API Endpoint Mappings

All endpoints are registered in **one** place:
`src/PoMiniGames/PoMiniGames/Infrastructure/EndpointRouteExtensions.MapPoMiniGamesEndpoints`.
New endpoints MUST be added there and only there.

### 3.1 Route prefix conventions

| Prefix | Purpose | Auth |
|---|---|---|
| `/api/health/*` | Diagnostics (`/health` alias kept for App Service default probes; not in OpenAPI) | Anonymous |
| `/api/diag` | Feature-flag-gated integration status + masked keys | Anonymous (dev) / Forbidden (prod) |
| `/api/leaderboard/*` | High score CRUD + ranking | Required |
| `/api/lobby/*` | Matchmaking + group management | Required |
| `/api/games/funquiz/*` | Fun quiz content + scoring | Required (scoring only) |
| `/api/games/couplequiz/*` | AI answer similarity (cached) | Required |
| `/api/games/joker/*` | Joke fetches (cached) | Anonymous |
| `/api/games/face/*` | Face/avatar operations | Required |
| `/api/games/survive/*` | Persist run state | Required |
| `/auth/*` | `login/microsoft`, `login/fake` (dev/test), `logout`, `me` | See `AuthEndpoints` |
| `/hubs/*` | SignalR hubs (Lobby, Survive) | Negotiate = Required; transfers = cookie |

### 3.2 Endpoint registration contract

Every endpoint file MUST:

1. Live under `Features/<Slice>/<Slice>Endpoints.cs`.
2. Expose a single `public static class <Slice>Endpoints` with one
   `public static RouteHandlerBuilder Map<Slicename>Endpoints(this IEndpointRouteBuilder app)`
   method.
3. Be invoked from `MapPoMiniGamesEndpoints` in source order.
4. Use `TypedResults` (not raw `Results`) so OpenAPI generation is exhaustive.
5. Apply `[Required]` / `[Authorize]` via `.RequireAuthorization()` chained on the
   `RouteHandlerBuilder` — never check auth inside the handler body.
6. Return `ProblemDetails` (`Results.ValidationProblem(...)`) for any 4xx.

### 3.3 Hub ↔ Endpoint parity

A hub method that mutates state MUST have a parallel HTTP endpoint that exposes the
same mutation for non-realtime clients (testing, recovery from disconnect, server-side
cron). The reverse is also true — any HTTP endpoint that broadcasts to other players
MUST also publish to the relevant SignalR group, not just write to storage.

---

## 4. Trimmer-Compatible Model Criteria

The host ships with `<EnableTrimAnalyzer>true</EnableTrimAnalyzer>` and
`<PublishTrimmed>true</PublishTrimmed>` for single-file release builds. **Models that
violate trim rules fail the build under `TreatWarningsAsErrors=true`.**

### 4.1 Rules every DTO must follow

1. **POCOs only.** Public properties, default constructor, no logic in property
   accessors. No `record` types crossing the API boundary (records use positional
   `init`-only setters that IL2026 may flag with `RequiresUnreferencedCode`).
2. **No reflection-driven serialization.** Use `System.Text.Json` source generators
   (`JsonSerializerContext`) for any type that crosses the wire — anonymous types,
   `ExpandoObject`, and `object` payloads are forbidden.
3. **No `dynamic`.** Static typing only.
4. **Sealed when complete.** Mark DTOs `sealed` so the trimmer can devirtualize calls.
5. **Enums by name.** Never cast `enum` to `int` for transport — serialize the name.
6. **No `[Required]` on value types.** Use nullable annotations (`string?`) instead.
7. **No `DateTimeOffset?` round-trips through `DateTime.MinValue`.** Prefer
   `DateTimeOffset` + ISO-8601 strings.

### 4.2 JSON source generation

Every project that serializes wire types MUST declare a partial
`JsonSerializerContext` and reference it from the `AddJsonOptions` call:

```csharp
[JsonSerializable(typeof(SubmitScoreRequest))]
[JsonSerializable(typeof(SubmitScoreResponse))]
[JsonSerializable(typeof(ProblemDetails))]
public partial class PoMiniGamesJsonContext : JsonSerializerContext { }
```

Forgetting this declaration triggers warning **IL2026** at the serialization site.

### 4.3 Logging source generation

Same constraint, applied to logging (see §5).

---

## 5. Zero-Allocation Source-Generated Logging

### 5.1 Rule

Every log call MUST use `[LoggerMessage]` source-generated methods. **No
`ILogger.LogXxx(...)` calls survive code review.** The generated code path is
allocation-free at runtime; the reflection-based path is not.

### 5.2 Pattern

```csharp
public static partial class LobbyLog
{
    [LoggerMessage(EventId = 1001, Level = LogLevel.Information,
        Message = "Lobby {LobbyId} joined by {UserId} as {Role}")]
    public static partial void LobbyJoined(this ILogger logger,
        string lobbyId, string userId, string role);

    [LoggerMessage(EventId = 1002, Level = LogLevel.Warning,
        Message = "Lobby {LobbyId} rejected join: {Reason}")]
    public static partial void LobbyJoinRejected(this ILogger logger,
        string lobbyId, string reason);
}
```

Rules:

1. One `partial class` per slice, named `<Slice>Log`.
2. `EventId` is reserved per slice (`1000–1999` Auth, `2000–2999` Leaderboard,
   `3000–3999` Lobby, `4000–4999` PoCoupleQuiz, `5000–5999` PoFace,
   `6000–6999` PoFunQuiz, `7000–7999` PoJoker, `8000–8999` PoSurvive).
3. Message template uses named placeholders only — no positional `{0}`.
4. Use `LogLevel.Trace` only for hub hot loops; **never** `Debug` in production builds.
5. Structured property names follow PascalCase — Serilog destructuring maps them to
   `@l` placeholders.

### 5.3 Forbidden patterns

- `_logger.LogInformation("joined " + lobbyId)` — string concatenation defeats
  source generation.
- `_logger.LogInformation("joined {0}", lobbyId)` — positional placeholders.
- `Serilog.Log.Information(...)` static calls — bypasses DI and the generated
  `Activity` correlation.
- `ILogger.BeginScope(new Dictionary<string, object> { ... })` — boxing the
  dictionary allocates on every request. Use the `LoggerMessage`-generated
  `DefineScope` instead.

### 5.4 Verification

`scripts/security-review.ps1` includes a grep gate that fails the build if any of
the forbidden patterns are introduced.

---

## 6. Performance Budgets (mobile portrait target)

| Surface | Budget |
|---|---|
| First contentful paint (cold start) | ≤ 2.0 s on 4G |
| Time-to-interactive (after auth) | ≤ 1.5 s |
| Game loop frame time | 16.6 ms (60 fps) sustained |
| HTTP request latency (BFF, in-region) | p95 ≤ 120 ms |
| SignalR round-trip | p95 ≤ 80 ms |
| WASM payload (initial) | ≤ 3.5 MB gzipped |
| Tracked-allocation per game frame | 0 B after warm-up |

Numbers are enforced by `scripts/security-review.ps1` and Playwright budget tests
under `tests/E2EUI/`.

---

## 7. Acceptance criteria (per game)

A game ships when:

1. Its slice (if any) passes `dotnet build` under `TreatWarningsAsErrors`.
2. Unit tests cover its `Handler` business logic (`tests/PoMiniGames.Unit`).
3. Integration tests cover its endpoint + storage via Testcontainers.Azurite
   (`tests/PoMiniGames.Integration`).
4. HTTP-contract tests cover success + every documented 4xx/5xx
   (`tests/E2EAPI`).
5. Playwright tests cover the mobile-portrait happy path + at least one
   failure path (`tests/E2EUI`).
6. The README diagram in `/docs` references the game by name.

---

## 8. Change-control

- Topology changes → edit `AGENT.MD` first, then this file.
- Contract changes (DTOs, endpoints, EventIds) → edit this file, then the slice.
- Logging changes → add a new `[LoggerMessage]` line; **never** change the
  `EventId` of an existing message (downstream alerts depend on stability).