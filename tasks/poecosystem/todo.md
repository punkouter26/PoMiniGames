# PoEcosystem — Todo

Rule: one task = RED → GREEN → `npm test` → `dotnet build PoMiniGames.slnx` → commit → tick.
A task touches only the files in its manifest (see `plan.md`) plus its own test files.

## Pre-build
- [x] SPEC.md + CAPABILITY-MAP.md approved
- [x] plan.md approved (plan mode)
- [x] Top-50 libraries presented; 7 selected + integrated (Blazored.LocalStorage, Mapperly, NSubstitute, bUnit tier, ReportGenerator, Vitest+ESLint, Husky.Net); top-10 usage examples: pending
- [x] /design: 10 layout concepts → user chose first-person god view + HUD concept C (2026-09-02); component hierarchy confirmed 2026-09-02

## Build
- [x] T1  Vitest tooling — `package.json`, `vitest.config.js`, `eslint.config.js`, smoke test
- [x] T2  Sim core — config, prng, clock, entities, events (17 tests)
- [x] T3  Terrain — noise, island, tiles, pathing (8 tests; walkable 0.48–0.56 on seeds 1–8)
- [x] CP-A — 25 tests green, coverage 88 % lines, terrainHash(7) identical across two Node processes
- [x] T4  Creatures A — species, drives, lifecycle (9 tests)
- [x] T5  Creatures B — traits, genetics, names (6 tests)
- [x] T6  Flora — grass, bushes, trees (4 tests; sliced regrowth)
- [x] CP-B — creatures 100 %, flora 99 % lines; Math.random absent from sim/ (ESLint gate)
- [x] T7  Behavior A — spatial, memory, steering, utility (8 tests)
- [x] T8  Behavior B — social, humans (8 tests)
- [x] T9  World composition — world.js, frame.js (7 tests; determinism at tick 6000 passes; 0.13–0.76 ms/tick)
- [x] CP-C — LONG population gate passes (4/5 seeds boom-bust, no extinction < 5 min); tuned species/utility/world (see SPEC §7.2 note)
- [x] T10 Physics — world, ragdoll, rocks, fallingTree, explosion (8 tests; cannon-es heightfield verified to 6 mm)
- [x] T11 Events A — scheduler, lightning, rockslide (6 tests; corridor kills identical cannon vs null)
- [x] T12 Events B — volcano, fire (6 tests)
- [x] CP-D — every event on, cannon vs null identical at tick 3000; 87 tests, 95 % lines
- [x] T13 Thoughts — scheduler, prompt, templates, nudges (6 tests)
- [x] T14 Persistence — snapshot, idb, prefs (5 tests; exact round trip incl. events, thoughts, plans)
- [x] T15 Host runtime — simRuntime, simWorker, simHost, index.js (6 tests)
- [x] CP-E — LLM-off feature complete headless; snapshot exact; protocol tests pass (104 tests)
- [x] T16 Thought worker — thoughtWorker.js, thoughtBridge.js (6 tests; manual browser check pending at CP-F)
- [x] T17 Renderer A — renderer, terrainMesh, playerController (9 tests), lighting, input
- [x] T18 Renderer B — creatureMeshes, propMeshes, floraMeshes, picking, minimap (browser check at CP-F)
- [x] CP-F — browser verified: world renders, walk/fly/pick/inspector/dashboard/eruption work; fps only measurable under SwiftShader software GL here (see recap)
- [x] T19 Interop + registry — InteropService, DTOs, Program.cs, engineLoader
- [x] T20 Page + viewer
- [x] T21 HUD — sparkline, speed/clock bar, event toasts
- [x] T22 Inspector popover + Tab dashboard overlay (chart, log)
- [x] T23 Settings, banner, touch fallback
- [x] T24 Catalog + tiers — GameKey ×2, GameCatalog, E2E-UI test (11/25 methods), test-all.ps1
- [x] CP-G — build 0 warnings, hex grep 0, E2E-UI 11/25, SimJs+Component tiers wired

## Verify (Phase 5)
- [x] `npm run test:coverage` — 97.2 % lines on sim/** (target 80 %)
- [x] /code-review (high) — 8 findings, all fixed
- [x] /security-review — no findings at reportable confidence (no server surface, no raw-HTML rendering)
- [x] /simplify — 4 review agents, ~30 fixes applied; 127 tests still green
- [x] Evidence for success criteria 1–15 (see recap; 11 unverifiable here — no WebGPU)
- [x] Recap
