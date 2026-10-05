# PoMule build plan

Task checklist: `tasks/todo.md`. Requirements: `SPEC.md`.

## Context

PoMiniGames gets a 15th game, PoMule: an 8-player M.U.L.E. with 1 Player and Demo modes
(`SPEC.md`, `CAPABILITY-MAP.md`). It is also the first screen built with Radzen. The rules
live in C# in `PoMiniGames.Shared` so they can be test-driven; JavaScript draws and runs the
60 fps movement. Approved 2026-10-05.

Order after approval: task 0 → Phase 3 design concepts (needed before task 16 only) → tasks
1–23 → Phase 5 verification.

## 1. Architecture decisions

| # | Decision | Why |
|---|---|---|
| A1 | Engine is pure C# in `src/PoMiniGames.Shared/Games/PoMule/`, namespace `PoMiniGames.Shared.Games.PoMule`; no I/O, no clock, one seeded PRNG | Deterministic, trim-clean, unit-testable, reusable by the server later |
| A2 | JS owns the frame loop and is the only clock: every 100 ms of game time it calls `[JSInvokable] OnTick`; C# advances the engine and returns one flat snapshot array | One interop round trip per 100 ms. Tab hidden pauses for free. Demo 4× = JS scales dt |
| A3 | Development phase: JS simulates positions, collisions and tether; it reports discrete events (`OnEnterBuilding`, `OnReachPlot`, `OnBump`) for all 8 avatars; the engine validates each against ownership, cash, stock and clock | No per-frame interop; the engine stays the authority on money and goods |
| A4 | AI: the engine picks each AI's next goal (building or plot) and its market and bid moves; JS only steers toward the goal | AI decisions are tested in C# |
| A5 | Market and auctions run fully in the engine at 10 Hz; JS draws lanes from the snapshot | Trade rule is testable; rendering is dumb |
| A6 | Page uses the existing `GameShell` + `GameIntro` + `GameOverModal`; everything inside is Radzen | Opens and ends like the other 14 games |
| A7 | Radzen CSS and JS are added to `<head>` when the PoMule page mounts and removed on dispose (extends the `poecosystem/index.js:31-45` pattern) | Radzen's global styles must not touch other games before the migration |
| A8 | Score path copies PoVoxelStrike end to end (descriptor, endpoint, `ScoreIntegrityGuard`, `GameResultService`, `ScoreSyncService`) | Existing pattern, no new mechanism |
| A9 | Resume: one `PoMuleSave` record, serialised with a source-gen context, written with `ILocalStorageService.SetItemAsStringAsync` at each month end (pattern: `Games/PoCabinet/PoCabinetCareerState.cs:40-67`) | Trim-safe, existing dependency |
| A10 | Touch: DOM buttons that dispatch synthetic key events (pattern: `js/posports/touch.js`) | Keyboard path stays the only input path |

## 2. Dependency graph

```
T1 Radzen spike ───────────────────────────────────────────┐
T2 RNG+map → T3 species/state → T4 land → T5 development    │
                         └→ T6 production → T7 market       │
                                   └→ T8 AI → T9 match      │
T10 domain → T11 storage → T12 API → T13 client api → T14 sync
T15 JS world/physics (needs T2 map shape only)              │
T9 + T14 + T15 + T1 + Phase 3 design → T16 page shell ──────┘
T16 → T17 development live → T18 land UI → T19 market UI
T19 → T20 standings/submit/resume → T21 touch → T22 demo+reel → T23 docs
```

T1, T2–T9, T10–T14 and T15 are independent chains; they are done in the listed order.

## 3. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 (closed) | Radzen 12.0.5 needs ASP.NET Components ≥ 10.0.12; repo pinned 10.0.10. Pins moved to 10.0.12 in T1 | High | Build fails | T1 bumps the `Microsoft.AspNetCore.*` 10.0.x pins together; fallback is the newest Radzen that accepts 10.0.10 |
| R2 (closed, publish is clean) | Radzen raises trim warnings on the trimmed publish (warnings are errors) | Medium | Blocks everything UI | T1 publishes Release before any game code. If it fails: stop and ask |
| R3 | Radzen CSS leaks into other games | Medium | Visual regressions | A7; T16 checks the hub after leaving PoMule |
| R4 | Balance targets (criterion 11) need many tuning rounds | High | Schedule | All numbers in one `PoMuleTuning` static class; T9 is time-boxed to 3 tuning passes, then the gap is reported |
| R5 | Unit cap of 140 too small | Low | Blocks TDD | `[Theory]` rows; renderer maths in uncapped `node --test` |
| R6 | 8 AI goals + snapshot per 100 ms too slow in WASM | Low | Jank | Snapshot is one `double[]`; measure in T17; AOT is the fallback (ask first) |
| R7 | Home grid is sized for exactly 15 cells; PoMule makes 16 | Certain | Hub layout breaks | T22 edits `Pages/Index.razor.css` (a shared file; approving this plan approves that edit) |
| R8 | `GameLeaderboardDto` unit label is a "closed vocabulary" | Medium | Wrong label on board | T12 finds the list before using "Net Worth" |

## 4. Checkpoints

| After | Check |
|---|---|
| T1 | Release publish is clean; bundle size delta recorded. **Go / no-go for Radzen** |
| T3 | Map, species and scoring tests green; ceilings script green at 140 |
| T6 | A scripted month (claim, develop, produce, event) runs in a test |
| T9 | 100 seeded 8-AI matches: determinism, no negatives, criterion 11. Engine coverage ≥ 90% |
| T12 | Score posts and lists against Azurite; `/api/leaderboards/pomule` answers |
| T15 | `node --test tests/pomule-*.test.mjs` green |
| T19 | A full month is playable by hand in the browser; screenshot |
| T22 | Demo completes 12 months in 5–8 min; reel advances; hub grid intact |
| T23 | Hand-off to Phase 5 |

## 5. Ten implementation examples (how the chosen tools are used)

**1. Seeded PRNG (no package)** – identical on every .NET version and in saved matches.
```csharp
public struct PoMuleRng(ulong seed)
{
    private ulong _s = seed == 0 ? 0x9E3779B97F4A7C15 : seed;
    public uint Next() { _s ^= _s << 13; _s ^= _s >> 7; _s ^= _s << 17; return (uint)(_s >> 32); }
    public int Next(int max) => (int)(Next() % (uint)max);
}
```

**2. Frozen tables** for yields and prices.
```csharp
internal static readonly FrozenDictionary<Terrain, Yield> BaseYield = new Dictionary<Terrain, Yield>
{
    [Terrain.River] = new(4, 2, 1, 0), [Terrain.Plains] = new(2, 3, 1, 0),
}.ToFrozenDictionary();
```

**3. Theory-heavy xUnit** – many cases, one slot against the cap.
```csharp
[Theory]
[InlineData(0, 23, 1)] [InlineData(2, 14, 12)] [InlineData(5, 5, 0)]
public void ColumnDistance_GoesTheShortWayRound(int a, int b, int expected) =>
    Plot.ColumnDistance(a, b).Should().Be(expected);
```

**4. Verify snapshot** of a whole seeded match, so any rule change shows up as a diff.
```csharp
[Fact]
public Task Seed42_DemoMatch_FinalStandings() =>
    Verifier.Verify(PoMuleMatch.RunToEnd(seed: 42, humanSeat: null).Standings);
```

**5. Source-generated JSON for the save record.**
```csharp
[JsonSerializable(typeof(PoMuleSave))]
public sealed partial class PoMuleJsonContext : JsonSerializerContext;
```

**6. Resume through Blazored.LocalStorage (string API only).**
```csharp
await _storage.SetItemAsStringAsync("pomule.save.v1",
    JsonSerializer.Serialize(save, PoMuleJsonContext.Default.PoMuleSave));
```

**7. Tick interop with a flat snapshot** (PoRacer pattern).
```csharp
[JSInvokable] public double[] OnTick(int ticks) { _match.Advance(ticks); return _match.Snapshot(); }
```
```js
const snap = await dotnetRef.invokeMethodAsync('OnTick', ticks); // phase, clock, 8×(cash, goods, laneY, goalX, goalY)
```

**8. Radzen standings grid and Net Worth chart.**
```razor
<RadzenDataGrid Data="@_standings" TItem="Standing" AllowSorting="true">
  <Columns>
    <RadzenDataGridColumn TItem="Standing" Property="Name" Title="Colonist" />
    <RadzenDataGridColumn TItem="Standing" Property="NetWorth" Title="Net Worth" FormatString="{0:N0}" />
  </Columns>
</RadzenDataGrid>
<RadzenChart>
  @foreach (var p in _history)
  { <RadzenLineSeries Data="@p.Months" CategoryProperty="Month" ValueProperty="NetWorth" Title="@p.Name" /> }
</RadzenChart>
```

**9. Radzen timer and event alerts.**
```razor
<RadzenProgressBar Value="@_secondsLeft" Max="45" ShowValue="false" />
```
```csharp
Notifications.Notify(NotificationSeverity.Warning, "Planetquake", "Smithore and Crystite output halved");
```

**10. Node test for renderer maths** (module has no imports and touches no `window`).
```js
const { wrapX } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('avatar leaving column 24 re-enters at column 1', () => assert.equal(wrapX(24.2, 24), 0.2));
```

Radzen component names in 8 and 9 are confirmed against the Radzen docs in T1 before use.

## 7. Verification (Phase 5)

1. `pwsh scripts/test-all.ps1` and `node --test tests/pomule-*.test.mjs`.
2. `pwsh scripts/test-ceilings.ps1` (140 / 50 / 25 / 25).
3. Run the app, play one full 1 Player match in the browser, watch one Demo match, run the
   hub reel through PoMule; capture screenshots into `SCREENSHOTS/`.
4. `/code-review`, `/security-review`, `/simplify`, then re-run the related tests.
5. A table mapping each of the 16 success criteria in `SPEC.md` §13 to its evidence.
