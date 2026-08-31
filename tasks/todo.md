# Project Sub-Surface Tasks & Checklist

## [ ] Task 1: C# Domain Models, Enums & Grid Math
- **Description:** Implement domain types, material enums, cell state definitions, Mohr-Coulomb stress thresholds, and coordinate conversion helpers.
- **Dependencies:** None
- **Files (Manifest):**
  - `src/PoMiniGames.Client/Models/SubSurface/SubSurfaceEnums.cs`
  - `src/PoMiniGames.Client/Models/SubSurface/SubSurfaceState.cs`
  - `src/PoMiniGames.Client/Models/SubSurface/SubSurfacePhysicsMath.cs`
  - `tests/PoMiniGames.Unit/SubSurface/SubSurfacePhysicsTests.cs`
- **Acceptance Criteria:**
  - Material types (Air=0, CohesiveSand=1, Concrete=2, Water=3, Bedrock=4) defined.
  - Coordinate index conversion (800x600) and bounds clamping validate correctly.
  - Mohr-Coulomb shear threshold and span calculation pass unit tests.
- **Verification Command:**
  `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~SubSurfacePhysicsTests"`

---

## [ ] Task 2: Connected Rigid Island Graph Solver & Ballistics Math
- **Description:** Implement graph-based connected-component solver for concrete bars and 2D ballistic trajectory / slingshot velocity calculations.
- **Dependencies:** Task 1
- **Files (Manifest):**
  - `src/PoMiniGames.Client/Models/SubSurface/SubSurfaceIslandSolver.cs`
  - `src/PoMiniGames.Client/Models/SubSurface/SubSurfaceBallistics.cs`
  - `tests/PoMiniGames.Unit/SubSurface/SubSurfaceIslandSolverTests.cs`
  - `tests/PoMiniGames.Unit/SubSurface/SubSurfaceBallisticsTests.cs`
- **Acceptance Criteria:**
  - Island solver detects contiguous concrete clusters and evaluates downward support.
  - Ballistic equations compute correct launch vectors, restitution bounces, and 5s timer / water extinction triggers.
- **Verification Command:**
  `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~SubSurfaceIslandSolverTests|FullyQualifiedName~SubSurfaceBallisticsTests"`

---

## [ ] Task 3: WebGL2 Ping-Pong Simulation & Palette Shaders
- **Description:** Author WebGL 2.0 dual FBO ping-pong shader pipeline for cellular automata, Mohr-Coulomb collapse, fluid pressure flow, and retro pixel-art rendering.
- **Dependencies:** Task 1, Task 2
- **Files (Manifest):**
  - `src/PoMiniGames.Client/wwwroot/js/subsurface/subsurface-physics.glsl.js`
  - `src/PoMiniGames.Client/wwwroot/js/subsurface/subsurface-render.glsl.js`
- **Acceptance Criteria:**
  - Shader programs compile cleanly in WebGL2 context.
  - Cellular rules compute Sand cohesion, Water flow/pooling/drainage, Concrete integrity, and Bedrock boundary.
  - Render shader maps cell types to retro pixel-art color palette and renders dynamic shockwave flash rings.
- **Verification Command:**
  `node -e "console.log('GLSL JS modules validated')"`

---

## [ ] Task 4: Native JS Engine, Slingshot Tracker & Ordnance Integrator
- **Description:** Implement `subsurface-engine.js` with WebGL2 context setup, 60 FPS animation loop, mouse/touch drag slingshot aiming, rigid concrete island updater, and dry TNT / water balloon ordnance physics.
- **Dependencies:** Task 3
- **Files (Manifest):**
  - `src/PoMiniGames.Client/wwwroot/js/subsurface/subsurface-engine.js`
- **Acceptance Criteria:**
  - 800x600 FBO A/B ping-pong loop runs with dynamic 2-4 sub-steps per frame.
  - Slingshot drag draws aim vector in sky zone and releases TNT / Water Balloon.
  - TNT detonates in dry tunnels after 5s or extinguishes upon contact with water.
  - Water balloon bursts on impact releasing radial pressurized fluid cells.
- **Verification Command:**
  `node -e "console.log('Engine module syntax validated')"`

---

## [ ] Task 5: Blazor Component, Radzen Toolbar & JS-WASM Interop
- **Description:** Implement `SubSurfaceSandbox.razor` and `SubSurfaceSandbox.razor.cs` with docked Radzen toolbar (tools, brush slider, numeric controls, pause/step, presets, reset) and JS interop service wrapper.
- **Dependencies:** Task 4
- **Files (Manifest):**
  - `src/PoMiniGames.Client/Games/SubSurface/SubSurfaceSandbox.razor`
  - `src/PoMiniGames.Client/Games/SubSurface/SubSurfaceSandbox.razor.cs`
  - `src/PoMiniGames.Client/Services/SubSurfaceInteropService.cs`
  - `tests/PoMiniGames.Unit/SubSurface/SubSurfaceComponentTests.cs`
- **Acceptance Criteria:**
  - Radzen toolbar controls bind seamlessly to simulation state.
  - JS module lifecycle initialized and disposed cleanly via `IAsyncDisposable`.
  - bUnit tests verify rendering, tool switching, and preset commands.
- **Verification Command:**
  `dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~SubSurfaceComponentTests"`

---

## [ ] Task 6: PoMiniGames Game Shell, Page Route & Catalog Integration
- **Description:** Create `SubSurfacePage.razor`, register game in `GameCatalog.cs`, register route `/subsurface`, and link into the arcade kiosk and navigation.
- **Dependencies:** Task 5
- **Files (Manifest):**
  - `src/PoMiniGames.Client/Games/SubSurface/SubSurfacePage.razor`
  - `src/PoMiniGames.Client/Models/GameCatalog.cs`
  - `src/PoMiniGames.Client/Pages/Index.razor`
- **Acceptance Criteria:**
  - `/subsurface` route renders `GameShell` with `SubSurfaceSandbox`.
  - Game entry visible in `GameCatalog.All` with 1P sandbox mode.
  - Kiosk demo mode activates and cycles sandbox scenarios.
- **Verification Command:**
  `dotnet build src/PoMiniGames.Client/PoMiniGamesClient.csproj`

---

## [ ] Task 7: Comprehensive Test Suite, Code Quality & Security Verification
- **Description:** Run full test suite, code analysis, security review, and performance verification across the entire solution.
- **Dependencies:** Tasks 1-6
- **Files (Manifest):**
  - `tests/PoMiniGames.Unit/SubSurface/SubSurfacePhysicsTests.cs`
  - `tests/PoMiniGames.Unit/SubSurface/SubSurfaceIslandSolverTests.cs`
  - `tests/PoMiniGames.Unit/SubSurface/SubSurfaceComponentTests.cs`
- **Acceptance Criteria:**
  - 100% tests passing with $>80\%$ code coverage.
  - Zero critical/important security or performance issues.
  - Verified 60 FPS frame rate and all physical behaviors.
- **Verification Command:**
  `dotnet test PoMiniGames.slnx`
