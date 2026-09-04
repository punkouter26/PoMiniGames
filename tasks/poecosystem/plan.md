# PoEcosystem — Implementation Plan

## Context

PoEcosystem is a new self-running 3D island ecosystem game inside the PoMiniGames Blazor WASM
arcade (approved spec: `docs/poecosystem/SPEC.md`, module map: `docs/poecosystem/CAPABILITY-MAP.md`).
Rabbits/deer/wolves/humans live, mate, age and die on an accelerated clock (movement real-speed),
with pack/herd behaviour, memory, life stages, thirst, an optional in-browser LLM that nudges
personality traits within hard bounds, real cannon-es physics for deaths/trees/rocks/lightning/
volcano, IndexedDB save/resume, population charts and an event log. No server, no auth, no Radzen.

On approval I will (1) copy this plan into `tasks/poecosystem/plan.md` + `tasks/poecosystem/todo.md`,
(2) patch SPEC §7.7 for the rock-kill rule below, (3) present the "top 50 libs" list per the
standing rules, then (4) start Task 1. No game code before the user's "approved".

## Architecture decisions

1. **Hub-and-spoke threads.** Main thread (`index.js`, `host/simHost.js`, `render/*`) ↔ sim worker
   (`host/simWorker.js`: World + cannon-es) and ↔ thought worker (`thoughtWorker.js`: WebLLM).
   The two workers never talk directly; prompts/results route through main so WebGPU gating, model
   download UI and the inline fallback stay trivial.
2. **One runtime, two hosts.** `host/simRuntime.js` exports `createSimRuntime(post, {CANNON, idb})`
   → `{handle(msg)}`. The worker wraps it in `self.onmessage`; `simHost.js` runs the same object
   inline if the worker fails; Vitest drives it with a fake `post`.
   **Import maps do not apply in workers** → the worker does
   `await import(CANNON_CDN_URL)` (absolute jsdelivr URL from `config.js`, mirroring `index.html`
   L133); main-thread fallback uses the import-map `cannon-es`; tests use `node_modules`.
3. **Frame transport.** 20 Hz transferable `ArrayBuffer` (3-buffer pool recycled main→worker):
   `Int32[8]` header, `Int32[CAP]` handles (`index | gen<<16`), `Float32[CAP*8]` creatures
   `[x,y,z,yaw,scale,speciesId,stateId,lifeStage]`, `Float32[PROP_CAP*8]` props
   `[x,y,z,qx,qy,qz,qw,propKind]` (`propKind = kind*8 + sizeIndex`, sizes in `config.PROP_SIZES`).
   Main interpolates between the last two frames. Low-frequency channels (tiles, grass, stats,
   events, detail, thoughtRequest, llm) are plain objects. Commands: `init, setSpeed, select,
   newWorld, setLlmEnabled, thoughtResult, pause, resume, saveNow, debug`.
4. **Determinism (criterion 4).** Physics is write-only: `createPhysics(CANNON, terrain)` and
   `nullPhysics()` share one surface and `world.js` never reads a body. All deaths use kinematic sim
   positions: lightning radius on positions; **rock kills = analytic impact point (parabola marched
   against the heightmap) + downhill corridor window** — replaces SPEC §7.7 "contacted at > 3 m/s"
   (the cannon rock gets the same launch velocity so it lands near the same spot). Per-subsystem
   `mulberry32` streams (`terrain, genetics, behavior, events, names, cosmetic`) with get/setState;
   `Math.random` banned under `sim/**` (grep test). Dense index iteration; counting-sort spatial hash.
   Test: cannon vs nullPhysics, seed 7, tick 6000 → identical counts + positions.
5. **Data layout.** SoA typed arrays cap 400 (250 low-end) in `sim/core/entities.js`; uniform 8 m
   spatial grid rebuilt each tick; utility AI re-scored every 5 ticks staggered `i % 5` with +0.05
   hysteresis; steering every tick; BFS distance fields for water/home computed at gen (no A*).
6. **Snapshot v1** (structured clone into IndexedDB `poecosystem/worlds/'current'`, written by the
   worker): seed + terrainHash, RNG states, tile arrays, SoA columns sliced to `high`, huts/logs,
   event timers/fire/lava/corridors, **settled props only** (unsettled ragdolls saved as carcasses in
   `lyingPose`), log ≤200, popHistory. terrainHash/schema mismatch → New World.
7. **Ragdolls.** Quadruped 6 boxes (torso, head, 4 legs), biped 7 boxes; `ConeTwistConstraint`s with
   pivots computed from the live pose (pattern: `pobrawl/ragdollPhysics.js` L177-217). Sleep → STATIC
   carcass; `MAX_ACTIVE_RAGDOLLS = 16`, overflow spawns static `lyingPose`. Felled tree: trunk box on a
   1 s `HingeConstraint` at the stump, then free, sleep → STATIC log.
8. **Camera is a first-person god** (user decision 2026-09-02, replacing the top-down orbit):
   pointer-lock mouse look, WASD walk over the heightmap (eye 1.7 m, capsule 0.4 m, gravity,
   jump), Shift run, F fly (noclip, altitude clamp), swimming in deep water. The player is not a
   sim entity; position lives in prefs. **Picking** is a camera→crosshair ray tested against
   creature bounding spheres from the last interpolated frame (nearest within 60 m); E/click
   inspects. A minimap (top-right) renders island tiles + species dots + player arrow from the
   low-frequency `tiles`/`stats` channels plus the frame positions. HUD = layout concept C
   (crosshair, sparkline, toasts, Tab dashboard overlay, popover inspector).
9. **Blazor**: `PoEcosystemInteropService` owns the DotNetObjectReference,
   `[JSInvokable]` → C# events, and `JSDisconnectedException` handling on dispose, and calls
   `window.PoEcosystem.*` after `loadEngine('poecosystem')`. DTOs are flat records (trim-safe).
   The page uses GameShell `RequiresWebGl`, GameIntro, and Demo mode. Chart reuses
   `Games/PoSurvive/Features/Charts/ChartGeometry.cs` + `SvgText.razor`. Mobile bottom sheet is plain
   CSS radio-tabs in the viewer's scoped CSS (`--z-btb` slot 70) — no new shared component.

## Reuse (existing code)

- `wwwroot/js/engineLoader.js` REGISTRY + `loadEngine` / `isWebGlAvailable`
- `povoxelstrike/world.js` `export function mulberry32(seed)`; value-noise hash `povoxelstrike/terrain.js` L636-652 (copy)
- `povoxelstrike/terrain.js` L390-430 Heightfield setup; `povoxelstrike/physics.js` `createPhysicsWorld` settings
- `povoxelstrike/structure.js` L66-86 module-worker spawn + fallback; `posurvive/gpuProbe.js` `checkGpu()`
- `posurvive/inferenceWorker.js` CDN candidate `import()` loop + `CreateMLCEngine` progress callback
- `povoxelstrike/game.js` L184-235 lighting/shadow-follow; `pomarblerace/scene.js` L423-455 pointer orbit
- `Components/GameShell.razor`, `GameIntro.razor`; `Services/BrowserViewport.cs`; `tests/PoMiniGames.E2EUI/PoVoxelStrikeUiTests.cs`

## Dependency graph

```
T1 tooling → T2 core → T3 terrain → T6 flora ─┐
                     └→ T4 creatures A → T5 creatures B → T7 behavior A → T8 behavior B → T9 world
T9 → T10 physics → T11 events A → T12 events B ─┐
T9 → T13 thoughts ───────────────────────────────┼→ T14 persistence → T15 host runtime
T15 → T16 thought worker;  T15 → T17 renderer A → T18 renderer B
T15 → T19 interop+registry → T20 page → T21 chart+speed → T22 log+inspector → T23 settings/banner/mobile → T24 catalog+tiers
```

## Tasks (vertical slices, ≤5 source files each; every task also adds its mirror tests under `tests/PoEcosystem.Sim/`)

JS paths relative to `src/PoMiniGames.Client/wwwroot/js/poecosystem/`; Blazor paths relative to `src/PoMiniGames.Client/Games/PoEcosystem/`. Each task: RED → GREEN → `npm test` → `dotnet build PoMiniGames.slnx` → commit → tick todo.

| # | Task | Files | Acceptance | Verify | Deps |
|---|---|---|---|---|---|
| 1 | Vitest tooling | `package.json` (root, private, type=module, vitest 4.1.11, @vitest/coverage-v8, cannon-es 0.20.0), `vitest.config.js`, `tests/PoEcosystem.Sim/smoke.test.js` | `npm install` clean; `npm test` green; coverage report; `node_modules/`,`coverage/` already ignored | `npm test` | — |
| 2 | Sim core | `sim/core/config.js`, `prng.js`, `clock.js`, `entities.js`, `events.js` | Same seed ⇒ identical draws; RNG state round-trip; accumulator ≤4 steps/tick; alloc/free deterministic; bus ordered | `npm test -- core` | 1 |
| 3 | Terrain | `sim/terrain/noise.js`, `island.js`, `tiles.js`, `pathing.js` | Ocean border; ≥1 lake, exactly 1 volcano; walkable 0.45–0.75; same seed ⇒ same terrainHash; BFS fields reach all walkable | `npm test -- terrain` | 2 |
| 4 | Creatures A | `sim/creatures/species.js`, `drives.js`, `lifecycle.js` | Starve ≈75 s / dehydrate ≈50 s; stage transitions; old-age only after 85 %; cause recorded | `npm test -- creatures` | 2 |
| 5 | Creatures B | `sim/creatures/traits.js`, `genetics.js`, `names.js` | Offspring = mean ± N(0,.08) clamped; 1000 unique names/species; mating eligibility | `npm test -- creatures` | 4 |
| 6 | Flora | `sim/flora/grass.js`, `bushes.js`, `trees.js` | Logistic regrowth; none on sand/rock; berries 40 s ripen/strip; chop/burn → stump; density caps | `npm test -- flora` | 3 |
| 7 | Behavior A | `sim/core/spatial.js`, `sim/behavior/memory.js`, `steering.js`, `utility.js` | Hash == brute force; memory decays; Flee > Eat under threat; never enters deep water | `npm test -- behavior` | 5, 6 |
| 8 | Behavior B | `sim/behavior/social.js`, `humans.js` | Herd alert/scatter; pack converge + share kill; hut trigger (beds < tribe, 3 logs); orphan +50 % hunger; juvenile follows parent | `npm test -- behavior` | 7 |
| 9 | World composition | `sim/world.js`, `sim/frame.js` | Fresh world <300 ms in Node; **determinism seed 7 @ tick 6000**; `LONG=1` population test (seeds 1–5, 15 min: boom-bust, no extinction <5 min in ≥4/5); `Math.random` grep = 0 | `npm test -- world`; `LONG=1 npm test -- population` | 8 |
| 10 | Physics | `sim/physics/world.js`, `ragdoll.js`, `rocks.js`, `fallingTree.js`, `explosion.js` | Ragdoll settles <10 s; tree rests; rock rolls downhill on heightfield; impulse ∝1/r; `lyingPose` | `npm test -- physics` | 3, 9 |
| 11 | Events A | `sim/events/scheduler.js`, `lightning.js`, `rockslide.js`, `sim/world.js` (wiring) | ≥45 s spacing; lightning kills ≤6 m, fells trees ≤3 m; corridor kills identical cannon vs null | `npm test -- events` | 10 |
| 12 | Events B | `sim/events/volcano.js`, `fire.js`, `sim/world.js` (wiring) | Fire only on flammable, dies at water/sand, 6 s burn; lava 30 s creep → rock; fear 40 m; cannon-vs-null equality holds | `npm test -- events`; `npm test -- world` | 11 |
| 13 | Thoughts | `sim/thoughts/scheduler.js`, `prompt.js`, `templates.js`, `nudges.js` | Round-robin covers all before repeat; selected preempts; delta clamp ±0.25, decay 60 s; malformed ⇒ template; prompt ≤600 chars | `npm test -- thoughts` | 9 |
| 14 | Persistence | `sim/persistence/snapshot.js`, `idb.js` (+ `memoryIdb`), `prefs.js`, `sim/world.js` (to/from) | Round-trip identical after +200 ticks; version/terrainHash mismatch ⇒ null | `npm test -- persistence` | 12, 13 |
| 15 | Host runtime | `host/simRuntime.js`, `host/simWorker.js`, `host/simHost.js`, `index.js` | Fake-post tests: init→ready, frames, select→detail, recycle; worker failure → inline (`__poeco().mode`) | `npm test -- host`; manual console | 14 |
| 16 | Thought worker | `thoughtWorker.js`, `host/thoughtBridge.js` | Schema mode once → free-form + `{…}` extraction on grammar error; one in flight; progress events; WebGPU probe | manual (LLM thought <15 s after load); `npm test -- thoughts` | 15 |
| 17 | Renderer A | `render/renderer.js`, `terrainMesh.js`, `playerController.js` (pointer lock, WASD/run/jump/fly/swim, heightmap collision, touch fallback), `lighting.js` | Island renders <2 s; walk never falls through terrain; F flies; day/night 120 s; shadows off low-end; `__poeco().player` | manual (`dotnet run`) + Vitest on the pure controller math (`playerController` step is DOM-free) | 15 |
| 18 | Renderer B | `render/creatureMeshes.js`, `propMeshes.js`, `floraMeshes.js`, `picking.js` (crosshair ray vs bounding spheres, highlight, Follow tether), `minimap.js` (2D canvas: tiles + dots + player arrow) | ≥30 fps @400 + 20 bodies (`__poeco().fps`); E/click → detail <200 ms; outline + Follow; minimap tracks player | manual | 17 |
| 19 | Interop + registry | `Services/PoEcosystemInteropService.cs`, `Models/PoEcosystemDtos.cs`, `src/PoMiniGames.Client/Program.cs`, `wwwroot/js/engineLoader.js` | `dotnet build` zero warnings; `loadEngine('poecosystem')` true | `dotnet build` | 15 |
| 20 | Page + viewer | `PoEcosystemPage.razor(.css)`, `PoEcosystemViewer.razor(.cs,.css)` (full-bleed canvas host, HUD layer, crosshair, "click to look around" hint, key legend) | `/poecosystem`, `/poecosystem/demo` boot; Resume/New prompt; <2 s fresh (criterion 3) | `dotnet build`; manual | 19 |
| 21 | HUD: sparkline, speed, clock, toasts | `Components/HudBar.razor(.css)` (clock + speed pills, keys 0–3), `Sparkline.razor(.css)`, `EventToasts.razor(.css)` | Live sparkline + aria-live summary; ⏸/1×/2×/4×; three fading toasts | `dotnet build`; hex grep = 0; bUnit renders | 20 |
| 22 | Inspector popover + dashboard overlay | `Components/InspectorPopover.razor(.css)`, `DashboardOverlay.razor(.css)` (focus-trapped dialog: `PopulationChart`, `EventLog`), `PopulationChart.razor`, `EventLog.razor` | All J2 fields, nudge highlight, source badge, Follow; Tab/Esc; log shows all event kinds | `dotnet build`; bUnit; manual | 21 |
| 23 | Settings, banner, touch fallback | `Components/SettingsPanel.razor(.css)`, `EndBanner.razor(.css)`, `PoEcosystemViewer.razor.css` (390 px reflow, on-screen move pad) | LLM toggle greyed w/o WebGPU; model picker + progress; seed coercion; banners via `__poeco().debug('massKill')`; 390×844 no h-scroll | `dotnet build`; manual 390×844 | 22 |
| 24 | Catalog + tiers | `Models/GameKey.cs`, `Domain/Primitives/GameKey.cs`, `Models/GameCatalog.cs`, `tests/PoMiniGames.E2EUI/PoEcosystemUiTests.cs`, `scripts/test-all.ps1` | Card + Demo reel; E2E-UI count 11 ≤ 25; SimJs tier first in test-all | `dotnet build`; user runs `pwsh scripts/test-all.ps1` | 23 |

## Checkpoints

- **CP-A (after 3):** `npm test` green, coverage report, terrainHash stable across two Node runs.
- **CP-B (after 6):** creatures + flora ≥80 % lines; no `Math.random` under `sim/`.
- **CP-C (after 9) — the big one:** determinism passes; `LONG=1` population test shows boom-bust on ≥4/5 seeds. **Tune `config.js` here, before physics/UI exist.**
- **CP-D (after 12):** cannon-vs-null equality holds with all events; settle tests pass in Node.
- **CP-E (after 15):** LLM-off feature complete headless; snapshot exact; protocol tests pass.
- **CP-F (after 18):** first browser run — record `__poeco().fps` at 400; screenshots for criteria 9/10.
- **CP-G (after 24):** `dotnet build` zero warnings; hex grep 0; mobile pass; E2E-UI count 11; hand tier run to user. Then Phase 5: /code-review, /security-review, /simplify, evidence per success criterion.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Import maps absent in workers | Worker never boots, fallback hides it | Inject `CANNON` via runtime deps; worker imports `CANNON_CDN_URL`; loud log + `__poeco().mode='inline'` |
| SPEC §7.7 contact-kill vs determinism | Can't satisfy both | Impact-point + corridor rule; SPEC patched on approval; header comment in `rockslide.js` |
| cannon-es order sensitivity | Over-strict test flakes | Compare populations/positions only; `vi.resetModules()` between runs |
| WebLLM grammar mode crashes (seen in PoSurvive) | LLM unusable | Try schema once → free-form + JSON extraction; `nudges.js` re-validation is the gate; count rejects |
| 4× speed = 80 steps/s in one worker | Sim lag | Budget ≤1.5 ms sim + ≤1 ms physics/step (measure CP-C/CP-F); cap 4 steps/tick, report `simLag`; low-end caps |
| Autosave on tab kill | ≤10 s lost | Accepted by spec; `saveNow` fired synchronously on `visibilitychange` |
| Root `package.json` `type: module` | Node default changes repo-wide | Verified: only `docs/build.mjs` and `tools/img2threejs` (own package.json) exist |
| SwiftShader E2E slowness | Flaky smoke | Demo route: LLM off, 250 cap, no shadows when `navigator.webdriver`; wait on `__poeco()`; 60 s timeouts |
| Trim analyzer on DTOs | IL2xxx fails build | Flat records with primitives, strings, and arrays only |
| Blast radius | Task edits outside manifest | Each task touches only its listed files (+ its test files); shared-file edits (Program.cs, engineLoader, GameKey×2, GameCatalog, test-all.ps1) are confined to T19/T24 |

## Verification (end-to-end)

1. `npm test` and `npm run test:coverage` (≥80 % lines on `sim/**`).
2. `dotnet build PoMiniGames.slnx` — zero warnings.
3. `dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj` → http://localhost:5080/poecosystem: fresh profile <2 s; `__poeco().creatureCount`, `.fps`; click creature → inspector; speed buttons; reload → Resume same names; `__poeco().debug('lightning'|'erupt'|'rockslide'|'massKill')` for criteria 8–10 screenshots; 390×844 device emulation; light/dark toggle.
4. WebGPU machine: LLM on → selected creature thought <15 s after model ready; nudge decays.
5. User runs `pwsh scripts/test-all.ps1` (SimJs + E2E-UI smoke) — I do not run C# tiers.
