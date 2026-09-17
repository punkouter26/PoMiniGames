# Specification — PoRacer Overhaul (Multi-Track, AI Personalities & Physics)

## 1. Objective

Overhaul the existing **PoRacer** 3D WebGL racing mini-game inside `PoMiniGames` into a feature-rich, high-performance arcade racer featuring:
1. **Three Distinct Tracks**: Asphalt Grand Prix (Circuit), Neon Skyline (Night Cyber City), and Desert Rally (Dust & Dunes), each with unique splines, visual environments, surface friction characteristics, and boost pads.
2. **Surface Physics & Boost Mechanics**: Dynamic surface grip calculations (Tarmac 1.0x, Sand/Dirt 0.7x with increased slip angle) and turbo boost pad triggers (+35% acceleration burst with visual glow and SFX).
3. **Seven Named AI Bot Personalities**: A full 8-car racing grid powered by CLR heuristics with distinct driver traits (aggression, braking points, slipstream exploitation, and cornering lines).
4. **Visual Vehicle Customization**: Player paint color selection and livery styling persisted in browser storage and rendered in 3D.
5. **Track-Partitioned Leaderboards**: Dedicated Azure Table Storage records and REST endpoints per track, maintaining accurate best lap and overall race times.
6. **Native Blazor UI**: Responsive track selection modal, paint customizer, enhanced HUD telemetry (boost gauge, surface indicator, minimap), and tabbed leaderboards—built without external component libraries (`No Radzen.Blazor`) to preserve the ~1.2 MB WASM bundle budget constraint ([`CLAUDE.md#L113`](CLAUDE.md#L113)).

---

## 2. User Journeys

### Journey 1: Solo 1P Race & Track Selection
1. **Entering PoRacer**: The player navigates to `/poracer` or `/poracer/1player`. The pre-race setup overlay presents track selection cards (Circuit, Neon Skyline, Desert Rally) with track difficulty, length, and preview graphics.
2. **Car Paint Customization**: The player chooses their car's primary body color and livery accent. The selection updates live in a preview badge and saves to `localStorage`.
3. **Starting the Grid**: The player clicks "Start Race". The server spins up a server-authoritative `PoRacerSim` for the chosen track, populating the remaining 7 grid slots with unique AI bot personalities.
4. **The Race**: Synchronized 3-2-1-GO countdown fires. The player steers using Arrow keys, WASD, or on-screen mobile touch controls. Driving over boost pads triggers a speed surge with particle trails and audio cue. Cornering onto dirt/sand reduces traction, demanding counter-steering drifts.
5. **Finish & Podium**: Crossing the finish line on Lap 3 triggers race summary stats (total time, best lap, final placement). If signed in or guest, the score automatically posts to the track's dedicated leaderboard.

### Journey 2: Competitive Time Trial & Track Leaderboards
1. **Leaderboard Inspection**: Player views the High Scores tab on the game shell or post-race dialog, filtering by track (Circuit, Neon Skyline, Desert Rally).
2. **Chasing the Record**: Player enters a solo race specifically aiming to beat the fastest lap record.
3. **Ghost / Lap Delta HUD**: The HUD displays live delta times against their personal best lap for the selected track.

### Journey 3: Autonomous Exhibition Demo Mode
1. **Entering Demo**: Player visits `/poracer/demo` or Kiosk mode rotates to PoRacer.
2. **AI Championship Exhibition**: The simulation automatically selects a track, populates an 8-bot CPU race showcasing the distinct driving personalities, and cameras orbit smoothly.
3. **Seamless Transition**: Upon race finish, the Kiosk coordinator immediately rotates to the next showcase or next track.

---

## 3. Pinned Tech Stack & Versions

- **Runtime & Framework**: .NET 10 (`net10.0`), C# 13, ASP.NET Core 10.0.10
- **Client**: Blazor WebAssembly .NET 10 (`Microsoft.AspNetCore.Components.WebAssembly` `10.0.10`)
- **Central Package Management**: Central package management via `Directory.Packages.props`
- **3D Graphics & Physics**: Custom WebGL2 shader pipeline (`poracerGl.js`, `racingInterop.js`), server-side CLR physics (`PoRacerSim.cs`)
- **Real-Time Networking**: ASP.NET Core SignalR 10.0.10 (`/poracer/race-hub`, `/poracer/lobby-hub`)
- **Persistence**: Azure Table Storage (`Azure.Data.Tables` `12.11.0`) with Azurite emulator + browser `localStorage`
- **Testing**: xUnit `2.9.3`, FluentAssertions `8.8.0`, Playwright `1.50.0`
- **UI & Component Architecture**: Native Blazor (`<Virtualize>`, CSS design tokens in `wwwroot/css/app.css` and `PoRacerPage.razor.css`). **No `Radzen.Blazor`** per `CLAUDE.md#L113`.
- **Audio**: Web Audio API procedural synthesis (`gameCues.js`)

---

## 4. Build, Test, Lint, and Run Commands

```powershell
# Build entire solution (must pass with 0 warnings and 0 errors)
dotnet build PoMiniGames.slnx

# Run API Host and Blazor WASM Client (listens on http://localhost:5080)
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj

# Run Unit tests for PoRacer only (never run full suite without explicit user request per CLAUDE.md#L111)
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~PoRacer"

# Verify solution test tier ceilings (Unit <= 100, Integration <= 50, E2E-API <= 25, E2E-UI <= 25)
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~TestCountCeilingTests"
dotnet test tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj --filter "FullyQualifiedName~IntegrationTestCountCeilingTests"
dotnet test tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj --filter "FullyQualifiedName~E2EApiTestCountCeilingTests"
dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj --filter "FullyQualifiedName~E2EUiTestCountCeilingTests"
```

---

## 5. Project Structure

```
src/
├── PoMiniGames.Domain/
│   └── Models/
│       └── PoRacerHighScore.cs                 # Score entity extended with TrackId
├── PoMiniGames.Shared/
│   └── Games/
│       └── PoRacerShared.cs                    # TrackKind, SurfaceKind, BoostPad, Wire DTOs
├── PoMiniGames.Infrastructure/
│   └── Services/
│       └── StorageService.cs                   # Azure Table Storage queries filtered by TrackId
├── PoMiniGames.API/
│   └── Features/
│       └── PoRacer/
│           ├── PoRacerTrackData.cs             # Splines, checkpoints, boost pads, surfaces
│           ├── PoRacerTrackRegistry.cs         # Track lookup & procedural wall/mesh generation
│           ├── PoRacerAiDriver.cs              # 7 bot driver personalities & heuristics
│           ├── PoRacerSim.cs                   # Server-authoritative multi-track physics engine
│           ├── PoRacerRaceHub.cs               # SignalR hub accepting trackId on room creation
│           └── PoRacerScoreEndpoints.cs        # REST /poracer/scores?track={trackId}
└── PoMiniGames.Client/
    ├── Games/
    │   └── PoRacer/
    │       ├── PoRacerPage.razor               # Core race page & HUD telemetry
    │       ├── PoRacerPage.razor.css           # HUD, minimap, track selector styles
    │       ├── PoRacerTrackSelector.razor      # Track selection modal component
    │       ├── PoRacerPaintShop.razor          # Car livery & color customization modal
    │       └── PoRacerScoreApiClient.cs        # Client HTTP client supporting track queries
    └── wwwroot/
        └── js/
            ├── poracerGl.js                    # WebGL multi-track themes, shaders, particles
            └── gameCues.js                     # Audio cues (rev, drift, boost, crash)
```

---

## 6. Code-Style Snippet & Conventions

```csharp
// Example: Server-authoritative surface evaluation in PoRacerSim.cs
public sealed class PoRacerSim
{
    public void ApplySurfacePhysics(SimCar car, double dt)
    {
        var surface = GetSurfaceAt(car.Pos);
        double gripMultiplier = surface switch
        {
            SurfaceKind.Sand => 0.68,
            SurfaceKind.OffRoad => 0.55,
            SurfaceKind.Curbs => 0.90,
            _ => 1.00 // Standard Asphalt
        };

        // Degrade lateral grip and accelerate drift angle on loose surfaces
        car.EffectiveGrip = car.Handling * gripMultiplier;
        if (car.BoostTimer > 0)
        {
            car.BoostTimer -= dt;
            car.AccelerationModifier = 1.35;
        }
        else
        {
            car.AccelerationModifier = 1.00;
        }
    }
}
```

### Conventions
1. **Strict Nullability**: `<Nullable>enable</Nullable>` enforced across all projects. Zero compiler warnings.
2. **Zero Radzen**: Use native Blazor markup with semantic CSS tokens (`--color-surface`, `--color-primary`, `--radius-md`).
3. **Memory & Allocations**: The 20 Hz simulation tick uses pooled flat arrays and avoids per-tick heap allocations (`Vec2` struct, reusable snapshot buffers).
4. **Contract Annotations**: All bug fixes or architectural decisions are annotated with concise rationale.

---

## 7. Testing Strategy

- **Test Framework**: xUnit 2.9.3, FluentAssertions 8.8.0.
- **Unit Tests (`PoMiniGames.Unit`)**:
  - `PoRacerTrackRegistryTests`: Validate that all 3 tracks form valid closed loops, have consistent wall normal orientations, and contain valid boost pads.
  - `PoRacerPhysicsTests`: Verify that driving on sand reduces lateral grip, boost pads grant acceleration bursts, and car speeds never exceed safe clamping limits.
  - `PoRacerAiPersonalityTests`: Verify that all 7 bot drivers navigate tracks without stalling and that marshal rescue activates if stuck.
  - `PoRacerScoreEndpointTests`: Verify track query validation, rate limiting, and table row formatting.
- **Test Ceilings**:
  - Unit test additions must strictly respect the solution-wide ceiling of **≤ 100 unit tests** (currently ~65 tests; budget allows +10 targeted PoRacer tests).
  - Integration ceiling: **≤ 50 tests**.
- **Coverage Target**: >90% branch coverage on new math, physics, and endpoint code.

---

## 8. Boundaries (Always / Ask First / Never)

### Always
- Keep all physics calculations server-authoritative in CLR code.
- Test changes with targeted unit tests (`--filter "FullyQualifiedName~PoRacer"`).
- Rebuild and verify API host boots cleanly (`dotnet build`, `dotnet run`) before finishing.
- Maintain responsive touch and keyboard controls.

### Ask First
- Adding any new external NuGet or npm dependency.
- Modifying shared database table schemas that impact existing games.
- Changing global SignalR hub routing or authentication filters.

### Never
- Never add `Radzen.Blazor` or heavy UI packages.
- Never run the full test suite (`scripts/test-all.ps1` or unrestricted `dotnet test`) per [`CLAUDE.md#L111`](CLAUDE.md#L111).
- Never introduce Azure AI Foundry or LLM token spend into the racing loop.
- Never exceed the 100/50/25/25 test tier ceilings.

---

## 9. Out-of-Scope Items

1. Mario Kart-style weapon power-ups (missiles, banana peels, shields).
2. Complex 3D vehicle deformation or soft-body mesh physics.
3. User track editor or custom UGC track builder.
4. Voice chat or real-time microphone streaming in multiplayer lobbies.
5. External generative AI race commentary.

---

## 10. Edge Cases & Error States

| Edge Case / Error | Handling Strategy |
|---|---|
| **Bot wedges against complex hairpin wall** | Marshal rescue timer: if track progress fails to advance for >2.0s, the bot is smoothly nudged 5 nodes ahead on the racing line facing forward. |
| **High latency / dropped SignalR packets** | Client-side interpolation: `poracerGl.js` smoothly lerps car positions and headings between received 20 Hz snapshots. |
| **Simultaneous multi-car finish** | Sub-millisecond finish timestamps computed by `Stopwatch` tick offset to resolve exact placement order without ties. |
| **Guest player submits without auth cookie** | Accepted with `IsGuest = true` flag; leaderboard records guest name with sanitized string and rate-limit cooldown. |
| **Invalid trackId query parameter in API** | REST API defaults to `circuit` with a 200 OK or returns 400 Bad Request with supported track list. |
| **Canvas aspect ratio on ultra-wide / mobile portrait** | Viewport resize handler recalculates projection matrix, locking field of view and preventing distortion. |

---

## 11. Numbered Measurable Success Criteria

1. **3 Playable Tracks**: `circuit`, `neonskyline`, and `desertdustway` each load with valid splines, walls, unique visual themes, and boost pads.
2. **Dynamic Physics & Boost**: Sand/dirt surfaces measurably reduce grip (drift angle > 25° at speed); boost pads trigger a +35% acceleration surge and boost glow for 1.8 seconds.
3. **7 Distinct AI Bot Personalities**: Solo races run with 8 cars (1 player + 7 bots), with bots displaying distinct driving lines, overtaking behavior, and 100% race completion rate without perma-stucks.
4. **Visual Customization**: Player can select from at least 6 car primary colors and 3 livery styles, persisting across browser page reloads.
5. **Track-Specific Leaderboards**: REST `/poracer/scores?track=circuit`, `?track=neonskyline`, and `?track=desertdustway` independently record and return top scores.
6. **Zero Performance & Bundle Regressions**:
   - WebGL render loop maintains stable 60 FPS on standard hardware.
   - WASM bundle size does not exceed the ~1.2 MB limit.
7. **Test Ceiling & Build Integrity**:
   - `dotnet build PoMiniGames.slnx` compiles with **0 warnings and 0 errors**.
   - PoRacer unit tests pass 100%.
   - Total solution unit tests remain strictly **≤ 100**.

---

## 12. Open Questions

*(All initial interview clarifications resolved during Phase 0. No blocking open questions remain.)*
