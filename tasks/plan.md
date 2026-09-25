# Implementation Plan — PoJevArena (10v10 Jev-Driven Creature Battle)

## Context
The user wants the PoJevArena PRD built as a 14th mini-game inside PoMiniGames, following the patterns the other
games use. The spec (`SPEC.md`) and module map (`CAPABILITY-MAP.md`) are approved. Their key decisions:
- Real Jev is required, with no fallback; a failed call means the unit holds its last intent.
- Units decide at 1 Hz, staggered.
- The simulation runs in the browser, with a server proxy that builds every prompt itself.
- 1player, 2player and demo modes.
- A 20k/day call cap per identity.
- A public creature library in Table Storage with win/loss stats and an 80-point build budget.
- Universal melee plus an ability registry (offense and defense slots, 6 abilities, extensible).
- Procedural animated creatures.

The user picked tools 1–14 (already in the repo) and added Verify.Xunit and FakeTimeProvider.

On approval, the first action copies this plan into `tasks/plan.md` and the checklist below into `tasks/todo.md`,
replacing the PoCabinet versions, which stay in git.

## Tool selection (pinned)
Already in use: Blazor built-ins, IJSRuntime/DotNetObjectReference, STJ source-gen, Minimal APIs + OpenAPI/Scalar,
Azure.Data.Tables + `TableConcurrency`, Http.Resilience 10.7.0, RateLimiting, IMemoryCache/HybridCache,
Serilog + LoggerMessage + OTel metrics, Blazored.LocalStorage 4.5.0, xUnit/FluentAssertions/NSubstitute,
Testcontainers.Azurite + WebApplicationFactory, Playwright 1.50.0, coverlet.

**New (Unit test project only, no WASM bundle impact):**
- `Verify.Xunit` **31.12.5**. It depends on xunit.extensibility.execution 2.9.3, which matches the pinned xunit 2.9.3.
- `Microsoft.Extensions.TimeProvider.Testing` **10.7.0**, the same release train as Http.Resilience 10.7.0.

Both go in `Directory.Packages.props`. Add `*.received.*` to `.gitignore` and commit `*.verified.txt`.

## Architecture decisions
1. **Reuse, don't clone, the daily cap.**
   - `AiTokenBudget` (`src/PoMiniGames.API/AI/AiTokenBudget.cs`) is already a generic durable per-identity daily counter.
   - Register a second instance as a keyed singleton `"pojevarena"` built with the `(limit, clock, store)` constructor.
   - Give `TableAiTokenLedgerStore` (`AI/AiTokenLedgerStore.cs:62-205`) an optional `tableName` constructor parameter,
     defaulting to `"AiTokenLedger"`, so it can back table `PoJevArenaCallLedger`.
   - Flush it with the existing `AiTokenBudgetFlushService`, registered through
     `services.AddSingleton<IHostedService>(sp => new AiTokenBudgetFlushService(keyedBudget, …))`.
     `AddHostedService<T>` uses TryAddEnumerable and would silently drop a second registration of the same type.
   - Batch check: `verdict.Spent + units <= verdict.Limit`, then `Record(identity, successfulCalls)`.
2. **The Jev boundary is feature-owned** (`Features/PoJevArena/Jev/`). It's restored from `git show 2235ed7d^:…`
   and trimmed to one method: `EvaluateUnitAsync(state, questions, sessionId, user, ct)`, returning answers + usage,
   or a typed failure.
   - Named HttpClient: 1.5 s timeout, `AddStandardResilienceHandler` with retries disabled.
   - A process-wide `ConcurrencyLimiter(16, queue 64)`.
   - Endpoint `https://openrouter.ai/api/v1/systemone`, model `typesafe/jev-1.13`.
3. **Stub only in the `Test` environment.** `PoMiniGames:Jev:UseStub` is honoured only when `env.IsEnvironment("Test")`.
   This is stricter than `Features/Shared/AiMockFallback.ShouldUseMock`, which also allows Development. It's the one
   `TestBudgetGuard` line. The stub answers deterministically from the offered options (first option, p=0.6, noul 0.1),
   so E2E matches progress.
4. **The prompt builder is pure and server-side** (`JevPromptBuilder`). Validated structured input goes in; the state
   string and question set come out, both driven by the Shared ability registry. Verify snapshots per preset pin the
   exact wording Jev sees.
5. **Shared is the single source** (`PoMiniGames.Shared/Games/PoJevArenaShared.cs`) for the catalogs, the ability
   registry, the budget function, bounds, the presets, the DTOs and the JsonContext. JS mirrors ids only.
6. **Match registry** is `IMemoryCache` (15-min sliding) → rosters, owner, seed, decisionCount, reported. The result
   gate is owner-only, one-shot and needs ≥ 40 decisions.
7. **Engine** (`wwwroot/js/pojevarena/`) is a `window.PoJevArena` global via `engineLoader.js` `REGISTRY`, the PoCabinet
   pattern.
   - Canvases are passed by id.
   - `DotNetObjectReference` with `[JSInvokable] DecideAsync(string json)` returns JSON: the PoEcosystem
     `OnCloudThought` request/response pattern, so every API call rides the existing antiforgery and credentials
     `HttpClient` pipeline.
   - `sim.js` is pure and node-runnable.
8. **Test room**: Unit is at 104/100 and E2E-API at 25/25, so T0 frees slots by folding tests. No cap is raised.

## Ten implementation examples (how the picks are used)
1. **Virtualize library** — `<Virtualize Items="_filtered" ItemSize="84" Context="c"><CreatureCard Creature="c" .../></Virtualize>`.
2. **Interop round trip** — JS `const r = await dotnet.invokeMethodAsync('DecideAsync', JSON.stringify(batch));` ↔
   C# `[JSInvokable] public async Task<string> DecideAsync(string json) => JsonSerializer.Serialize(await _api.DecideAsync(_matchId, Deserialize(json)), ArenaJson.Default.DecideResponse);`
3. **Source-gen JSON** — `[JsonSerializable(typeof(CreatureDto[]))] [JsonSerializable(typeof(DecideRequest))] internal sealed partial class ArenaJson : JsonSerializerContext;` with `JsonSourceGenerationOptions(CamelCase, UseStringEnumConverter = true)`.
4. **Route group** — `var g = api.MapGroup("/pojevarena").WithTags("PoJevArena"); g.MapPost("/matches/{id}/decisions", Decide).RequireRateLimiting("pojevarena-decide");` returning `Results<Ok<DecideResponse>, NotFound, ProblemHttpResult>`.
5. **Counter increments** — `TableConcurrency.UpdateWithRetryAsync<CreatureEntity>(table, "lib", id, () => throw …, e => { e.Deployed++; e.Wins += won; return true; }, ct)`.
6. **Resilient named client** — `services.AddHttpClient("jev", c => c.BaseAddress = new(opts.Endpoint)).AddStandardResilienceHandler(o => { o.Retry.MaxRetryAttempts = 0; o.AttemptTimeout.Timeout = TimeSpan.FromMilliseconds(1500); });`. Check first whether `MaxRetryAttempts = 0` passes the options validator; if not, use `AddResilienceHandler` with timeout + circuit breaker only.
7. **Concurrency gate** — `using var lease = await _limiter.AcquireAsync(1, ct); if (!lease.IsAcquired) return UnitFailure.Busy;`
8. **Metrics + logs** — `Meter("PoMiniGames.PoJevArena")` with histogram `jev.latency.ms`, counters `jev.calls` and `jev.cost.usd`; `[LoggerMessage(EventId=…, Level=Warning, Message="Jev {Status} for {Unit}")]`.
9. **Verify snapshot** — `[Theory][MemberData(nameof(Presets))] public Task JevPromptBuilder_BuildsStateAndOptions(string preset) => Verify(JevPromptBuilder.Build(Scenario(preset))).UseParameters(preset);`
10. **FakeTimeProvider** — `var t = new FakeTimeProvider(new(2026,9,25,23,59,0,TimeSpan.Zero)); var b = new AiTokenBudget(20_000, t.GetUtcNow, store); … t.Advance(TimeSpan.FromMinutes(2)); (await b.CheckAsync(id)).Spent.Should().Be(0);`

## Dependency graph
```
T0 ─► T1 ─► T2a ─► T2b ─► T2c ─► T3 ─► T4 ─► T5 ─► T6
       └──► T7 ─► T8a ─► T8b ─► T9 ──────────────┐
                                     T10 (design gate) ─► T11a ─► T11b ─► T12 ─► T13 ─► T14 ─► T15 ─► T16
```
The server track (T2–T6) and the engine track (T7–T9) are independent after T1. The UI (T11+) needs T5, T9 and the T10 design choice.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OpenRouter Jev rate limit unknown; 429s at 20 calls/s | Med | Units go stale | 16-permit limiter; smoke run measures the 429 rate; drop to 8 permits if > 1% (SPEC OQ4) |
| Jev latency > 1 s makes 1 Hz decisions lag | Med | Sluggish tactics | 1.5 s timeout; hold intent; latency histogram; inspector shows staleness |
| `MaxRetryAttempts = 0` rejected by resilience options validation | Med | Boot failure | Fall back to a custom pipeline (timeout + breaker) in T2c |
| Test ceilings (Unit over, E2E-API full) | High | CI red | T0 folds 11 Unit and 2 E2E-API methods before any new test |
| Canvas perf with 20 animated units + fx | Med | < 60 FPS | Cached body bitmaps, particle cap 400, render budget 8 ms measured in T8b |
| Trim analyzer on new client code | Low | CI red | Source-gen JSON only; trim publish at checkpoints C3 and C6 |
| Budget/ability balance makes one build dominant | Med | Stale meta | Costs are data; tuning is a registry edit (SPEC OQ6) |
| Upstream key/credits (402) in prod | Low | Deploy disabled | `status` surfaces it; banner; Key Vault secret restored in T6 |
| Verify snapshots + LF gate (`.gitattributes eol=lf`) | Low | Format churn | Verified files are text and LF; `*.received.*` ignored |

The live checklist is [`tasks/todo.md`](todo.md).
## Verification (end-to-end)
- `dotnet build PoMiniGames.slnx` (0 warnings) and `dotnet format --verify-no-changes`.
- Per tier: `dotnet test <tier> --filter "FullyQualifiedName~PoJevArena"`, then `pwsh scripts/test-ceilings.ps1`.
- `docker compose up -d azurite`, then `dotnet run --project src/PoMiniGames.API/...`, then `/health` 200, then play
  `/pojevarena/1player|2player|demo` in a browser. Without a key, expect "Jev unavailable". With a key, run a full
  match and watch the logs for calls/s, 429 rate and summed cost.
- Trim publish for IL2xxx and a `_framework` size check.
- Screenshot sheet review for readability (SPEC criteria 15–16).

## Standing notes
- NET_START's "Radzen First" and `dotnet user-secrets` rules are overridden by `CLAUDE.md` (native Blazor; Key Vault or appsettings).
- ponytail is a user-scope Claude Code plugin; the user installs it with `/plugin` if they want it. It is not part of this repo.
- Commits go to `master`, one per task, in the casual commit style. No push without an explicit ask.
