# Specification — PoEcosystem Civilization & Multi-Tribe Evolution

## 1. Objective

Expand the existing **PoEcosystem** simulation inside `PoMiniGames` into an autonomous **Multi-Tribe Civilization & Ecosystem Evolution** experience. 

The player participates strictly as an **overhead god-view observer**, watching multiple rival human tribes organically develop on a 3D procedural island. Tribes independently expand territory, research technologies through an evolutionary tech ladder, construct specialized settlement buildings, manage resource stockpiles, engage in diplomatic relations (peace, trade, rivalry, war), and interact with the natural flora and fauna.

All observer telemetry is exposed through a comprehensive **Native Blazor Analytics Dashboard** featuring real-time population charts, tribal comparison grids, historical event timelines, and island resource gauges—crafted without heavy third-party UI packages to strictly uphold the repository's ~1.2 MB WASM bundle budget constraint ([`CLAUDE.md#L113`](CLAUDE.md#L113)).

---

## 2. User Journeys

### Journey 1: The Overhead Island Observer
1. **Entering the Island**: The player navigates to `/poecosystem` (or `/poecosystem/1player`). The WebGL2 engine mounts, generating a procedural island with biomes (coastal, forest, plains, volcanic peaks), flora (trees, berry bushes), fauna (rabbits, wolves), and multiple initial tribal settlements.
2. **God-View Camera Steering**: The player freely orbits, pans, and zooms above the terrain.
3. **Smart Director Presets**: Using camera quick-actions on the HUD, the player switches between:
   - *Island Overview*: Frames the entire island at high altitude.
   - *Focus Tribe*: Smoothly slerps the camera to focus on a specific tribe's settlement and chieftain.
   - *Active Conflict*: Automatically tracks active raids or skirmishes between rival tribes.
   - *Milestone Focus*: Smoothly zooms to active construction or major tech discovery sites.

### Journey 2: Tribal Evolution & Territorial Warfare
1. **Settlement Founding & Gathering**: Autonomous human tribes establish base camps around natural totems. Tribe members harvest trees for lumber, gather berry bushes for sustenance, and quarry rocks.
2. **Construction**: As resource thresholds are met, tribes construct functional structures:
   - *Thatch Huts*: Expand housing capacity and population ceiling.
   - *Granaries*: Protect food stores against winter/spoilage.
   - *Watchtowers*: Increase territory vision and provide defensive advantage against predators and enemy raiders.
   - *War Totems*: Unlock weapon crafting and martial training.
3. **Technology Breakthroughs**: As elders accrue collective experience, tribes advance through a 4-tier tech ladder (Primitive &rarr; Toolcraft &rarr; Agrarian &rarr; Fortification).
4. **Diplomatic Friction & War**: When territory borders overlap or resources become scarce, inter-tribe friction sparks skirmishes. Combat ensues with procedural retreat thresholds and casualty morale checks. When exhaustion or peace conditions are reached, treaties are signed.

### Journey 3: Deep Analytics & Chronicle Inspection
1. **Opening the Analytics Dashboard**: The player toggles the bottom/side Analytics Dashboard overlay.
2. **Real-Time Population & Resource Trends**: Interactive SVG area/line charts display species counts (rabbits, wolves, humans) and individual tribal populations over world years.
3. **Tribe Comparison Grid**: A structured native Blazor data table ranks tribes by population, tech tier, territorial footprint, food stores, and military strength.
4. **Historical Chronicle Timeline**: A chronological feed records monumental milestones ("Year 4, Day 82: Amber Tribe discovered Agrarian Cultivation", "Year 7, Day 14: Cobalt Tribe declared war on Verdant Tribe").
5. **Entity & Building Inspector**: Clicking any creature or settlement building opens an inspector panel showing status, inventory, lineage, drives, and current goals.

---

## 3. Pinned Tech Stack & Versions

- **Runtime & Framework**: .NET 10 (`net10.0`), C# 13, ASP.NET Core 10.0.10
- **Client**: Blazor WebAssembly .NET 10 (`Microsoft.AspNetCore.Components.WebAssembly` `10.0.10`)
- **Central Package Management**: Central package management via `Directory.Packages.props`
- **3D Graphics & Physics**: Three.js (WebGL2, instanced meshes), `cannon-es` rigid-body physics
- **Simulation Worker**: Pure vanilla ECMAScript Web Worker (zero DOM dependencies)
- **Local Persistence**: Browser `IndexedDB` (world state snapshots) + `localStorage` (user preferences)
- **Cloud Persistence**: Azure Table Storage (`Azure.Data.Tables` `12.11.0`) with Azurite emulator
- **Testing**: xUnit `2.9.3`, FluentAssertions `8.8.0`, Playwright `1.50.0`, Vitest (sim JS hermetic tests)
- **UI & Component Architecture**: Native Blazor (`<Virtualize>`, SVG charts, CSS design tokens in `wwwroot/css/app.css` and `poecosystem.css`). **No `Radzen.Blazor`** per `CLAUDE.md#L113`.

---

## 4. Build, Test, Lint, and Run Commands

```powershell
# Build entire solution (must pass with 0 warnings and 0 errors)
dotnet build PoMiniGames.slnx

# Run API Host and Blazor WASM Client (listens on http://localhost:5080)
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj

# Run Unit tests
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj

# Verify all 4 solution test tier ceilings (100/50/25/25 rule)
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~TestCountCeilingTests"
dotnet test tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj --filter "FullyQualifiedName~IntegrationTestCountCeilingTests"
dotnet test tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj --filter "FullyQualifiedName~E2EApiTestCountCeilingTests"
dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj --filter "FullyQualifiedName~E2EUiTestCountCeilingTests"

# Targeted feature unit tests
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~PoEcosystem"
```

---

## 5. Project Structure

```
src/
├── PoMiniGames.Domain/
│   └── Models/                        # Core records and primitives
├── PoMiniGames.Shared/
│   └── Games/
│       └── PoEcosystemShared.cs       # DTOs, Enums (TribeDiplomacy, TechTier, BuildingKind)
├── PoMiniGames.API/
│   └── Features/
│       └── PoEcosystem/
│           ├── EcosystemEndpoints.cs  # REST /api/ecosystem routes (cloud saves, chronicle)
│           ├── EcosystemWorldStore.cs # Azure Table Storage persistence
│           └── EcosystemChronicleService.cs # Milestone narrative relay
└── PoMiniGames.Client/
    ├── Games/
    │   └── PoEcosystem/
    │       ├── PoEcosystemPage.razor           # Main route container (/{game}/{mode})
    │       ├── PoEcosystemViewer.razor         # Canvas, camera director, WebGL interop
    │       ├── PoEcosystemViewer.razor.cs      # Interop lifecycle, key handling
    │       ├── Components/
    │       │   ├── DashboardOverlay.razor      # Collapsible analytics HUD overlay
    │       │   ├── TribeComparisonGrid.razor   # Native Blazor virtualized tribe comparison
    │       │   ├── PopulationChart.razor       # High-performance SVG population & resource trends
    │       │   ├── ChronicleTimeline.razor     # Chronological historical feed
    │       │   ├── ResourceGauges.razor        # Island biomass & ambient stats
    │       │   ├── TribePanel.razor            # Detailed single-tribe dossier
    │       │   └── CloudPanel.razor            # Cloud save/load management
    │       └── Services/
    │           ├── PoEcosystemApiClient.cs     # HTTP client for API saves & chronicle
    │           └── Interop/
    │               └── PoEcosystemInteropService.cs # JS <-> Blazor communication bridge
    └── wwwroot/
        ├── css/
        │   └── poecosystem.css                 # Token-compliant responsive layout styling
        └── js/
            └── poecosystem/
                ├── index.js                    # Entry point & engine bootstrap
                ├── sim/
                │   ├── core/                   # Clock, PRNG streams, entity store
                │   ├── terrain/                # Heightfield, biomes, pathing
                │   ├── flora/                  # Trees, bushes, grass
                │   ├── creatures/              # Species, drives, genetics, lifecycle
                │   ├── behavior/               # Utility AI, steering, combat
                │   ├── tribe/                  # Multi-tribe engine
                │   │   ├── contracts.js        # Schemas, tiers, diplomatic states
                │   │   ├── tribeStore.js       # Tribe registry & state management
                │   │   ├── territory.js        # Voronoi/radius borders & claim zones
                │   │   ├── techLadder.js       # 4-tier technology progression
                │   │   ├── construction.js     # Building lifecycle & site selection
                │   │   ├── diplomacy.js        # Inter-tribe relations & war state machine
                │   │   └── chronicle.js        # Milestone event generator
                │   └── persistence/            # IndexedDB codec (v2) & autosave
                └── render/
                    ├── camera.js               # Overhead orbit/pan/zoom god-camera
                    ├── director.js             # Smart focus presets & tracking
                    ├── settlementMesh.js       # Procedural 3D structures (huts, granaries, totems)
                    └── creatureMeshes.js       # Tribal color accents & banners
```

---

## 6. Code Style & Architectural Conventions

- **C# / Blazor**:
  - Nullable reference types enabled (`<Nullable>enable</Nullable>`).
  - File-scoped namespaces (`namespace PoMiniGames.Client.Games.PoEcosystem;`).
  - Primary constructors on records and dependency-injected services.
  - Razor markup uses semantic HTML; no hardcoded hex colors; all styling uses CSS custom properties defined in `app.css` (e.g., `var(--color-surface)`, `var(--color-primary)`).
  - `style="..."` attributes are restricted strictly to dynamic runtime values passed to CSS custom properties (`style="--progress: @Percentage%"`).
- **JavaScript**:
  - ES2022 standard, strict mode (`'use strict';`), modular imports/exports.
  - Pure functions and immutable updates within the simulation tick loop; zero allocation in tight hot loops where feasible.
  - Pure JS simulation runs in Web Worker without DOM or window dependencies.

---

## 7. Testing Strategy

| Level | Framework | Scope | Pass Criteria |
|---|---|---|---|
| **JS Sim Tests** | Vitest / Node | `sim/tribe/**` (territory, tech tree, construction, diplomacy) | 100% deterministic logic; state transitions match test invariants. |
| **Unit (C#)** | xUnit, FluentAssertions | `PoMiniGames.Unit/Features/PoEcosystem/` (Chronicle, DTOs, score rules) | All tests pass; tier count remains strictly **&le; 100 methods**. |
| **Integration (C#)** | xUnit, Testcontainers Azurite | `PoMiniGames.Integration` (Cloud save/load endpoints) | Storage persistence verified; tier count remains strictly **&le; 50 methods**. |
| **E2E-UI** | Playwright | `PoMiniGames.E2EUI/PoEcosystemUiTests.cs` | Browser smoke test verifies multi-tribe rendering and dashboard metrics; tier count strictly **&le; 25 methods**. |
| **Build & Trim** | `dotnet build` | Entire solution | Zero warnings (`TreatWarningsAsErrors=true`), trim analysis clean. |

---

## 8. Boundaries

- **Always**:
  - Preserve solution-wide test tier ceilings (Unit &le; 100, Integration &le; 50, E2E-API &le; 25, E2E-UI &le; 25).
  - Run filtered tests during development (`--filter "FullyQualifiedName~<Feature>"`), never the full 13-minute suite.
  - Use native Blazor and semantic CSS tokens for all UI; maintain bundle economy.
  - Maintain backward compatibility for existing IndexedDB/cloud saves where possible.
- **Ask First**:
  - Introducing new external NuGet or npm dependencies.
  - Altering routes or global layout chrome (`MainLayout.razor`).
- **Never**:
  - Introduce `Radzen.Blazor` or any external heavy UI component library (`CLAUDE.md#L113`).
  - Add direct player RTS micro-control (creatures must remain 100% autonomous).
  - Allow uncapped token generation or blocking network calls in the simulation tick loop.
  - Push to git remotes without explicit `git sync` command.

---

## 9. Out-of-Scope (v2 Expansion)

- Direct RTS player control (drag-selecting units, point-and-click move/attack commands).
- Complex skeletal animations or external rigged 3D models (retaining stylized procedural Three.js meshes).
- Live SignalR multiplayer matchmaking rooms for the ecosystem.
- Deep genetic phenotype morphology rendering (color and scale mutations only).

---

## 10. Edge Cases & Error Handling

| Edge Case | Expected System Behavior |
|---|---|
| **Island Overcrowding** | When population reaches island carrying capacity (400 entities), birth rates scale down logarithmically; hunger drive increases; tribes prioritize emigration or raiding over reproduction. |
| **Complete Tribal Extinction** | If a tribe's population hits zero, remaining buildings decay over 60 seconds into ruins; territory dissolves back into neutral wilderness; chronicle logs the fall of the tribe. |
| **Snapshot Version Mismatch** | When loading a legacy v1 snapshot lacking multi-tribe data, the migration codec synthesizes initial tribal alignments and default technology states without crashing. |
| **Storage API Unreachable** | Cloud save/load operations degrade gracefully with a non-blocking toast warning; local IndexedDB autosaves continue uninterrupted. |
| **Tab Minimization / Inactive State** | Simulation clock pauses while document is hidden (`visibilitychange`), preserving world state and battery without accumulating a giant physics catch-up spike. |

---

## 11. Numbered Measurable Success Criteria

1. **Clean Solution Build**: `dotnet build PoMiniGames.slnx` succeeds with **0 Warnings** and **0 Errors**.
2. **Ceiling Compliance**: All 4 solution test tiers remain strictly below their ceilings (Unit &le; 100, Integration &le; 50, E2E-API &le; 25, E2E-UI &le; 25).
3. **Multi-Tribe Spawning**: A fresh simulation run initializes at least 3 distinct human tribes with unique banners, territories, and starting chieftains.
4. **Autonomous Territory & Construction**: Within 3 minutes of simulation time (at 1x speed), at least one tribe successfully gathers materials and completes a functional building (Hut, Granary, or Totem).
5. **Tech Ladder Progression**: Tribes accumulate research points and unlock Tier 2 technology (Toolcraft) deterministically based on elder ratio and gathering efficiency.
6. **Diplomatic State Transitions**: Tribes transition between diplomatic postures (Neutral &rarr; Skirmish/War &rarr; Peace) driven by border friction and resource availability.
7. **Overhead God-Camera Smooth Tracking**: All 4 camera presets (Island Overview, Focus Tribe, Active Conflict, Milestone Focus) transition smoothly with zero camera jumps.
8. **Native Blazor Dashboard Interactivity**: Opening the Analytics Dashboard renders real-time SVG population graphs, the tribal comparison grid, and the chronological event feed without dropping frame rate below 30 FPS on mid-tier hardware.
9. **Persistence Determinism**: An exported world snapshot containing active multi-tribe structures and diplomacy matrices restores identically in IndexedDB with zero state corruption.
10. **Zero Radzen Footprint**: Bundle audit verifies zero references to `Radzen.Blazor`, maintaining the lightweight WASM delivery profile.

---

## 12. Open Questions

*(None — All core requirements, user journeys, interaction paradigms, and UI contracts were confirmed during the Phase 0 interview).*

