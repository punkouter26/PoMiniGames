# Specification — Sand

## 1. Objective & Overview
**Sand** is a 2D high-performance multi-material physical simulation sandbox running client-side within the PoMiniGames Blazor WebAssembly arcade framework. The engine simulates 480,000 discrete simulation cells ($800 \times 600$ viewport) at **60 FPS**, modeling Mohr-Coulomb cohesive soil mechanics, connected rigid-body concrete structural collapse, mass-conserving Eulerian fluid dynamics, and ballistic slingshot ordnance (dry acoustic blast shockwaves vs. water-submerged fuse extinction).

---

## 2. User Journeys

### Journey 1: Sandbox Terrain Manipulation & Excavation
1. The player navigates to `/subsurface` from the PoMiniGames home grid or game catalog.
2. The player selects the **Dig Vacuum** tool from the docked Radzen Blazor toolbar and adjusts the brush radius (1–32px).
3. The player drags across the cohesive sand matrix:
   - Excavating trenches reveals self-supporting vertical cuts and arched cavern ceilings up to critical span $L_{\text{crit}}$.
   - Excavating beyond $L_{\text{crit}}$ triggers Mohr-Coulomb shear failure, causing realistic sand cave-in avalanches.
4. The player carves under reinforced concrete bars:
   - Once all supporting soil is excavated, the concrete bar falls as a single coherent rigid body without deforming, coming to rest on bedrock or supported terrain.

### Journey 2: Cavern Breach & Hydrostatic Fluid Flow
1. The player uses the Dig Vacuum or Sand Brush to breach an underground sealed water reservoir.
2. Water flows dynamically through the breached channel under hydrostatic pressure ($P = \rho g h$) into low-lying caverns without leaking through solid sand or concrete barriers.
3. Excess fluid reaching the lateral boundaries ($X \le 0$ or $X \ge 799$) drains permanently out of the matrix.

### Journey 3: Ballistic Slingshot Ordnance & Explosives
1. The player selects the **TNT Bomb (5s)** or **Water Balloon** from the toolbar.
2. The player clicks and drags within the Sky/Atmosphere zone (Rows 0–299) to aim; a directional trajectory/velocity vector is displayed.
3. Upon release:
   - **TNT in Dry Tunnel:** The bomb rolls/bounces along terrain. After a 5.0-second countdown, it detonates, propagating high-contrast acoustic blast shockwaves through voids and tunnels, pulverizing surrounding sand and shattering unsupported concrete into dissipating debris.
   - **TNT into Water:** If the bomb contacts water before 5 seconds, the fuse is immediately extinguished. The bomb becomes an inert circular rigid body that sinks and rests permanently on the bottom.
   - **Water Balloon:** On impact with any solid or fluid surface, the balloon bursts, releasing a radial surge of high-pressure fluid cells that washes through open tunnels.

### Journey 4: Presets, Snapshot Save/Load & Kiosk Demo
1. The player can switch between presets (*Default Horizon*, *Deep Cavern Matrix*, *Slingshot Demolition Range*).
2. The player can save a custom snapshot to browser LocalStorage and reload it at any time.
3. In Kiosk Demo mode, the sandbox auto-runs demo scenarios (excavation, fluid breach, TNT detonation).

---

## 3. Tech Stack & Versions

- **Runtime Target:** .NET 10.0 (C# 13 / Blazor WebAssembly)
- **UI Framework:** Radzen.Blazor controls (`RadzenSelectBar`, `RadzenSlider`, `RadzenNumeric`, `RadzenButton`, `RadzenSwitch`, `RadzenBadge`, `RadzenCard`) styled with dark arcade theme
- **Graphics & Compute Engine:** WebGL 2.0 Ping-Pong Framebuffers (`RGBA8`/`RGBA32F`), GLSL compute & render shaders
- **Client Scripting & Physics Loop:** Native ES6 JavaScript (`subsurface-engine.js`) for high-frequency input, slingshot trajectory, and rigid island tracking
- **Test Frameworks:** xUnit 2.9.3, bUnit, FluentAssertions 8.8.0, Microsoft.NET.Test.Sdk 17.14.1

---

## 4. Build, Test, Lint & Run Commands

```powershell
# Build entire solution
dotnet build PoMiniGames.slnx

# Run unit and component test suite
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj

# Run client application locally
dotnet run --project src/PoMiniGames.Client/PoMiniGamesClient.csproj

# Run full solution tests with coverage
dotnet test PoMiniGames.slnx /p:CollectCoverage=true /p:CoverletOutputFormat=cobertura
```

---

## 5. Project Structure

```text
/src/PoMiniGames.Client
├── /Games/SubSurface
│   ├── SubSurfacePage.razor           // Game container, shell, header, catalog info
│   ├── SubSurfaceSandbox.razor        // Docked Radzen toolbar, canvas container, DOM listeners
│   └── SubSurfaceSandbox.razor.cs     // State bindings, parameters, JS module lifecycle
├── /Models/SubSurface
│   ├── SubSurfaceEnums.cs             // MaterialType, ToolType, SimulationPreset
│   ├── SubSurfaceState.cs             // Simulation status, brush configuration, metrics
│   └── SubSurfaceSnapshot.cs          // LocalStorage serialization model
└── /wwwroot
    └── /js/subsurface
        ├── subsurface-engine.js       // WebGL2 context, 60 FPS tick, rigid-body solver, event dispatcher
        ├── subsurface-physics.glsl    // GLSL cellular automata, fluid flow, shockwaves
        └── subsurface-render.glsl     // Retro pixel-art palette & shockwave flash shaders

/tests/PoMiniGames.Unit
└── /SubSurface
    ├── SubSurfacePhysicsTests.cs      // Mohr-Coulomb, fluid conservation, ballistic math unit tests
    ├── SubSurfaceIslandSolverTests.cs // Connected-component rigid body graph traversal tests
    └── SubSurfaceComponentTests.cs    // bUnit tests for SubSurfaceSandbox & Radzen toolbar
```

---

## 6. Code Style & Conventions

- Strict C# 13 nullable reference types enabled (`<Nullable>enable</Nullable>`).
- Primary constructors, file-scoped namespaces, and sealed records for state contracts.
- High-frequency simulation updates run on `requestAnimationFrame` within JS/WebGL2 to prevent GC pressure and WASM interop overhead.
- All interop method identifiers use camelCase strings defined as constants in C#.

```csharp
namespace PoMiniGamesClient.Models.SubSurface;

public sealed record SubSurfaceToolConfig(
    SubSurfaceTool Tool,
    int BrushRadius,
    bool IsPaused,
    float SlingshotPowerMultiplier = 1.0f)
{
    public static SubSurfaceToolConfig Default => new(
        Tool: SubSurfaceTool.DigVacuum,
        BrushRadius: 8,
        IsPaused: false);
}
```

---

## 7. Testing Strategy & Coverage Target

- **Unit Tests (xUnit + FluentAssertions):**
  - Grid coordinate conversion, bounding box clamping, and bit-packed cell properties.
  - Mohr-Coulomb shear threshold and stable span calculation.
  - Connected component rigid bar graph detection and support checking.
  - Slingshot velocity vector calculation and ballistic trajectory steps.
  - Ordnance state machine (5s dry detonation vs. instant water fuse extinction).
- **Component Tests (bUnit):**
  - `SubSurfaceSandbox.razor` mounts canvas and initializes JS interop.
  - Radzen toolbar controls update internal state and trigger JS interop parameter pushes.
  - Preset selection triggers scene rebuild.
- **Coverage Target:** $>80\%$ line and branch coverage across C# domain logic and component code.

---

## 8. Boundaries & Rules

- **ALWAYS:**
  - Keep 60 FPS rendering and high-frequency mouse drag loops inside native JS/WebGL2.
  - Use Radzen Blazor controls for toolbar inputs, sliders, switches, and dropdowns.
  - Provide fallback/drainage handling for cells out of bounds.
- **ASK FIRST:**
  - Introducing server-side persistent database requirements or network multiplayer.
  - Modifying existing game routes or shared layout infrastructure.
- **NEVER:**
  - Invoke per-pixel JS-to-WASM interop callbacks during active animation frames.
  - Commit secrets, API keys, or large uncompressed binary assets.
  - Skip, suppress, or delete failing tests.

---

## 9. Explicit Out-of-Scope (v1)

- Real-time multiplayer synchronization over SignalR.
- 3D voxel mesh generation or ray-marching shaders.
- Paid DLC / in-app purchases / cloud user accounts.

---

## 10. Edge Cases & Error States

- **WebGL 2.0 Unsupported:** Fallback banner notifying user of WebGL 2.0 requirement with a 2D canvas simulation fallback or clean diagnostic error.
- **Canvas Resize / High-DPI Displays:** Viewport maintaining internal $800 \times 600$ render target with CSS `aspect-ratio: 4/3` and `touch-action: none` to prevent mobile scroll interference.
- **Rapid Slingshot Spam:** Cap active projectile instances to 32 simultaneously active bodies to prevent physics loop degradation.
- **Out of Bounds Projectiles:** Projectiles leaving viewport boundaries (above sky or beyond lateral walls) are cleanly recycled.

---

## 11. Measurable Success Criteria

1. **SC-1 (Grid Resolution):** Engine allocates and processes an $800 \times 600$ (480,000 cells) simulation grid.
2. **SC-2 (Frame Rate):** Maintains stable 60 FPS (16.6ms frame budget) during multi-material simulation on modern browsers.
3. **SC-3 (Mohr-Coulomb Mechanics):** Stable self-supporting arches form up to critical span $L_{\text{crit}}$; wider excavations trigger realistic sand collapse.
4. **SC-4 (Rigid Concrete Falling):** Undermined concrete bars fall as intact, connected rigid bodies without fragmenting until ground contact.
5. **SC-5 (Eulerian Fluid Pooling & Draining):** Water pools stably in basins, breaches realistically, and drains through lateral boundary channels ($X \le 0, X \ge 799$).
6. **SC-6 (Ballistic TNT Dry vs. Water):** Dry TNT detonates after 5s sending acoustic shockwaves through tunnels; water-contact TNT immediately extinguishes fuse and becomes inert.
7. **SC-7 (Radzen UI Controls):** Full suite of Radzen Blazor controls allows interactive tool selection, brush resizing, pausing, stepping, and preset switching.
8. **SC-8 (Test Suite):** Complete test suite passes with zero errors and $>80\%$ code coverage.

---

## 12. Open Questions

*(None currently open. All baseline assumptions confirmed.)*
