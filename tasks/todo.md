# Todo Checklist — PoEcosystem Civilization & Multi-Tribe Evolution

Each task is a vertical slice touching &le; 5 files. All tasks follow strict TDD: Red &rarr; Green &rarr; Build &rarr; Verify.

---

- [x] **Task 1: Multi-Tribe Data Contracts & Enums (with Source Generators)**
  - **Description**: Define tribal identity schemas, diplomacy enums (`Neutral`, `Allied`, `Rival`, `War`), tech tier constants, building definitions, and `System.Text.Json` source generation contexts across C# and JS.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Shared/Games/PoEcosystemShared.cs`
    2. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/tribe/contracts.js`
    3. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js`
    4. `tests/PoMiniGames.Unit/Features/PoEcosystem/EcosystemChronicleServiceTests.cs`
  - **Acceptance Criteria**: DTOs and contracts compile with 0 warnings; default tribe configurations (Amber, Cobalt, Verdant) instantiate with distinct color palettes and banners.
  - **Verification**: `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~PoEcosystem"`

---

- [ ] **Task 2: Territory Boundaries & Resource Claim Zones (with KD-Tree Spatial Indexing)**
  - **Description**: Implement dynamic tribal borders, influence mapping from settlement centers, totem anchors, and resource node claiming using `Supercluster.KDTree` for O(log N) proximity queries.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/tribe/territory.js`
    2. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/tribe/tribeStore.js`
    3. `src/PoMiniGames.Client/Games/PoEcosystem/Services/TribalSpatialIndex.cs`
    4. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js`
  - **Acceptance Criteria**: KDTree indexes resource nodes and settlement centers; tribes establish distinct boundary hulls; resource claims prevent cross-tribe poaching unless at war.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [ ] **Task 3: 4-Tier Tech Ladder Progression**
  - **Description**: Implement tech research points accumulation driven by tribe elders and population density, unlocking 4 progressive technology eras.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/tribe/techLadder.js`
    2. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/tribe/tribeStore.js`
    3. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/behavior/humans.js`
  - **Acceptance Criteria**: Research points accumulate monotonically; tier prerequisites are strictly enforced; toolcraft unlocks accelerated gathering multipliers.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [ ] **Task 4: Settlement Construction & Building Lifecycles**
  - **Description**: Autonomous construction system allowing humans to deposit wood/stone at designated building sites to construct Huts, Granaries, Watchtowers, and Totems.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/tribe/construction.js`
    2. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/behavior/humans.js`
    3. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js`
  - **Acceptance Criteria**: Site selection avoids water and steep slopes; construction progresses with material drops; completed huts increase tribal housing capacity.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [ ] **Task 5: Inter-Tribe Diplomacy & Skirmish Combat (with Stateless Machine)**
  - **Description**: Dynamic diplomacy state machine governing peace treaties, border friction, skirmish squad formation, and combat resolution with casualty morale retreats.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/tribe/diplomacy.js`
    2. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/behavior/combat.js`
    3. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/behavior/humans.js`
  - **Acceptance Criteria**: Border encroachment elevates tension; war state triggers skirmish parties; casualties &gt; 30% trigger surrender/peace negotiation cooldown.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [ ] **Task 6: Procedural 3D Settlement Structures & Banners**
  - **Description**: Three.js procedural rendering for thatched huts, stone granaries, watchtowers, campfires with flickering point lights, and tribal banner accents on human meshes.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/wwwroot/js/poecosystem/render/settlementMesh.js`
    2. `src/PoMiniGames.Client/wwwroot/js/poecosystem/render/creatureMeshes.js`
    3. `src/PoMiniGames.Client/wwwroot/js/poecosystem/render/renderer.js`
  - **Acceptance Criteria**: Instanced geometries batch efficiently; buildings render at appropriate coordinates; human meshes display distinct tribal banner colors.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [ ] **Task 7: Overhead God-Camera & Director Presets**
  - **Description**: Overhead orbit/pan/zoom camera with terrain height clamping and smart tracking presets (Island Overview, Focus Tribe, Active Conflict, Milestone Focus).
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/wwwroot/js/poecosystem/render/camera.js`
    2. `src/PoMiniGames.Client/wwwroot/js/poecosystem/render/director.js`
    3. `src/PoMiniGames.Client/Games/PoEcosystem/PoEcosystemViewer.razor`
    4. `src/PoMiniGames.Client/Games/PoEcosystem/PoEcosystemViewer.razor.cs`
  - **Acceptance Criteria**: Camera smoothly interpolates between targets; terrain collision prevents clipping below ground; quick-action buttons switch modes seamlessly.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [ ] **Task 8: Milestone Chronicle Generator & API Relay**
  - **Description**: Generates procedural historical milestone logs (tech discovery, war outbreak, peace treaty, chief succession) and relays them to the backend chronicle service.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/tribe/chronicle.js`
    2. `src/PoMiniGames.API/Features/PoEcosystem/EcosystemChronicleService.cs`
    3. `src/PoMiniGames.Client/Games/PoEcosystem/Services/PoEcosystemApiClient.cs`
    4. `tests/PoMiniGames.Unit/Features/PoEcosystem/EcosystemChronicleServiceTests.cs`
  - **Acceptance Criteria**: Significant milestones produce formatted chronicle entries; template fallback ensures zero failure when external services are absent.
  - **Verification**: `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~EcosystemChronicleService"`

---

- [x] **Task 9: Snapshot Codec v2 & Backward Migration**
  - **Description**: Extend IndexedDB world state snapshot codec to serialize multi-tribe state, buildings, tech progress, and diplomatic matrix; migrate v1 saves cleanly.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/persistence/codec.js`
    2. `src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/persistence/idb.js`
    3. `src/PoMiniGames.API/Features/PoEcosystem/EcosystemWorldStore.cs`
  - **Acceptance Criteria**: World snapshots round-trip with zero loss of tribal state; loading legacy v1 snapshots upgrades seamlessly without throwing errors.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [x] **Task 10: Advanced Analytics Dashboard (LiveCharts2 & Blazor.Extensions.Canvas Minimap)**
  - **Description**: Build comprehensive observer analytics HUD featuring reactive LiveCharts2 population/resource graphs, a hardware-accelerated 2D territory canvas minimap via `Blazor.Extensions.Canvas`, tribal comparison data grid, and historical event timeline.
  - **File Manifest** (&le; 5 files):
    1. `src/PoMiniGames.Client/Games/PoEcosystem/Components/DashboardOverlay.razor`
    2. `src/PoMiniGames.Client/Games/PoEcosystem/Components/TribeComparisonGrid.razor`
    3. `src/PoMiniGames.Client/Games/PoEcosystem/Components/PopulationChart.razor`
    4. `src/PoMiniGames.Client/Games/PoEcosystem/Components/TerritoryMinimap.razor`
    5. `src/PoMiniGames.Client/wwwroot/css/poecosystem.css`
  - **Acceptance Criteria**: Dashboard toggles cleanly; LiveCharts2 line/area charts update smoothly from throttled telemetry; 2D canvas minimap renders tribal territory contours at 60 FPS; styled with CSS design tokens.
  - **Verification**: `dotnet build PoMiniGames.slnx`

---

- [ ] **Task 11: End-to-End Verification, Ceilings & Smoke Test**
  - **Description**: Run smoke tests, verify ceiling compliance across all 4 tiers, verify API host boot, and audit bundle footprint.
  - **File Manifest** (&le; 5 files):
    1. `tests/PoMiniGames.E2EUI/PoEcosystemUiTests.cs`
    2. `src/PoMiniGames.Client/Games/PoEcosystem/PoEcosystemPage.razor`
  - **Acceptance Criteria**: `PoEcosystemUiTests` passes; Unit &le; 100, Integration &le; 50, E2E-API &le; 25, E2E-UI &le; 25; API host returns 200 on `GET /health`.
  - **Verification**:
    - `dotnet build PoMiniGames.slnx`
    - `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~TestCountCeilingTests"`
    - `dotnet test tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj --filter "FullyQualifiedName~IntegrationTestCountCeilingTests"`
    - `dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj --filter "FullyQualifiedName~E2EUiTestCountCeilingTests"`
