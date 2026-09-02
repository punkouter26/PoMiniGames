# PoEcosystem — Todo

Rule: one task = RED → GREEN → `npm test` → `dotnet build PoMiniGames.slnx` → commit → tick.
A task touches only the files in its manifest (see `plan.md`) plus its own test files.

## Pre-build
- [x] SPEC.md + CAPABILITY-MAP.md approved
- [x] plan.md approved (plan mode)
- [x] Top-50 libraries presented; 7 selected + integrated (Blazored.LocalStorage, Mapperly, NSubstitute, bUnit tier, ReportGenerator, Vitest+ESLint, Husky.Net); top-10 usage examples: pending
- [ ] /design: 10 layout concepts; one chosen; component hierarchy confirmed

## Build
- [x] T1  Vitest tooling — `package.json`, `vitest.config.js`, `eslint.config.js`, smoke test
- [ ] T2  Sim core — config, prng, clock, entities, events
- [ ] T3  Terrain — noise, island, tiles, pathing
- [ ] CP-A
- [ ] T4  Creatures A — species, drives, lifecycle
- [ ] T5  Creatures B — traits, genetics, names
- [ ] T6  Flora — grass, bushes, trees
- [ ] CP-B
- [ ] T7  Behavior A — spatial, memory, steering, utility
- [ ] T8  Behavior B — social, humans
- [ ] T9  World composition — world.js, frame.js (determinism + LONG population test)
- [ ] CP-C (tune config.js)
- [ ] T10 Physics — world, ragdoll, rocks, fallingTree, explosion
- [ ] T11 Events A — scheduler, lightning, rockslide
- [ ] T12 Events B — volcano, fire
- [ ] CP-D
- [ ] T13 Thoughts — scheduler, prompt, templates, nudges
- [ ] T14 Persistence — snapshot, idb, prefs
- [ ] T15 Host runtime — simRuntime, simWorker, simHost, index.js
- [ ] CP-E
- [ ] T16 Thought worker — thoughtWorker.js, thoughtBridge.js
- [ ] T17 Renderer A — renderer, terrainMesh, camera, lighting
- [ ] T18 Renderer B — creatureMeshes, propMeshes, floraMeshes, picking
- [ ] CP-F (record fps, screenshots)
- [ ] T19 Interop + registry — InteropService, DTOs, Program.cs, engineLoader
- [ ] T20 Page + viewer
- [ ] T21 Chart + speed
- [ ] T22 Log + inspector
- [ ] T23 Settings, banner, mobile
- [ ] T24 Catalog + tiers — GameKey ×2, GameCatalog, E2E-UI test, test-all.ps1
- [ ] CP-G

## Verify (Phase 5)
- [ ] `npm run test:coverage` ≥ 80 % on sim/**
- [ ] /code-review — fix Critical/Important
- [ ] /security-review — fix Critical/Important
- [ ] /simplify — re-run `npm test`
- [ ] Evidence for success criteria 1–15 (SPEC §13)
- [ ] Recap
