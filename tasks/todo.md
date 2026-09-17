# Todo Checklist — PoRacer Overhaul (Multi-Track, AI Personalities & Physics)

Each task is a vertical slice touching &le; 5 files. All tasks follow strict TDD: Red &rarr; Green &rarr; Build &rarr; Verify.

---

- [x] **Task 1: Track Registry & Spline Geometry Engine**
  - **Description**: Define mathematical spline representations for the 3 tracks (Circuit, Neon Skyline, Desert Rally), closed Catmull-Rom resampling, wall normal calculations, surface zones (asphalt, sand), and boost pad bounding boxes in `PoRacerTrackData.cs` and `PoRacerTrackRegistry.cs`.
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.API/Features/PoRacer/PoRacerTrackData.cs`
    2. `src/PoMiniGames.API/Features/PoRacer/PoRacerTrackRegistry.cs`
    3. `tests/PoMiniGames.Unit/Features/PoRacer/PoRacerTrackRegistryTests.cs`
  - **Acceptance Criteria**: All 3 tracks form valid closed loops; wall generation produces non-zero length segments; boost pads reside within track corridors.
  - **Verification**: `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~PoRacerTrackRegistryTests"`

---

- [x] **Task 2: Shared Contracts & Wire Protocol Extensions**
  - **Description**: Extend `PoRacerShared.cs` with `TrackKind`, `SurfaceKind`, `PoRacerBoostPad`, car customization livery DTOs, and track theme metadata in `PoRacerStaticWorld`. Update lobby/race hub signatures to accept `TrackKind`.
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.Shared/Games/PoRacerShared.cs`
    2. `src/PoMiniGames.API/Features/PoRacer/PoRacerRaceHub.cs`
    3. `src/PoMiniGames.API/Features/PoRacer/PoRacerRaceService.cs`
    4. `src/PoMiniGames.API/Features/PoRacer/PoRacerRaceRegistry.cs`
    5. `src/PoMiniGames.API/Features/PoRacer/PoRacerSim.cs`
  - **Acceptance Criteria**: Serialization tests pass; race hub instantiates room with designated `TrackKind`; wire payload remains < 2 KB per tick.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [x] **Task 3: Surface Physics, Grip & Boost Pad Simulation Engine**
  - **Description**: Refactor `PoRacerSim.cs` to execute multi-track physics: lookup car surface (asphalt vs sand/dirt), apply surface friction modifiers (1.0x vs 0.68x grip), calculate drift slip angles, and trigger boost pad speed surges (+35% acceleration for 1.8s).
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.API/Features/PoRacer/PoRacerSim.cs`
    2. `tests/PoMiniGames.Unit/Features/PoRacer/PoRacerSimAiTests.cs`
  - **Acceptance Criteria**: Cars experience increased drift and reduced grip on sand surfaces; driving over a boost pad triggers boost timer; car speed is clamped within safety bounds.
  - **Verification**: `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~PoRacer"`

---

- [x] **Task 4: AI Bot Personalities & Driving Heuristics**
  - **Description**: Implement `PoRacerAiDriver.cs` with 7 distinct bot personality profiles (*Apex Predator*, *Draft Hunter*, *Aggressive Bumper*, *Ghost Line*, *Speed Demon*, *Cautious Cruiser*, *Slipstreamer*). Integrate distinct lateral offsets, braking distances, and slipstreaming logic into `PoRacerSim.cs`.
  - **File Manifest** (≤ 5 files):
    1. `src/PoMiniGames.API/Features/PoRacer/PoRacerAiDriver.cs`
    2. `src/PoMiniGames.API/Features/PoRacer/PoRacerSim.cs`
    3. `tests/PoMiniGames.Unit/Features/PoRacer/PoRacerSimAiTests.cs`
  - **Acceptance Criteria**: 7 AI bots show distinct lines and aggression; 100% of bots complete races without getting stuck; marshal rescue engages if progress stalls.
  - **Verification**: `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~PoRacerSimAiTests"`

---

- [x] **Task 5: WebGL Multi-Track Themes, Shaders & Boost Visuals**
  - **Description**: Upgrade `poracerGl.js` to render 3 environmental themes (Grand Prix asphalt & red/white curbs, Neon Skyline glowing cyber barriers & reflective road, Desert Rally dunes & dust storms), animated chevron boost pads, and tire skid/dust particle emitters.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/wwwroot/js/poracerGl.js`
  - **Acceptance Criteria**: Clean theme transitions on track switch; boost pads pulse and glow; tire skids emit track-specific dust/sparks; stable 60 FPS.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [x] **Task 6: Track-Partitioned Leaderboards & Persistence**
  - **Description**: Extend `PoRacerHighScore.cs` and `StorageService.cs` to partition high scores by `TrackId`. Update `PoRacerScoreEndpoints.cs` to filter by `?track={trackId}` and validate input ranges. Update `PoRacerScoreApiClient.cs` on the client.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Domain/Models/PoRacerHighScore.cs`
    2. `src/PoMiniGames.Infrastructure/Services/StorageService.cs`
    3. `src/PoMiniGames.API/Features/PoRacer/PoRacerScoreEndpoints.cs`
    4. `src/PoMiniGames.Client/Games/PoRacer/PoRacerScoreApiClient.cs`
  - **Acceptance Criteria**: Scores submitted with `TrackId` save and retrieve cleanly; missing track defaults to `circuit`; rate-limit cooldown remains intact.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [x] **Task 7: Native Blazor Track Selector & Car Paint Shop**
  - **Description**: Build `PoRacerTrackSelector.razor` (3 track cards with previews, length, difficulty) and `PoRacerPaintShop.razor` (body colors, livery styles, persisted in `localStorage`). Integrate into `PoRacerPage.razor` pre-race flow.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/Games/PoRacer/PoRacerTrackSelector.razor`
    2. `src/PoMiniGames.Client/Games/PoRacer/PoRacerPaintShop.razor`
    3. `src/PoMiniGames.Client/Games/PoRacer/PoRacerPage.razor`
    4. `src/PoMiniGames.Client/Games/PoRacer/PoRacerPage.razor.css`
  - **Acceptance Criteria**: Track and paint selections persist and pass to simulation; fully keyboard/touch accessible; 0 Radzen dependencies.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [x] **Task 8: Audio & Telemetry HUD Integration**
  - **Description**: Connect boost pad activation and sand/dirt surface transitions to procedural audio cues in `gameCues.js` and `PoRacerPage.razor`. Enhance HUD with live boost duration meter, surface grip status badge, and dynamic track minimap.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/Games/PoRacer/PoRacerPage.razor`
    2. `src/PoMiniGames.Client/wwwroot/js/gameCues.js`
    3. `src/PoMiniGames.Client/wwwroot/js/poracerGl.js`
  - **Acceptance Criteria**: Boost and drift SFX trigger accurately; HUD displays active surface and boost charge; minimap reflects active track geometry.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [ ] **Task 9: E2E Verification, Ceiling Compliance & Smoke Test**
  - **Description**: Verify solution builds with 0 warnings, runs targeted PoRacer unit tests, and verifies that all 4 test ceilings (Unit &le; 100, Integration &le; 50, E2E-API &le; 25, E2E-UI &le; 25) remain compliant.
  - **File Manifest** (&le; 5 files):
    1. `tests/PoMiniGames.Unit/Features/PoRacer/PoRacerTrackRegistryTests.cs`
    2. `tests/PoMiniGames.Unit/Features/PoRacer/PoRacerSimAiTests.cs`
    3. `src/PoMiniGames.Client/Games/PoRacer/PoRacerPage.razor`
  - **Acceptance Criteria**: Zero build errors, zero warnings, 100% test pass on touched features, and all ceiling tests pass.
  - **Verification**: `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~PoRacer"` and `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~TestCountCeilingTests"`
