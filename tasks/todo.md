# Todo Checklist — PoJevArena

Each task touches ≤ 5 files and follows Red → Green → targeted tests → `dotnet build` → `dotnet format` → one commit. Plan: [`tasks/plan.md`](plan.md). Spec: [`SPEC.md`](../SPEC.md).


- [x] **T0 Unit ceiling repair.** Fold these without dropping any assertion:
  - `Health/DiagProjectionTests` (−3)
  - `Auth/MicrosoftAuthIssuerValidatorTests` (−2)
  - `Infrastructure/HighScoreDescriptorTests` (−2)
  - `AI/DeploymentPricingTests` (−2): keep the exact `Be(0d)` clamp assert inside the catalog fact
  - `Infrastructure/AIFoundryCentralizationTests` (−2)

  Unit goes 104 → 93. *Accept:* `pwsh scripts/test-ceilings.ps1` passes for Unit, and the five classes pass with `--filter`.
- [x] **T0b E2E-API room.** Fold `DeploymentSmokeTests` into one theory over the paths (−2), taking E2E-API to 23/25.
  *Accept:* ceilings pass; `--filter DeploymentSmokeTests` passes (needs Azurite).
- [x] **T1 Shared contracts.** Write `PoJevArenaShared.cs`: the catalogs, the ability registry, the budget function,
  bounds, the five presets, the DTOs and `PoJevArenaJsonContext`. Test first in
  `Unit/Features/PoJevArena/CreatureRulesTests.cs`: theory `CreatureValidation_RejectsOutOfBoundsAndOffCatalog`, which
  also asserts presets are within budget and every registry row is unique in id and option. *Files:* 2.
- [x] **T2a Prompt builder + test packages.**
  - `JevPromptBuilder.cs` and the test `JevPromptBuilder_BuildsStateAndOptions`, with Verify snapshots for the 5 presets
    plus an ability-less and a no-candidate scenario.
  - Package edits: `Directory.Packages.props`, `PoMiniGames.Unit.csproj` (Verify + TimeProvider.Testing), `.gitignore`.
- [x] **T2b Jev client.** `Jev/JevOptions.cs`, `Jev/JevWire.cs`, `Jev/JevClient.cs`, `Jev/StubJevClient.cs`, and test
  `JevResponse_MapsOrFails`. That theory uses a stub `HttpMessageHandler` and covers ok, missing key, unknown option,
  NaN, 401, 402, 429 and timeout.
- [x] **T2c Jev wiring.** In `GameServicesExtensions.cs`: options, named client, limiter, and Test-only stub selection.
  Also `appsettings.json` (the `PoMiniGames:Jev` block with an empty key), `tests/Shared/TestBudgetGuard.cs`
  (`PoMiniGames:Jev:UseStub`) and `PoJevArenaLog.cs`. *Accept:* the host boots with no key and logs "Jev not configured".
- [x] **T3 Daily allowance.**
  - `AiTokenLedgerStore.cs` gets the optional table name.
  - `GameServicesExtensions.cs` registers the keyed budget and the flush service.
  - `StorageInitializer.cs` adds the `PoJevArenaCallLedger` table.
  - Test `CallAllowance_AndMatchRegistry_Contracts` (allowance rows now) uses FakeTimeProvider: limit boundary,
    whole-batch reject, UTC rollover.
  - Existing `AiTokenBudget*` tests still pass.
- [x] **T4 Match registry + decision endpoints.**
  - `ArenaMatchRegistry.cs`.
  - `PoJevArenaEndpoints.cs` with status, register match and decisions (parallel fan-out, per-unit results, 429 plus
    `Retry-After`, cost sum).
  - `RateLimitingExtensions.cs` gets `pojevarena` (30/min) and `pojevarena-decide` (300/min).
  - `EndpointRouteExtensions.cs` wiring.
  - Add registry rows to the T3 theory (one-shot, owner-only, 40-decision minimum, TTL via FakeTimeProvider).
- [x] **Checkpoint C1:** (real Jev smoke: 2 units ok, 330-420 ms, $0.0000315/call) build; `--filter PoJevArena` Unit; ceilings; restart host → `/health` 200; hit `/api/pojevarena/status` with fake auth.
- [x] **T5 Creature library.**
  - `CreatureLibraryStore.cs`.
  - Creature routes plus the result route (stat increments) in `PoJevArenaEndpoints.cs`.
  - `StorageInitializer.cs` adds the `PoJevArenaCreatures` table.
  - Integration test `PoJevArenaLibraryTests`, one theory: round-trip, owner-only edit and delete, cap 25 → 409,
    parallel result increments commute. It uses the factory's `TableServiceClient` and guards on `DockerAvailable`.
- [x] **T6 Contract + infra.**
  - E2E-API `PoJevArenaContractTests`, one theory over `(method, path, authed, body, expected)`: anonymous → 401;
    authed without antiforgery → 403; authed + armed bad body → 400/422. Set the `X-Fake-User` header first, then
    `ArmAntiforgeryAsync()`.
  - Restore the conditional `jevApiKey` secret in `infra/kv-secrets.bicep`, `infra/main.bicep` and
    `infra/main.parameters.json` from `2235ed7d^`.
- [x] **Checkpoint C2:** Integration and E2E-API `--filter PoJevArena` (Azurite up); ceilings.
- [x] **T7 Sim + abilities** (`sim.js`, `abilities.js`).
  - Scratch node harness in the scratchpad, written first so it fails first. It checks: an ability-less unit kills by
    melee; every ability triggers; the damage-pipeline order; the 3:00 HP% rule; no NaN over 10,800 ticks;
    determinism by seed.
- [x] **T8a Creature art.** `creatures.js` (silhouette from data, cached per-team bitmaps, faces, mannerisms,
  animation state machine) and `render.js` (arena, units, HP bars, intent overlay, team base markers, DPR,
  reduced motion).
- [x] **T8b Ability FX.** `fx.js`: wind-up, release and impact per registry id; particles capped at 400; popups;
  decals; replay-safe seeded particles. *Accept:* render p95 ≤ 8 ms, measured.
- [x] **T9 Scheduler + Black Box + lifecycle.**
  - `scheduler.js`: slot = index mod 4, no overlapping calls, candidate computation, hold intent plus a stale timer,
    pause on `visibilitychange`.
  - `blackbox.js`: typed-array frames plus combat and decision events.
  - `index.js`: mount, preview, deploy, select, scrub, play, stop, unmount; releases every listener, rAF and bitmap.
  - `engineLoader.js` `REGISTRY` entry.
  - The harness asserts ≤ 20 calls/s.
- [x] **Checkpoint C3:** node harness 11/11; trimmed publish 0 IL2xxx; `_framework` 12.39 MB (budget 25). Render p95 still to measure with a GPU at C4.
- [x] **T10 Design gate (Phase 3).** User picked concept 10, Dual Inspector (per-team inspectors beside the arena).
  Original text: Publish one Artifact canvas with 10 layout concepts for the page (Factory,
  Library, Rosters, Arena, Inspector, Black Box) across desktop and phone. Stop for the user's pick, then confirm the
  component hierarchy. **No UI code before this.**
- [x] **T11a Catalog wiring.** Add `PoJevArena` to Domain `Primitives/GameKey.cs` (field only, not the `All[]`
  allowlist) and client `Models/GameKey.cs`. Add the `GameCatalog.cs` entry (1player, 2player, demo). Add
  `pojevarena` to `Layout/MainLayout.razor` `GameRoutePrefixes`, plus the missing `pocabinet` (SPEC OQ2).
- [x] **T11b Page shell.**
  - `PoJevArenaPage.razor`, `.razor.cs` and `.razor.css`, using `GameShell` + `GameIntro` and mode from
    `GameModes.Parse`.
  - `PoJevArenaApiClient.cs` with its own source-gen context and try/catch → null.
  - Register in `Client/Program.cs`.
  - Status chip and the Jev-unavailable state.
- [x] **T12 Factory + Library.** `CreatureFactory.razor` (sliders, ability pickers, budget meter, live preview canvas
  via `PoJevArena.preview`) and `CreatureLibrary.razor` (`<Virtualize>`, sort and search, own-row edit and delete,
  animated portraits). Page CSS uses `::deep`.
- [x] **T13 Rosters + modes.** `RosterTrays.razor`: 2×10 slots, the 2P lock and hand-off flow, Blazored.LocalStorage
  persistence, deleted-id pruning.
- [x] **T14 Arena, Inspector, Black Box.** `JevInspector.razor` (probability bars, confidence, panic, stale) and
  `BlackBoxScrubber.razor` (transport, speed, timeline, decision jumps). Deploy flow: register → mount → `DecideAsync`
  → end → report the result. Banners for every SPEC §10 state.
- [x] **T15 Demo + E2E-UI.**
  - Demo loop (presets plus random library creatures, highlight replay, allowance stop).
  - E2E-UI `PoJevArenaUiTests`, one test: guest → save creature → draft 10+10 → deploy (stub) → banner → scrub →
    inspector values change.
  - Screenshot sheet written to `artifacts/pojevarena/*.png`: per preset × team × pose, and per ability.
- [x] **Checkpoint C4:** PoJevArena tests green in every tier; ceilings Unit 97 · Integration 50 · E2E-API 24 · E2E-UI 21; trimmed publish clean, `_framework` 12.39 MB; host `/health` 200; real-Jev match played end to end (2:38, 2,545 calls, ~$0.08, 0 console errors); draw p95 1.9 ms.
- [x] **T16 Docs.** `CLAUDE.md` gets the slice entry, "fourteen games", the Jev boundary contract and the test-stub
  rule. `README.md` gets the game row. Keep `SPEC.md` and `tasks/todo.md` in sync.
- [ ] **Phase 5:** full suite (`scripts/test-all.ps1` — the NET_START workflow explicitly asks for it),
  `/code-review`, `/security-review`, `/simplify`, re-test, then evidence per SPEC §13 criterion (command output and
  screenshots). A real-key smoke match (SPEC criterion 6) needs the user's OpenRouter key in
  `appsettings.Development.json` or Key Vault.

