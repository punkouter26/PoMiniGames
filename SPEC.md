# Specification — PoCabinet (Cockpit-View Political Satire Racer)

> Living spec. Update whenever scope, roster, or success criteria change.
> Framework invariants and standing rules live in [`CLAUDE.md`](CLAUDE.md).

---

## 1. Objective

Ship **PoCabinet**, a new cockpit-view arcade racing mini-game inside the PoMiniGames framework, featuring:

1. **Cockpit-View 3D Rendering** via three.js (PoEcosystem precedent) with a full cockpit interior (steering wheel, hood, RPM/speed gauges, rear-view mirror) and 3D track ahead.
2. **Three Themed Tracks**: Capitol Speedway (asphalt, classical government building backdrop), Mar-a-Lago Grand Prix (palm-lined beachside, golf-course greens, ocean mist), Press Briefing 500 (podium-shaped stadium, press-box grandstands, klieg lights).
3. **Four AI Officials** with distinct driving personalities: *Sean S.* (Press Secretary — defensive), *Steve B.* (Chief Strategist — tight inside lines), *Bill B.* (Attorney General — aggressive bumper), *Mike P.* (Vice President — drafting specialist). First-name + last-initial naming; no real likenesses.
4. **Four Game Modes**: `/pocabinet/1player` (linear 3-race career championship), `/pocabinet/2player` (hot-seat, same device), `/pocabinet/multi` (SignalR, up to 8 players), `/pocabinet/demo` (AI showcase with Elo ladder, PoBrawl pattern).
5. **Scripted Dialogue Only**: hand-authored pools per official (~8 pre-race speeches, ~12 mid-race barks, ~6 post-race quips each). No AI generation, no Azure AI Foundry spend.
6. **Server-Authoritative Simulation**: 30 Hz deterministic tick, anti-cheat by replayed-tick reconciliation (PoRacer pattern).
7. **Native Blazor UI** with semantic CSS tokens, no Radzen, accessibility WCAG AA.

---

## 2. User Journeys

### Journey 1: 1P Career Championship
1. Player navigates to `/pocabinet/1player`. The career view shows the championship state (current stage = Capitol Speedway, locked trophy).
2. Player picks a livery in the Paint Shop (4 liveries × 4 colors), persisted to `localStorage`.
3. Player clicks **Start Race**. The server spins up a `PoCabinetSim` for Capitol Speedway with the player + 3 AI officials.
4. Pre-race: 3-2-1-GO countdown; each official delivers a hand-authored pre-race speech.
5. Player drives via keyboard (WASD / arrows) or on-screen mobile touch controls. Cockpit HUD shows speed, RPM, gear, lap count, position, current lap time, best lap, gap to leader.
6. Mid-race: officials deliver position-change barks ("I'm taking the inside line!").
7. Finish: player crosses finish line on Lap 3. Top-3 finish advances to Mar-a-Lago GP. Podium photo displays.
8. After completing all 3 races with a win on the final, the trophy unlocks + gold livery becomes selectable.
9. Score automatically posts to the track-partitioned leaderboard (`/api/pocabinet/scores?track={trackId}`) if signed in.

### Journey 2: 2P Hot-Seat (Same Device)
1. Player navigates to `/pocabinet/2player`. Two players take turns at the keyboard.
2. Player 1 races 3 laps against AI officials; Player 2 races 3 laps against a different AI roster; whoever has the best aggregate time wins.
3. Leaderboard entry under `2player` mode (or a separate `2p` partition) per track.

### Journey 3: Multiplayer Lobby (Up to 8 Players)
1. Player visits `/pocabinet/multi`. Host clicks **Create Lobby** → server returns 8-char join code (e.g., `CAB-7XQ2`).
2. Other players enter the code on their devices and join. Up to 8 seats (claim-derived identity binds seat to connection).
3. Host picks a track (any of the 3). Once all players click Ready, race starts.
4. Snapshots sync at 30 Hz via SignalR `/pocabinet/lobby-hub` + `/pocabinet/race-hub`. Client-side interpolation smooths between ticks.
5. Final standings posted to the multiplayer leaderboard partition.

### Journey 4: Demo AI Showcase with Elo
1. Player visits `/pocabinet/demo`. Picks 2–4 officials and a track.
2. AI races AI in a continuous loop. Cameras orbit smoothly.
3. Each official's Elo updates via increment-on-finish (commutes under concurrency). `PoCabinetElo` table; updated similarly to `PoBrawlFighterRatings`.
4. Player can spectate multiple races; the Elo ladder reorders visibly between runs.

---

## 3. Pinned Tech Stack & Versions

All versions pinned via [`Directory.Packages.props`](Directory.Packages.props) and [`global.json`](global.json). Framework invariants unchanged.

- **Runtime & Framework**: .NET 10 (`net10.0`), C# 13, ASP.NET Core 10.0.10
- **Client**: Blazor WebAssembly .NET 10 (`Microsoft.AspNetCore.Components.WebAssembly` `10.0.10`)
- **3D Graphics**: three.js r165 (Lambert chunk order: `normal_fragment_begin` for normal-dependent code per PoEcosystem debug notes)
- **Real-Time Networking**: ASP.NET Core SignalR 10.0.10 (hubs at `/pocabinet/lobby-hub`, `/pocabinet/race-hub`)
- **Persistence**: Azure Table Storage (`Azure.Data.Tables` `12.11.0`) with Azurite emulator; `localStorage` for career state
- **Testing**: xUnit `2.9.3`, FluentAssertions `8.8.0`, Playwright `1.50.0`, Testcontainers
- **UI & Component Architecture**: Native Blazor only. **No `Radzen.Blazor`** per [`CLAUDE.md`](CLAUDE.md#L113).

---

## 4. Build, Test, Lint, and Run Commands

```powershell
# Build entire solution (must pass with 0 warnings, 0 errors)
dotnet build PoMiniGames.slnx

# Run API + Blazor WASM Client (one host, http://localhost:5080).
# IMPORTANT: start DETACHED (see /memories/repo/local-dev-notes.md); `dotnet run` in
# a chat terminal gets reaped during WASM boot.
Start-Process dotnet -ArgumentList 'run','--project','src/PoMiniGames.API/PoMiniGames.API.csproj' `
  -WorkingDirectory (Get-Location) -WindowStyle Hidden `
  -RedirectStandardOutput logs/api-console.log `
  -RedirectStandardError logs/api-console.err.log -PassThru

# Unit tests for PoCabinet only (targeted, never full suite per CLAUDE.md)
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~PoCabinet"

# Verify ceilings stay green (must pass before AND after PoCabinet adds tests)
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~TestCountCeilingTests"
dotnet test tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj --filter "FullyQualifiedName~IntegrationTestCountCeilingTests"
dotnet test tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj --filter "FullyQualifiedName~E2EApiTestCountCeilingTests"
dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj --filter "FullyQualifiedName~E2EUiTestCountCeilingTests"

# Trim audit (gate for merge; 0 IL2xxx warnings required)
dotnet publish src/PoMiniGames.Client/PoMiniGamesClient.csproj -c Release /p:PublishTrimmed=true
```

---

## 5. Project Structure

```
src/
├── PoMiniGames.Domain/
│   └── Models/
│       └── PoCabinetHighScore.cs                # Score entity with TrackId
├── PoMiniGames.Shared/
│   └── Games/
│       └── PoCabinetShared.cs                   # TrackKind, OfficialKind, DialogueKind, Wire DTOs
├── PoMiniGames.Infrastructure/
│   └── Services/
│       └── StorageService.cs                    # + extension: PoCabinet descriptor + PoCabinetElo ladder
├── PoMiniGames.API/
│   └── Features/
│       └── PoCabinet/
│           ├── PoCabinetTrackData.cs            # Splines, checkpoints, surfaces per track
│           ├── PoCabinetTrackRegistry.cs        # Lookup & procedural wall generation
│           ├── PoCabinetAiDriver.cs             # 4 official driving heuristics
│           ├── PoCabinetSim.cs                  # Server-authoritative physics
│           ├── PoCabinetDialogue.cs             # Scripted dialogue pools (hand-authored)
│           ├── PoCabinetCareerEndpoints.cs      # /api/pocabinet/career (cross-device resume)
│           ├── PoCabinetScoreEndpoints.cs       # /api/pocabinet/scores?track=...
│           ├── PoCabinetLobbyService.cs         # Lobby state machine
│           ├── PoCabinetLobbyHub.cs             # /pocabinet/lobby-hub SignalR hub
│           ├── PoCabinetRaceHub.cs              # /pocabinet/race-hub SignalR hub
│           └── PoCabinetRaceRegistry.cs         # Active race registry (PoRacer pattern)
└── PoMiniGames.Client/
    ├── Games/
    │   └── PoCabinet/
    │       ├── PoCabinetPage.razor              # Main race page (HUD + cockpit mount)
    │       ├── PoCabinetPage.razor.css          # HUD + cockpit overlay styles
    │       ├── PoCabinetTrackSelector.razor     # 3-card track picker
    │       ├── PoCabinetPaintShop.razor          # 4 liveries × 4 colors
    │       ├── PoCabinetChampionshipView.razor  # Career progression tracker
    │       ├── PoCabinetLobby.razor             # Multiplayer lobby UI
    │       └── PoCabinetCareerState.cs          # localStorage-backed career state
    └── wwwroot/
        └── js/
            └── pocabinet/
                ├── scene.js                     # three.js scene base + 3 themed tracks
                ├── cockpit.js                   # 3D cockpit interior (wheel, gauges, mirror)
                ├── cars.js                      # AI car 3D models (procedural, flat-shaded)
                ├── dialogue.js                  # Race-event-driven dialogue overlay
                └── input.js                     # Keyboard/touch intent → server emit
```

---

## 6. Code-Style Snippet & Conventions

```csharp
// Example: Server-authoritative physics tick (PoCabinetSim.cs).
// Mirrors PoRacerSim.cs pattern; PoCabinet adds cockpit-relative camera framing
// but the simulation itself is identical in spirit (deterministic, pooled buffers).
public sealed class PoCabinetSim
{
    public void Tick(IReadOnlyList<PlayerIntent> intents, double dt)
    {
        // 1. Update AI officials via PoCabinetAiDriver heuristics.
        // 2. Apply inputs + physics to player car.
        // 3. Resolve wall collisions, surface friction, lap transitions.
        // 4. Broadcast PoCabinetRaceSnapshot (≤ 2 KB at 8 cars).
    }
}
```

```javascript
// Example: three.js cockpit mount (pocabinet/cockpit.js).
// Lambert chunk ORDER (Poe debug notes): `normal_fragment_begin` runs BEFORE `color_fragment`,
// so any shader injection that needs `normal` must hook `normal_fragment_begin`.
import { scene, camera } from './scene.js';

export function mountCockpit(carHeading) {
    const wheel = new THREE.Mesh(geometry, lambertMat);
    const hood = new THREE.Mesh(geometry, lambertMat);
    // ... mount primitives; return teardown fn for cleanup on race end.
}
```

### Conventions
1. **Strict Nullability**: `<Nullable>enable</Nullable>` enforced. Zero compiler warnings.
2. **Zero Radzen**: native Blazor + CSS design tokens (`--color-surface`, `--color-primary`, etc.).
3. **No per-tick heap allocations**: pooled flat arrays, struct car records, reusable snapshot buffers.
4. **No AI generation**: dialogue is constant C# data; roster art is bundled SVG.
5. **Test method count**: every `[Fact]`/`[Theory]` consumes a slot in the 100-unit ceiling. Parameterize, don't multiply.

---

## 7. Testing Strategy

### Framework
xUnit 2.9.3, FluentAssertions 8.8.0, Playwright 1.50.0.

### Allocation (HARD ceilings per [`CLAUDE.md`](CLAUDE.md))

| Tier | Cap | Current | PoCabinet Target | Strategy |
|------|-----|---------|-------------------|----------|
| Unit | 100 | **100 (AT CAP)** | ~25 | **First step: consolidate ~15 existing tests (parameterize theories)** before adding any new. |
| Integration | 50 | 47 | ~2 | Azurite round-trips for `PoCabinetScores` partitioning + Elo increment. |
| E2E-API | 25 | 19 | ~5 | HTTP contract for score, career, lobby endpoints. |
| E2E-UI | 25 | 17 | ~3 | Playwright: route renders, race starts, lobby accepts code. |

### Unit test surface (target breakdown, after consolidation)
- **Track Registry** (~4 tests): closed-loop continuity per track; wall normal orientation; checkpoint ordering.
- **Physics** (~6 tests): speed clamping; grip degradation; wall collision resolution; lap counting; surface zone transitions.
- **AI Personalities** (~5 tests): each official completes a 3-lap race; steering variance between officials; marshal rescue timer.
- **Dialogue** (~3 tests): pool selection deterministic by seed; pool exhaustion fallback; content scan rejects slurs/hate speech.
- **Wire Protocol** (~3 tests): JSON wire size ≤ 2 KB at 8 cars; enum string compatibility; snapshot immutability.
- **Career State Machine** (~3 tests): state transitions; advance gating; trophy + gold livery unlock.
- **Lobby State Machine** (~1 test): seat binding to claim.

### Coverage target
>90% branch coverage on new track spline math, physics, and endpoint code. Lower on three.js UI (visual audit instead).

### Coverage exceptions
- Three.js scene code: visual audit (browser screenshot per track, no GL state leaks on track switch). No unit-test value.
- Cockpit mount/unmount: integration with scene audit; not unit-tested.

---

## 8. Boundaries (Always / Ask First / Never)

### Always
- Keep all physics server-authoritative in `PoCabinetSim.cs`.
- Test changes with `--filter "FullyQualifiedName~PoCabinet"`; verify the ceiling guard still passes.
- Rebuild and verify the API host boots cleanly (`dotnet build`, `dotnet run`) before finishing.
- Maintain responsive touch + keyboard + gamepad controls (gamepad optional).
- Persist career state to `localStorage` after every race result; resume on next visit.
- Re-arm the antiforgery token after sign-in (per `tests/Shared/AntiforgeryTestExtensions.cs`).
- Apply `TestBudgetGuard.Overrides` in any new test fixture touching the AI boundary (not applicable to PoCabinet — no AI boundary — but the pattern is required for future expansion).

### Ask First
- Adding any new external NuGet or npm dependency (three.js is approved; nothing else).
- Modifying shared database table schemas that impact existing games (e.g., `StorageService`).
- Changing global SignalR hub routing or authentication filters.
- Changing the asset whitelist or rate-limit policy names (`pocabinet`, `pocabinet-lobby`).
- Modifying trim root or publish configuration (`PoMiniGamesClient.csproj`, `TrimmerRoots.xml`).

### Never
- Never add `Radzen.Blazor` or any heavy UI package.
- Never run the full test suite (`scripts/test-all.ps1` or unrestricted `dotnet test`) per [`CLAUDE.md`](CLAUDE.md).
- Never invoke Azure AI Foundry, LLM tokens, or AI image generation from PoCabinet.
- Never exceed the 100/50/25/25 test tier ceilings. Consolidate, never raise.
- Never push to remote without explicit user ask.
- Never fabricate API details (no real AI is in scope; dialogue is hand-authored, not generated).

---

## 9. Out-of-Scope Items (v1)

1. AI-generated commentary, AI-generated dialogue, AI-generated roster art.
2. Custom user-created tracks.
3. Mobile-first controls tuning (desktop browser primary; mobile plays but not optimized).
4. User-created liveries beyond the 4×4 predefined palette.
5. Replay recording (3D replay is its own big project).
6. Voice chat / real-time microphone streaming in multiplayer lobbies.
7. Cross-device career sync beyond the `/api/pocabinet/career` endpoint (deferred; v2 if requested).
8. Power-ups, weapons, banana peels.
9. Soft-body 3D vehicle deformation.
10. New multiplayer-only tracks (all 3 tracks are shared across modes).

---

## 10. Edge Cases & Error States

| Edge Case / Error | Handling Strategy |
|---|---|
| **Player wedges against a complex hairpin** | Marshal rescue timer: if track progress fails to advance for >2.0s, the car is smoothly nudged 5 nodes ahead on the racing line facing forward (PoRacer pattern). |
| **High latency / dropped SignalR packets** | Client-side interpolation: `cockpit.js` smoothly lerps car positions and headings between 30 Hz snapshots. |
| **Three.js shader compile error on a track** | Graceful fallback to a low-poly wireframe placeholder for that track; console warns but the race still completes. |
| **Multiplayer host disconnects mid-race** | All clients return to `/pocabinet/multi` with a "Host disconnected" toast. Lobby entry purged. |
| **`localStorage` quota exceeded / cleared mid-career** | Career state reconstructs from server `/api/pocabinet/career` if signed in; otherwise resets to Track 1 with a one-time toast. |
| **Anti-forgery token mismatch** (open framework bug) | PoCabinet uses the framework `AntiforgeryHandler` path; tests use `AntiforgeryTestExtensions.ArmAntiforgeryAsync`. Workaround for the open bug documented in local-dev-notes; PoCabinet does not fix it (framework bug). |
| **Lobby times out (5 min idle)** | Lobby purged; remaining clients see "Lobby expired" toast and return to `/pocabinet/multi`. |
| **Trim analyzer flags IL2xxx** | Fix at the source (use shared `BufferGeometry`, source-generated serialization metadata). Add to `TrimmerRoots.xml` ONLY as a last resort, with a comment explaining why the warning is unavoidable. |
| **Bundle exceeds 25 MB** | Stop and reassess: split cockpit into a deferred-loaded WASM module, or remove a non-essential 3D asset. |
| **AI bot personality produces identical lap times to another** | Update steering variance threshold in `PoCabinetAiPersonalityTests` to ≥ X° average heading delta; if failing, adjust personality parameters. |

---

## 11. Success Criteria (Numbered, Measurable)

Each criterion is verified by a concrete command or visual artifact.

1. **`dotnet build PoMiniGames.slnx` passes with 0 warnings, 0 errors.**
2. **All 4 routes render without console errors**: `/pocabinet/1player`, `/pocabinet/2player`, `/pocabinet/multi`, `/pocabinet/demo`.
3. **4 AI officials race distinctively**: snapshot inspection confirms each official produces ≥ 5° average heading delta vs others over a 3-lap race.
4. **Career championship completes**: full 3-race flow, top-3 advance gate, trophy + gold livery unlock on final-race win.
5. **Demo Elo increments correctly under ETag**: two concurrent demo finishes commute (their increments compose, neither clobbers the other). Verified by integration test.
6. **Multiplayer lobby supports 8 players**: 8 concurrent SignalR connections on `/pocabinet/lobby-hub`, all see race state within 1 tick (≤ 33 ms at 30 Hz).
7. **Unit tier stays ≤ 100**: ceiling guard test passes after every task.
8. **Trim audit passes**: `dotnet publish -c Release -p:PublishTrimmed=true` produces 0 IL2xxx warnings.
9. **Bundle stays under 25 MB**: `_framework/` output size measured and logged.
10. **Cockpit HUD reads correctly**: speed, RPM, gear, lap count, position, current lap time, best lap, gap to leader all update at 30 Hz.
11. **Scripted dialogue plays at correct race events**: pre-race speech at countdown end; mid-race bark on position change; post-race quip on finish. Verified by event log in dev mode.
12. **No AI token spend**: zero calls to Azure AI Foundry from any PoCabinet endpoint. Verified by Application Insights trace review (or console log review in dev).

---

## 12. Open Questions

These are deferred decisions; address before or during the relevant task in `tasks/todo.md`.

1. **Cross-device career sync**: `/api/pocabinet/career` is scoped in §6 but is it ship-blocking or nice-to-have for v1? Default: ship-blocking for signed-in users only; guests are local-only.
2. **2P mode partition**: separate `2player` leaderboard partition, or merged with `1player`? Default: separate `mode=2player` row key suffix.
3. **Dialogue content approval**: who reviews the 104 hand-authored lines (4 officials × 26 lines)? Spec assumes light-touch review for slurs/hate-speech per content policy; deep satirical review is the user's call.
4. **Demo Elo visibility**: should the Elo ladder be visible to players (like PoBrawl's presidents ladder) or hidden? Default: visible on the demo screen.
5. **Camera shake on collision**: PoRacer has none (per the WIP notes — cockpit effects were stripped). Add it for PoCabinet cockpit feel? Default: add a subtle 0.15s screen-shake, gated by user preference (off by default for accessibility).
6. **Should PoCabinet participate in the unified leaderboard** (`/api/leaderboards/pocabinet`)? Default: yes, alongside the per-track leaderboards.
7. **Gamepad support**: included in scope? Default: not in v1 (keyboard + touch only); out-of-scope per §9.