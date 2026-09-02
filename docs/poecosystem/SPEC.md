# Specification — PoEcosystem

Status: **draft for approval** · 2026-09-02 · Lives inside the PoMiniGames solution as a new game.

## 1. Objective

A self-running 3D island ecosystem you watch from above. Grass and berry bushes grow; rabbits
and deer graze; wolves hunt in packs; a small human tribe forages, hunts, chops trees and builds
huts. Every creature ages, mates, and dies on an accelerated clock while moving at realistic
speeds, so population booms and crashes are visible within minutes. Each creature has a
personality; an optional in-browser LLM gives creatures periodic thoughts that nudge those
personalities within hard bounds. Deaths, lightning, rockslides, felled trees and volcanic
eruptions are simulated with real rigid-body physics. The world runs forever, saves itself, and
announces when only one species is left.

**Primary hook:** ecosystem dynamics — the viewer reads the system through population charts and
the event log, then zooms in on individuals to see why.

## 2. User journeys

### J1 — Watch the world (core)
1. Open `/poecosystem`. If a saved world exists: "Resume" / "New World" prompt; otherwise a new
   seeded island appears within 2 s (no LLM wait).
2. The camera sits above the island; drag to orbit/pan, wheel/pinch to zoom, touch works.
3. Population chart (bottom-left) draws one line per species; event log (right) scrolls births,
   deaths (with cause), extinctions, huts built, lightning, rockslides, eruptions.
4. Speed buttons: ⏸ / 1× / 2× / 4×. A day/night light cycle passes every ~2 minutes.
5. Leave it running. When one species remains, a "Last species standing: Wolves — year 412"
   banner appears with **Restart**; the sim keeps running underneath.

### J2 — Inspect a creature
1. Click/tap any creature. The inspector shows name, species, age (years) and life stage,
   hunger/thirst/health bars, five personality traits (with any active LLM nudge highlighted),
   current goal ("Hunting deer #217 with pack"), last thought, mother/father names.
2. The selected creature is outlined and the camera can "Follow" it.
3. The selected creature jumps to the head of the thought queue, so its next thought arrives
   within a few seconds when the LLM is on.

### J3 — Enable / choose AI thoughts
1. Settings gear → "AI thoughts" toggle (on by default if WebGPU is available; greyed with an
   explanation otherwise).
2. Model picker: SmolLM2 360M (default) / Llama 3.2 1B / Qwen3 0.6B, with download progress.
3. Until the model is ready, thoughts come from templates; the inspector marks which source
   produced the last thought.

### J4 — Provoke and recover
1. Lightning strikes a forest tile: explosion impulse throws nearby creatures into ragdolls, a
   tree falls, fire spreads through dry grass and dies at the lake edge.
2. The volcano erupts: ballistic rocks arc out and roll downhill; lava tiles creep down the
   slope and burn out; animals and humans flee the area for a while.
3. Humans, short of housing, chop a tree (it falls with physics), carry logs home, and a new
   hut appears in the village.

## 3. Tech stack

| Layer | Choice | Version | Notes |
|-------|--------|---------|-------|
| Host | Blazor WebAssembly in PoMiniGames.Client | .NET 10 SDK 10.0.203 | Existing host, `GameShell`, theming tokens, PWA |
| 3D | three.js | 0.165.0 | Already pinned in `index.html` import map |
| Physics | cannon-es | 0.20.0 | Already in import map; PoBrawl `ragdollPhysics.js` is the reference |
| Sim | Plain JS ES modules | ES2022 | Served from source, no bundler (repo convention) |
| LLM | @mlc-ai/web-llm | 0.2.84 (CDN, as PoSurvive) | Models: `SmolLM2-360M-Instruct-q4f16_1-MLC` (default, 376 MB VRAM), `Llama-3.2-1B-Instruct-q4f16_1-MLC` (879 MB), `Qwen3-0.6B-q4f16_1-MLC` (1.4 GB). JSON-schema output via `response_format:{type:'json_object',schema}` |
| JS tests | Vitest | 4.1.11 | Node 24.18 present; `package.json` at repo root (`private: true`) |
| C# tests | xUnit + Playwright | existing | One E2E-UI smoke test |
| Storage | IndexedDB (world), localStorage (prefs) | browser | No server, no auth, no API slice |

No Radzen or other component library (repo CLAUDE.md ban; bundle budget 25 MB).

## 4. Commands

```powershell
dotnet build PoMiniGames.slnx                                  # build (warnings are errors)
dotnet format PoMiniGames.slnx                                 # C# format
npm install                                                    # one-time, root package.json
npm test                                                       # Vitest sim tests (fast, hermetic)
npm run test:coverage                                          # Vitest + v8 coverage (target ≥80% lines on sim/**)
pwsh scripts/test-all.ps1                                      # full tiered run incl. new 'SimJs' tier
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj  # http://localhost:5080/poecosystem
```

## 5. Project structure

```
src/PoMiniGames.Client/
  Games/PoEcosystem/
    PoEcosystemPage.razor(.css)          @page "/poecosystem", "/poecosystem/{Mode}"; GameShell + intro
    PoEcosystemViewer.razor(.cs,.css)    canvas host, panel layout, interop wiring
    Components/
      InspectorPanel.razor(.css)         J2
      PopulationChart.razor(.css)        native SVG line chart (no chart lib)
      EventLog.razor(.css)
      SettingsPanel.razor(.css)          LLM toggle, model picker, seed, New World
      SpeedControls.razor(.css)
      EndBanner.razor(.css)
    Models/                              DTOs mirrored from JS snapshot (WorldStats, CreatureDetail, WorldEvent, LlmStatus)
    Services/PoEcosystemInteropService.cs
  wwwroot/js/poecosystem/
    index.js                             registers window.PoEcosystem (engineLoader contract)
    host/simHost.js                      spawns sim worker; main-thread fallback
    host/simWorker.js                    worker entry: owns World + physics
    sim/world.js                         composition root: step(dt), snapshot(), applyCommand()
    sim/core/    sim/terrain/  sim/flora/  sim/creatures/  sim/behavior/
    sim/physics/ sim/events/   sim/thoughts/  sim/persistence/
    thoughtWorker.js                     WebLLM engine in its own worker
    render/                              three.js renderer, meshes, camera, picking
tests/PoEcosystem.Sim/**/*.test.js       Vitest (mirrors sim/ layout)
tests/PoMiniGames.E2EUI/PoEcosystemUiTests.cs
docs/poecosystem/{SPEC,CAPABILITY-MAP}.md
tasks/poecosystem/{plan,todo}.md
package.json, vitest.config.js           repo root
```

Shared files touched (following existing patterns): `Models/GameKey.cs`, `Domain/Primitives/GameKey.cs`,
`Models/GameCatalog.cs`, `wwwroot/js/engineLoader.js` (REGISTRY entry), `scripts/test-all.ps1`
(SimJs tier), `.gitignore` (already ignores `node_modules/`, `coverage/`).

## 6. Code style

Sim modules are pure, data-oriented, and take explicit dependencies (no globals):

```js
// sim/creatures/drives.js
import { clamp01 } from '../core/math.js';

/**
 * Advance one creature's drives by dt seconds. Pure: mutates only `c`.
 * Hunger/thirst rise linearly; starvation damage begins above 0.9.
 */
export function stepDrives(c, species, dt) {
  c.hunger = clamp01(c.hunger + species.hungerRate * dt);
  c.thirst = clamp01(c.thirst + species.thirstRate * dt);
  c.age += dt / YEAR_SECONDS;
  if (c.hunger > 0.9 || c.thirst > 0.9) c.health -= species.starveDamage * dt;
  return c;
}
```

Conventions: 2-space indent in JS (matches `wwwroot/js/**`), single quotes, ES modules with
explicit `.js` extensions; C# follows `.editorconfig`; comments only where a real constraint
needs recording (repo style). Every tunable number lives in `sim/core/config.js`.

## 7. Simulation rules (normative)

### 7.1 Time
- Fixed sim step 50 ms (20 Hz); render at device rate; speed multiplier ∈ {0, 1, 2, 4}.
- `YEAR_SECONDS = 30` (real seconds at 1×). Ages display in years. Light cycle `DAY_SECONDS = 120`
  (cosmetic; not tied to years).
- Movement is in metres per real second on a 200 × 200 m island (1 tile = 1 m).

### 7.2 Species

| Species | Max age (y) | Mature (y) | Speed walk/run (m/s) | Eats | Gestation (s) | Litter |
|---------|-------------|------------|----------------------|------|---------------|--------|
| Rabbit | 6 (≈3 min) | 1 | 3 / 6 | grass, berries | 20 | 2–4 |
| Deer | 12 (≈6 min) | 2 | 4 / 8 | grass, berries | 30 | 1–2 |
| Wolf | 12 (≈6 min) | 2 | 4.5 / 9 | rabbit, deer, carcass | 30 | 2–3 |
| Human | 24 (≈12 min) | 4 | 1.5 / 3 | berries, rabbit, deer, carcass | 40 | 1 |

Start population: 40 rabbits, 20 deer, 6 wolves, 8 humans + 3 huts. Hard cap 400 creatures
(births suppressed above cap). Old age death is probabilistic after 85% of max age.

### 7.3 Drives and death
Hunger, thirst ∈ [0,1] rise at species rates (starvation ≈ 75 s, dehydration ≈ 50 s from
empty). Health drains above 0.9 on either. Causes of death recorded: starvation, dehydration,
old age, predation, fire, lightning, rockfall, eruption, drowning (never enter deep water).

### 7.4 Personality and genetics
Five traits ∈ [0,1]: **boldness** (approach threats/predators), **sociability** (herd/pack
cohesion), **curiosity** (explore vs. exploit memory), **greed** (eat past satiety, hoard),
**diligence** (humans: chop/build/hunt persistence; animals: foraging persistence).
Offspring trait = mean(parents) + N(0, 0.08), clamped. Names from species-themed syllable
tables; unique within a run.

### 7.5 Behaviour (utility AI)
Each tick a creature scores goals — `Eat`, `Drink`, `Flee`, `Hunt`, `Mate`, `FollowParent`,
`ReturnHome`, `Chop`, `Build`, `Wander`, `Rest` — from drives × traits × perception and takes
the max. Perception radius per species; deer alert the herd, rabbits scatter, wolves in a pack
(sociability-weighted) converge on the pack leader's target and share the kill. Memory stores
last-known food/water positions with decay; home range = spawn point (animals) or hut (humans).
Juveniles follow a parent until mature; orphans have +50% hunger rate. Humans return to their
hut at night; when beds < tribe size and `diligence` is high, a human chops the nearest tree
(3 logs → 1 hut placed on grassland near the village).

### 7.6 Flora
Grass is a per-tile biomass [0,1] regrowing logistically (faster on grassland, none on sand/
rock). Berry bushes ripen over 40 s and are stripped on eating. Trees (forest tiles) have
health; they can be chopped or burnt; fallen trees become logs; forests reseed slowly.

### 7.7 Physics and events (cannon-es)
- Terrain is a `Heightfield` collider; living creatures are **not** rigid bodies.
- **Death → ragdoll**: quadruped (body, head, 4 legs; 6 boxes, `ConeTwistConstraint`s) or
  biped (PoBrawl-style 11 boxes, simplified to 7). Spawned from the visual pose; runs ≤ 8 s,
  then frozen as a carcass that wolves/humans can eat for 60 s.
- **Felled tree**: trunk becomes a dynamic box hinged at the stump for 1 s, then free; settles
  into a log (static after rest).
- **Rockslide** (natural, hills/mountain): 3–8 spheres/boxes with random impulse from a ridge
  tile. Kills are decided deterministically by the sim, not by physics contacts: each rock's
  impact point is computed analytically (parabola marched against the heightmap) plus a downhill
  corridor; creatures within 1.5 m of the impact at impact tick, or on corridor tiles during the
  roll window, die of `rockfall`. The cannon-es rock gets the same launch velocity so it visibly
  lands near that point. Settled rocks persist 120 s as obstacles (obstacle tiles come from the
  corridor end, not body rest poses). This keeps success criterion 4 (determinism) intact while
  physics stays real for everything the viewer sees.
- **Lightning**: random strike every 90–240 s: radial impulse (radius 6 m, ∝ 1/r), creatures in
  radius die → ragdoll launched; trees within 3 m fall; ignites tile.
- **Volcano**: one mountain tile; erupts every 4–8 min: explosion + 8–15 ballistic rocks, lava
  tiles creep downhill 30 s then cool to rock; fear source radius 40 m.
- **Fire**: cellular spread over grass/forest tiles with p = 0.35/s to flammable neighbours,
  burns 6 s, cannot cross water/sand/rock; kills creatures on burning tiles; burnt grass regrows.
- Event scheduler guarantees ≥ 45 s between any two natural events.

### 7.8 Thought engine
- WebLLM in `thoughtWorker.js`, model cached by WebLLM (Cache API). WebGPU absent → engine
  disabled, banner in settings, templates only.
- One inference in flight; queue = round-robin over living creatures; selected creature
  preempts. Prompt ≤ 600 chars: species, name, traits, drives, nearest food/water/threat/kin,
  last 2 events involving it.
- Output schema (enforced by WebLLM + re-validated): `{thought, trait, delta}`; `delta` clamped
  to [-0.25, 0.25]; nudge decays linearly to 0 over 60 s; one active nudge per creature (newer
  replaces older). Invalid output → templated thought, no nudge.
- Template thoughts (no LLM) chosen from `(species, dominant drive, dominant trait)` tables;
  they never apply nudges.

### 7.9 Persistence
- Autosave full world (terrain seed + all entity/tile state + physics props' resting poses +
  event scheduler + RNG state) to IndexedDB every 10 s and on `visibilitychange`. Snapshot
  carries `schemaVersion`; mismatch → discard and offer New World.
- Prefs in localStorage: LLM enabled, model id, speed, last seed.

## 8. UI

- Panels are native Blazor components styled with the repo's CSS tokens (light/dark automatic).
- Desktop: chart bottom-left, event log right, inspector left (when selected), settings gear
  top-right, speed controls top-centre, world clock (year/day) top-left.
- ≤ 768 px: panels collapse into a bottom sheet with tabs (Chart / Log / Inspector / Settings);
  touch orbit/pan/zoom; creature cap lowered to 250 on `navigator.hardwareConcurrency ≤ 4`.
- Keyboard: all panels tab-navigable, buttons have `aria-label`s, chart has a text summary
  (`aria-live="polite"` population counts). `prefers-reduced-motion` disables UI transitions
  only.
- `GameShell` provides the "needs 3D graphics" fallback when WebGL2 is unavailable.

## 9. Testing strategy

| Tier | Framework | Scope | Gate |
|------|-----------|-------|------|
| SimJs (new) | Vitest 4.1 | Modules 1–8, hermetic, no DOM; cannon-es runs in Node | ≥ 80% line coverage on `wwwroot/js/poecosystem/sim/**`; runs first in `test-all.ps1`; **not** counted against the 100/50/25/25 ceilings (JS, not xUnit) |
| E2E-UI | Playwright (existing tier, 16 free slots) | `PoEcosystemUiTests.Demo_WorldIsAlive`: page loads with SwiftShader GL, `window.__poeco` reports > 0 creatures after 10 s, clicking the canvas centre-most creature opens the inspector | 1 method |
| Build | `dotnet build` | trim analyzer, warnings-as-errors | must pass |
| Manual | checklist in `tasks/poecosystem/plan.md` | renderer, physics look, mobile | evidence in Phase 5 |

TDD per task: failing Vitest → minimal code → `npm test` → `dotnet build` → commit.
Per the standing rule, I do not run the C# test tiers; the user runs them.

## 10. Boundaries

**Always:** follow existing solution patterns (GameShell, GameCatalog, engineLoader REGISTRY,
interop service shape, CSS tokens); commit locally per task; keep every tunable in `config.js`;
keep the sim usable with the LLM off.

**Ask first:** nothing routine — the user chose "do all and follow current sln patterns".
Only real blockers, spec gaps, or irreversible actions (push/tag, deleting data, deploy, secrets).

**Never:** add Radzen or any component library; add an API slice / server state / auth gate;
push or tag; edit existing tests or CI workflow beyond adding the new tier line to
`test-all.ps1`; let LLM output reach the sim unclamped; exceed the 25 MB WASM budget (this
game adds ~0 to it — all JS).

## 11. Out of scope (v1)

Multiplayer/SignalR/shared worlds; leaderboards; server-side persistence; GLB assets;
farming/tech tree; genetics beyond trait blending; weather beyond lightning; seasons;
WebGPU rendering; save-file export/import UI; god-mode toolbar (natural + human + volcano
triggers only).

## 12. Edge cases and error states

| Case | Behaviour |
|------|-----------|
| No WebGL2 | `GameShell` fallback panel; nothing else loads |
| No WebGPU | LLM toggle disabled with reason; templates only |
| Model download fails / CDN blocked | toast + fall back to templates; retry button |
| LLM returns invalid JSON / out-of-range delta | discard, count in diagnostics, template thought |
| Worker unsupported / crashes | sim restarts on main thread from last autosave; toast |
| Saved snapshot schema mismatch or corrupt | discard, New World prompt |
| Population hits 400 cap | births suppressed; log entry "Island is full" |
| All creatures dead | banner "The island is silent — year N", Restart |
| Tab hidden | sim pauses (no catch-up burst), autosave on hide |
| Mobile low-end | creature cap 250, shadows off, physics substeps 1 |
| Seed field invalid | coerce via string hash; show effective seed |

## 13. Success criteria (measurable)

1. `npm test` passes with ≥ 80% line coverage on `sim/**`.
2. `dotnet build PoMiniGames.slnx` succeeds (zero warnings).
3. `/poecosystem` renders a populated island within 2 s of the Blazor page mounting on a fresh
   profile (no saved world, LLM off).
4. With a fixed seed, two fresh runs produce identical population counts at tick 6000 (5 min at 1×)
   with the LLM off — determinism.
5. Over a 15-minute default run (LLM off, seed 1..5), at least one species shows a visible
   boom-bust (peak ≥ 1.5× trough) and no species goes extinct before minute 5 in ≥ 4 of 5 seeds.
6. ≥ 30 fps on a mid laptop iGPU at 400 creatures with ≥ 20 active physics bodies (measured
   via the debug handle `window.__poeco.fps`).
7. Clicking a creature opens the inspector with name, species, age, drives, five traits, goal,
   last thought, and parents within 200 ms.
8. Population chart and event log update live; extinctions and "last species standing" banner
   appear when triggered (verified by a scripted mass-kill via the debug handle).
9. Death produces a ragdoll that comes to rest in ≤ 8 s; a felled tree comes to rest; lightning
   launches creatures; volcano rocks follow ballistic arcs and roll downhill (video/screenshots).
10. Fire spreads across grass/forest and stops at water/sand (screenshot sequence).
11. With WebGPU available and LLM on, the selected creature receives an LLM-sourced thought within
    15 s of selection (after model load); a nudge appears in the inspector and decays to 0 in
    60 s; `delta` never exceeds ±0.25 (asserted in tests and diagnostics counter).
12. Reload resumes the same world (same creature names/ages continue) after an autosave; New World
    with a typed seed reproduces the same terrain.
13. E2E-UI `PoEcosystemUiTests` passes; E2E-UI method count ≤ 25.
14. Works at 390 × 844 viewport: bottom-sheet tabs, touch orbit/zoom, no horizontal scroll.
15. Light and dark themes: no raw hex in the game's CSS (grep gate).

## 14. Open questions

1. Ambient audio: include a minimal loop via `audioBus.js` only if it fits in the UI task without
   a new dependency; otherwise deferred (assumption #8).
2. Exact human ragdoll: reuse PoBrawl's 11-part rig or the simplified 7-part biped — decided at
   task time by what the primitive human mesh needs.
