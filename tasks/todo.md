# Todo Checklist — PoCabinet (Cockpit-View Political Satire Racer)

Each task is a vertical slice touching ≤ 5 files. All tasks follow strict TDD: Red → Green → Build → Verify.

**Test-budget strategy**: The Unit tier is at 100/100 with **carefully balanced intentional design** — most files document past consolidations in their header remarks. The framework's documented alternative per [`CLAUDE.md`](CLAUDE.md) is to **relocate to a cheaper tier**, not to consolidate further. PoCabinet therefore allocates Unit-test coverage to **higher tiers with headroom** (Integration: 3 slots, E2E-API: 6 slots, E2E-UI: 8 slots). Unit tests added only where higher-tier coverage cannot reach (e.g., trim-analyzer gate, three.js scene contracts — both verified by visual audit instead).

| Tier | Cap | Pre-PoCabinet | PoCabinet Allocation | Final |
|------|-----|---------------|-----------------------|-------|
| Unit | 100 | 100 | **0** (relocated to higher tiers) | 100 |
| Integration | 50 | 47 | +3 (T2 determinism + T5 storage + T5 elo) | 50 (at cap) |
| E2E-API | 25 | 19 | +4 (T2 physics + T3 ai + T4 wire + T6 lobby) | 23 (2 slots free) |
| E2E-UI | 25 | 17 | +3 (T1 track render + T4 career flow + T7 route renders) | 20 (5 slots free) |

**Total PoCabinet tests: 10.** Per-task counts:

| Task | Unit | Integration | E2E-API | E2E-UI |
|------|------|-------------|---------|--------|
| T1 Track Geometry | 0 | 0 | 0 | 0 (deferred to T7) |
| T2 Physics + Cockpit | 0 | 1 | 1 | 0 |
| T3 AI + Dialogue | 0 | 0 | 1 | 0 |
| T4 Wire + Career | 0 | 0 | 1 | 1 |
| T5 Leaderboards | 0 | 2 | 0 | 0 |
| T6 Multiplayer Lobby | 0 | 0 | 1 | 0 |
| T7 Native Blazor UI | 0 | 0 | 0 | 2 |
| T8 Trim/Bundle Verify | 0 | 0 | 0 | 0 |
| **Total** | **0** | **3** | **4** | **3** |

---

- [ ] **Task 1: Track Geometry & Themed Environments**
  - **Description**: Define mathematical spline representations for the 3 tracks (Capitol Speedway, Mar-a-Lago GP, Press Briefing 500), closed Catmull-Rom resampling, wall normal calculations, surface zones, and atmospheric parameters per track. Server-side `PoCabinetTrackRegistry` + client-side `scene.js` (three.js scene base with Lambert chunk pattern).
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetTrackData.cs`
    2. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetTrackRegistry.cs`
    3. `src/PoMiniGames.Shared/Games/PoCabinetCatalog.cs` (track metadata catalog)
    4. `src/PoMiniGames.Client/wwwroot/js/pocabinet/scene.js`
    5. *(reserved for ≤5 budget)* n/a — E2E-UI verification deferred to T7 when the route is wired up
  - **Acceptance Criteria**: All 3 tracks form valid closed loops (verified by `dotnet build` + visual smoke at T7); wall generation produces non-zero length segments; checkpoint ordering consistent; atmosphere parameters differ per track; visual audit shows scene canvas mounts without GL state leak.
  - **Verification**: `dotnet build PoMiniGames.slnx` — no test added at T1; the route doesn't exist yet, so E2E-UI tests come in T7.

---

- [ ] **Task 2: Vehicle Physics & Cockpit Interior**
  - **Description**: Server-authoritative physics tick in `PoCabinetSim.cs` (throttle, brake, steering, grip, speed clamping, wall collisions, surface zones). Client-side `cockpit.js` rendering steering wheel, hood, RPM gauge, speedometer, rear-view mirror as three.js primitives. Camera tied to car heading with damping.
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetSim.cs`
    2. `src/PoMiniGames.Client/wwwroot/js/pocabinet/cockpit.js`
    3. `src/PoMiniGames.Client/wwwroot/js/pocabinet/cars.js` (car 3D mesh, used by cockpit + AI render)
    4. `tests/PoMiniGames.E2EAPI/Features/PoCabinet/PoCabinetPhysicsContractTests.cs` (HTTP contract: physics tick serializes correctly, lap transitions reported)
    5. `tests/PoMiniGames.Integration/Features/PoCabinet/PoCabinetSimDeterminismTests.cs` (same-seed replay → identical snapshots; under Azurite since the sim tick is server-side)
  - **Acceptance Criteria**: Speed clamped within safety bounds; grip degrades on low-friction surfaces; wall collisions resolve; camera position never enters a wall volume; cockpit assets mount/unmount cleanly; same-seed replay produces identical snapshots.
  - **Verification**:
    ```powershell
    dotnet test tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj --filter "FullyQualifiedName~PoCabinetPhysics"
    dotnet test tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj --filter "FullyQualifiedName~PoCabinetSim"
    ```

---

- [ ] **Task 3: AI Roster & Scripted Dialogue**
  - **Description**: Define 4 named AI officials (Sean S., Steve B., Bill B., Mike P.) as frozen structs of PoRacer's `PoRacerAiDriver`-style parameters (LookaheadDistance, LateralOffset, BrakingAggression, CollisionTolerance, DraftingAffinity). Integrate look-ahead steering into `PoCabinetSim.cs`. Add `PoCabinetDialogue.cs` with per-official dialogue pools keyed by `DialogueKind` (PreRace, PositionChange, LapFinish, RaceFinish); deterministic seed-based selection; `playedIndices` set prevents immediate repeat. Client-side `dialogue.js` overlays lines.
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetAiDriver.cs`
    2. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetDialogue.cs`
    3. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetSim.cs` (updated; integration point)
    4. `src/PoMiniGames.Client/wwwroot/js/pocabinet/dialogue.js`
    5. `tests/PoMiniGames.E2EAPI/Features/PoCabinet/PoCabinetAiPersonalityTests.cs` (HTTP contract: race-snapshot includes personality-driven heading; differentiation asserted via API)
  - **Acceptance Criteria**: Each official completes a 3-lap race without stalling; ≥5° average heading delta between any two officials over a 3-lap race; dialogue selection is deterministic by seed; pool exhaustion falls back to a generic line; content scan rejects slurs/hate speech.
  - **Verification**: `dotnet test tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj --filter "FullyQualifiedName~PoCabinetAi|FullyQualifiedName~PoCabinetDialogue"`

---

- [ ] **Task 4: Wire Protocol & Career State**
  - **Description**: Add `PoCabinetShared.cs` with race DTOs (`PoCabinetRaceSnapshot`, `PoCabinetJoinResponse`, `PoCabinetCareerDto`, etc.), TrackKind, OfficialKind, DialogueKind enums. JSON wire size ≤ 2 KB per snapshot at 8 cars. Client-side `PoCabinetCareerState.cs` wraps Blazored.LocalStorage for typed career state. Server-side `PoCabinetCareerEndpoints.cs` exposes cross-device resume.
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.Shared/Games/PoCabinetShared.cs`
    2. `src/PoMiniGames.Client/Games/PoCabinet/PoCabinetCareerState.cs`
    3. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetCareerEndpoints.cs`
    4. `tests/PoMiniGames.E2EAPI/Features/PoCabinet/PoCabinetSharedContractTests.cs` (wire-size + enum compatibility)
    5. `tests/PoMiniGames.E2EUI/Features/PoCabinet/PoCabinetCareerFlowTests.cs` (Playwright: championship progress persists across reload)
  - **Acceptance Criteria**: JSON wire size ≤ 2 KB at 8 cars (measured in test); enum string compatibility verified; career state round-trips through localStorage JSON; `ILocalStorageService` resolves in DI; state machine transitions (Capitol → Mar-a-Lago → Press Briefing) gate correctly; trophy + gold livery unlock on final-race win.
  - **Verification**:
    ```powershell
    dotnet test tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj --filter "FullyQualifiedName~PoCabinetShared"
    dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj --filter "FullyQualifiedName~PoCabinetCareer"
    ```

---

- [ ] **Task 5: Track-Partitioned Leaderboards & Persistence**
  - **Description**: Extend `StorageService.cs` with PoCabinet score descriptor (partitioned by TrackId). Add `PoCabinetScoreEndpoints.cs` exposing `/api/pocabinet/scores?track={trackId}` (anonymous reads, authed writes under `pocabinet` rate-limit policy). Demo Elo ladder via `PoCabinetElo` table using `TableConcurrency.UpdateWithRetryAsync` (PoBrawl pattern).
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.Domain/Models/PoCabinetHighScore.cs`
    2. `src/PoMiniGames.Infrastructure/Services/StorageService.cs` (extension)
    3. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetScoreEndpoints.cs`
    4. `tests/PoMiniGames.Integration/Features/PoCabinet/PoCabinetScoreStorageTests.cs` (Azurite round-trip + TrackId partition + ETag-update overwrite)
    5. `tests/PoMiniGames.Integration/Features/PoCabinet/PoCabinetEloIncrementTests.cs` (Elo increments commute under concurrent updates)
  - **Acceptance Criteria**: Scores with TrackId save and retrieve cleanly; missing track defaults to `capitol`; ETag-update on overwrite (better score replaces worse); Elo increments commute under concurrent demo finishes (verified by integration test that races two ETag-updates simultaneously).
  - **Verification**:
    ```powershell
    dotnet test tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj --filter "FullyQualifiedName~PoCabinetScore|FullyQualifiedName~PoCabinetElo"
    ```

---

- [ ] **Task 6: Multiplayer Lobby & SignalR Hubs**
  - **Description**: `PoCabinetLobbyService.cs` (state machine for lobby creation, join, leave), `PoCabinetLobbyHub.cs` (`/pocabinet/lobby-hub`, anonymous `/negotiate`), `PoCabinetRaceHub.cs` (`/pocabinet/race-hub`, 30 Hz deterministic tick), `PoCabinetRaceRegistry.cs` (active races, claim-derived seats). `PoCabinetLobby.razor` UI. Polly retry pipeline in `Program.cs` for transient SignalR failures.
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetLobbyService.cs`
    2. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetLobbyHub.cs`
    3. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetRaceHub.cs`
    4. `src/PoMiniGames.API/Features/PoCabinet/PoCabinetRaceRegistry.cs`
    5. `tests/PoMiniGames.E2EAPI/Features/PoCabinet/PoCabinetLobbyContractTests.cs` (hub negotiate + 8-player race contract; budgeted against E2E-API cap)
  - **Acceptance Criteria**: 8-char join code generation; seat binding to claim-derived identity; up to 8 players per race; lobby times out after 5 min idle; Elo updates under ETag commute; Polly retry only on 5xx + `HttpRequestException`, never on 4xx; lobby UI accepts join code via input field.
  - **Verification**: `dotnet test tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj --filter "FullyQualifiedName~PoCabinetLobby"`

---

- [ ] **Task 7: Native Blazor UI**
  - **Description**: `PoCabinetPage.razor` (main race page with cockpit mount + HUD + race-state binding). `PoCabinetTrackSelector.razor` (3-card track picker with preview, length, difficulty). `PoCabinetPaintShop.razor` (4 liveries × 4 colors, persisted to localStorage). `PoCabinetChampionshipView.razor` (career tracker showing current stage, trophy, gold livery unlock). All native Blazor, semantic CSS tokens, accessibility WCAG AA, no Radzen.
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.Client/Games/PoCabinet/PoCabinetPage.razor`
    2. `src/PoMiniGames.Client/Games/PoCabinet/PoCabinetPage.razor.css`
    3. `src/PoMiniGames.Client/Games/PoCabinet/PoCabinetTrackSelector.razor`
    4. `src/PoMiniGames.Client/Games/PoCabinet/PoCabinetPaintShop.razor`
    5. `src/PoMiniGames.Client/Games/PoCabinet/PoCabinetChampionshipView.razor`
  - **Acceptance Criteria**: All 4 routes (`/pocabinet/1player`, `/pocabinet/2player`, `/pocabinet/multi`, `/pocabinet/demo`) render without console errors; track selector updates preview on hover; paint shop persists selection; championship view reflects career state; full keyboard + touch navigation; accessibility WCAG AA (focus visible, ARIA labels, contrast).
  - **Verification**:
    ```powershell
    dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj --filter "FullyQualifiedName~PoCabinetRoute"
    dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj --filter "FullyQualifiedName~PoCabinetTrack"
    ```

---

- [ ] **Task 8: Verification — Trim Audit, Bundle Check, Ceiling Pass**
  - **Description**: Final verification: run trim audit, measure bundle size, run all four ceiling guards, run targeted PoCabinet unit/integration/E2E tests. No new code, only verification commands and result capture.
  - **File Manifest** (≤ 5 files): none (verification only; this task adds no source files).
  - **Acceptance Criteria**: 0 IL2xxx warnings on `dotnet publish -c Release -p:PublishTrimmed=true`; bundle size < 25 MB; all four ceiling guards pass; PoCabinet targeted tests pass; documented in `tasks/plan.md` checkpoint D evidence section.
  - **Verification**:
    ```powershell
    dotnet publish src/PoMiniGames.Client/PoMiniGamesClient.csproj -c Release -p:PublishTrimmed=true
    dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~PoCabinet"
    dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~TestCountCeilingTests"
    dotnet test tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj --filter "FullyQualifiedName~IntegrationTestCountCeilingTests"
    dotnet test tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj --filter "FullyQualifiedName~E2EApiTestCountCeilingTests"
    dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj --filter "FullyQualifiedName~E2EUiTestCountCeilingTests"
    ```

---

## Standing Test Budget (Re-checked at T8)

If any tier trips its ceiling during a task, **consolidate** per [`CLAUDE.md`](CLAUDE.md) — never raise the cap.

---

## Discipline Notes

- **One commit per task.** Short, casual, American-English subject (e.g., "wires the cockpit RPM gauge to the sim tick"). No emoji. No ticket IDs.
- **Always run** `dotnet build` after a code change; verify the API host still boots cleanly (`GET /health` returns 200).
- **Never run** the full test suite unprompted. Targeted `--filter` only.
- **Restart the API host DETACHED** after a code change (per `/memories/repo/local-dev-notes.md`); `dotnet run` in a chat terminal gets reaped.
- **Update SPEC.md / CAPABILITY-MAP.md** if scope, roster, or success criteria change mid-build.