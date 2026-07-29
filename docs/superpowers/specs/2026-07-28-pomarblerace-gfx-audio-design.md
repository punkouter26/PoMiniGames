# PoMarbleRace — GFX / Audio Elevation (top 10)

**Date:** 2026-07-28
**Status:** implemented and verified (see Verification results)
**Scope:** `src/PoMiniGames.Client/wwwroot/js/marblerace/*`, `Games/PoMarbleRace/PoMarbleRacePage.razor{,.css}`
**Guiding constraint (user-chosen):** *impact-per-frame-cost* — pick effects with the best
perceived-quality-to-GPU-cost ratio, and pay for them by first instancing the marble pack.
**Asset policy (user-chosen):** *stay zero-asset* — no new binary files. Textures stay
canvas-generated; audio stays synthesized, with `OfflineAudioContext` pre-rendering standing in
for "optimized audio buffers"; icons are inline SVG in markup.

## Starting point

PoMarbleRace is not a bare three.js scene. It already shipped ACES tone mapping, IBL from
`RoomEnvironment`, `UnrealBloomPass`, `SMAAPass`, a custom vignette + chromatic-aberration
`ShaderPass`, PCF soft shadows with texel-quantised anti-crawl, speed-reactive FOV, a GPU
spark/confetti pool, a player motion trail, contact blobs, and a procedural Web Audio graph
(speed-tracked rolling bed, crowd swell, gun, whoosh, overtake, finish, win/lose stings). The
HUD already used `backdrop-filter` glass, keyframe animation, and `prefers-reduced-motion`.

So this work is additive on top of a mature baseline. Two deviations from the original request
are deliberate and were confirmed with the user:

- **No Tailwind.** The client is native Blazor with scoped `.razor.css`; heavy component
  libraries are a standing rejection in this repo. The requested utilities (glassmorphism, blur
  filters, dynamic gradients) are delivered as scoped CSS instead.
- **No audio/image files.** See asset policy above.

### The perf finding that funds the rest — and how it actually measured

`marbles.js` built 101 individual `THREE.Mesh` objects. The 100 blue marbles shared a geometry
and a material, but were still 100 separate draw calls plus 100 nodes walked in the scene-graph
traversal every frame. `InstancedMesh` collapses that to one.

**The original "~100 draw calls saved" estimate was too optimistic.** Measured headlessly
against a git-HEAD baseline, sampling a live racing frame with `renderer.info.autoReset`
disabled (so the EffectComposer's per-pass resets don't clobber the count):

| | before | after | |
|---|---|---|---|
| draw calls | 192 | 166 | **−14%** |
| scene-graph children | 108 | 16 | **−85%** |
| triangles | 114,248 | 131,832 | **+15%** |

Only ~26 draw calls were saved, not ~100, because as separate meshes the pack was **already
frustum-culled per marble** — the track is 1800 units long and only a dozen-odd marbles are ever
on screen. The same fact explains the triangle increase: one `InstancedMesh` cannot be culled
per instance (its bounds span the whole track), so all 100 marbles are submitted every frame.
The pack's tessellation was halved (16×12 → 12×8 segments, 352 → 168 triangles per marble) to
claw most of that back — without it the count was 169,912.

Net: instancing here trades a modest triangle increase for a real draw-call and
scene-traversal reduction. Both are small in absolute terms on any real GPU.

---

## Item 1 — Instanced marble pack + per-instance velocity tint

Replace the 100 blue `Mesh` objects with a single `THREE.InstancedMesh(blueGeo, blueMat, 100)`.

Compatibility mattered: `game.js` reads `m.mesh.position` in four places (steer sparks, boost
sparks, kicker sparks, confetti), and `eliminate()` sets `m.mesh.visible = false`. Rather than
touch every call site, each blue marble keeps a **lightweight `THREE.Object3D` proxy** as its
`m.mesh` — same `position`/`quaternion`/`visible` fields, never added to the scene graph.
`sync()` writes body → proxy as before, then composes the proxy's matrix into the
`InstancedMesh` at `instanceIndex = marbleIndex - 1`.

Details that turned out to be load-bearing:

- **Instance matrices are seeded at construction.** The `pick` phase never calls `sync()`
  (`_frame` only syncs while racing or showing a result), so without seeding the whole pack
  would render stacked at the world origin while the camera frames the start gate.
- **Elimination writes a zero-scale matrix.** `visible` on a proxy is inert — there is no Mesh
  to hide.
- **The shared material's base colour is white, not blue.** `instanceColor` *multiplies* the
  material colour; a blue base would tint every per-instance colour blue twice and the speed
  tint could never reach cyan.
- `frustumCulled = false` — one draw call spanning the track has nothing to win from culling.
- The **player marble stays a real `Mesh`**: it alone casts/receives shadows and owns its
  material, trail, and blob.

**New visual this unlocks:** `instanceColor` was impossible with a shared material. Each pack
marble is now tinted by its own speed — slate at rest ramping toward cyan at pace — so the pack
shows internal velocity structure instead of 100 identical dots.

**Interface change:** `createMarbles()` returns a `group` (player mesh + instanced pack).
`game.js` adds/removes that one node instead of looping over 101 meshes.

## Item 2 — Speed-reactive radial motion blur + streaks

Folded into the **existing** `PostShader` `ShaderPass` — no new fullscreen pass, no new render
target. `uBlur` gates 6 extra taps marching back toward frame centre, so the centre (where the
marble you steer sits) stays sharp and the edges smear. `uBlur` is a uniform, so the branch is
coherent across invocations and the taps genuinely do not execute at low speed.

Driven from `scene.followTarget`, which already receives `speed` for the FOV widening. Blur
starts *later* than the FOV ramp (45 → 110 vs 25 → 90) so a mild speed reads as FOV alone. A
decaying `punchBlur()` transient rides on top, armed at the start gun and on boost-pad entry.

Streaks come free: the existing chromatic aberration offsets R and B, so reusing that split
inside the blur taps gives the smear a prismatic edge at no extra cost.

**Accessibility:** disabled entirely under `prefers-reduced-motion: reduce`.

## Item 3 — State-driven colour grading

Same shader, uniforms only. `uTint`, `uContrast`, `uSaturation` plus the pre-existing
`uVignette`. `scene.setGrade(name)` sets a target; `followTarget` eases the live values toward
it, so a grade change is always a transition, never a cut.

| Race state | Grade |
|---|---|
| `pick` (grid) | cool blue tint, desaturated, low contrast |
| `racing` | neutral (the look the game shipped with) |
| final stretch | warm tint, raised contrast, heavier vignette |
| win | brief saturation + exposure lift |
| loss / elimination | drain toward grey |

The final-stretch trigger keys off the **same 0.86 leader-progress threshold** the HUD's FINAL
STRETCH klaxon uses, so the screen and the banner warm together.

Note: `ShaderPass` *clones* the uniforms off the descriptor, so the implementation drives
`post.uniforms` — writing to `PostShader.uniforms` would mutate the module-level template and
leak between scenes.

## Item 4 — Impact shockwave rings + boost-pad light shafts

**Shockwave rings.** A pool of 8 `RingGeometry` meshes, additive, `depthWrite: false`, managed
with the same fire/age/recycle lifecycle as the existing spark pool. Fired on heavy impacts
(gated harder than the clink, at `v > 14`, so the road isn't permanently covered in them) and on
every kicker discharge.

**Boost-pad light shafts.** 12 additive cones (4 per boost band) standing on the pads, built
once in `track.js` as a **single `InstancedMesh`** — one draw call for the whole set. A
canvas-generated vertical gradient fades them out with height so the cones have no cut-off edge.
They breathe on a sine driven by `raceClock`, riding `driveMotors()` (already called once per
racing frame) rather than adding a call site — one shared material opacity, so the pulse is a
single uniform write for all twelve.

This is a **gameplay** win as much as a visual one: boost pads are the one genuinely good
surface, and a flat ribbon on the floor is invisible until you're on it. A 30-unit shaft is
readable far enough down the chute to actually steer for.

## Item 5 — Wet-tarmac road sheen

The floor was *already* `MeshPhysicalMaterial` with `clearcoat: 0.2`, so the clearcoat shader
permutation was already compiled and raising its strength costs nothing at runtime.

- `clearcoat` 0.2 → 0.55, `clearcoatRoughness` 0.7 → 0.25, `envMapIntensity` → 1.25 (the scene
  has a PMREM environment this material was barely sampling).
- A **canvas-generated normal map** (same zero-asset pattern as the existing texture singletons):
  a dome height-field of aggregate, converted to tangent-space normals by central difference,
  wrapped so it tiles. Tagged `NoColorSpace` — a normal map is data, and tagging it sRGB would
  push the packed vectors through a gamma curve and tilt every normal. `normalScale` kept at
  0.45 so it breaks the highlight up without texturing the silhouette into gravel.

**Explicitly rejected:** `MeshPhysicalMaterial.anisotropy`. Available in three r165 and it would
look good, but it compiles a *new* shader feature onto the largest surface in the scene.

## Item 6 — HUD glass refresh

Scoped CSS in `PoMarbleRacePage.razor.css`; zero GPU cost.

- **Conic-gradient speed dial** around the race clock, filling cyan → green → yellow → orange
  with the player's own speed (full scale = `BOOST_MAX_SPEED`, the engine's actual ceiling). The
  arc repaints per 10 Hz tick since a gradient isn't interpolable, but the pip riding its rim is
  a `rotate` transform with a matching transition, so the gauge reads as continuous motion.
- **Heat wash** via a `::after` pseudo-element whose **opacity** is driven by `--mr-heat` from
  leader progress. Opacity, not a background swap: gradients can't transition, opacity can, and
  it stays on the compositor so warming the HUD never contends with the WebGL loop.
- **Inline SVG icons** replacing the 🥇🥈🥉 / 🏁 / 🔥 emoji — crisp at any DPI, inherit
  `currentColor`, no emoji-font dependency or tofu fallback.
- Every new animation restricted to `transform`/`opacity`; `prefers-reduced-motion` honoured.

**Interop change:** the dial needs the *player's* speed, which `OnRaceTick` did not send (its
`speeds[]` covers only the top-6 shown, so a player outside the top 6 had no speed in the
payload at all). `mySpeed` is appended at the **end** of the positional argument list so no
existing argument shifts index. Both ends changed together.

**Culture correctness:** `SpeedPct` / `SpeedDeg` / `HeatValue` are interpolated into a `style`
attribute and are formatted with `CultureInfo.InvariantCulture`. Blazor WASM adopts the
browser's culture, and under a comma-decimal locale `"0,4"` is not a valid CSS number — the
declaration would be dropped and the gauge would silently freeze at zero.

## Item 7 — Real mixing bus (compressor + ducking)

Everything previously summed into one `master` gain and could clip. Now:

```
beds  (roll, crowd, drone) → bedBus ─┐
sfx   (clink, whoosh, …)   → sfxBus ─┼→ master → compressor → destination
                                     └→ reverbSend → convolver ─┘
```

`DynamicsCompressorNode` on the output catches transient stacking. `duck(amount, hold)` ramps
`bedBus` down and back; the gun, the win/lose sting and the finish chime call it so the beds get
out of the way. Mute is still one `setTargetAtTime` on `master`.

## Item 8 — Pre-rendered impact bank (`OfflineAudioContext`)

Eight impact variants rendered once at `ensure()` into reusable `AudioBuffer`s, each a tonal
body (pitch-dropping triangle/sine) plus a short filtered noise transient, spread across pitch,
decay and timbre. Playback is a bare `AudioBufferSourceNode` with randomised `playbackRate` —
less per-hit scheduling than the old build-an-oscillator-graph-per-clink.

Two payoffs beyond cost: variation (the single synthesized clink is exactly why repeated hits
sounded like a machine gun), and the 20 ms throttle could be relaxed to 8 ms so dense traffic
sounds dense. Rendering is async; `playClink` falls back to the original oscillator path until
the bank lands, so there is never a silent window.

## Item 9 — Stereo spatialization

`StereoPannerNode` per one-shot — deliberately not HRTF `PannerNode`, which costs far more per
node and is inaudible on laptop speakers.

`scene.audioCue(worldPos)` returns `{ pan, gain }`: pan from the position's projected NDC x
against the live camera (clamped, since NDC x is unbounded behind the camera), gain from
distance with an 0.18 floor so distant events recede but never vanish. `game.js` passes it into
`playClink`, `playWhoosh`, `playFinish` and the kicker cue. UI sounds (countdown pips, overtake,
result stings) are deliberately left unspatialized — they aren't things happening on the track.

## Item 10 — Convolution reverb + tension drone

**Reverb.** A ~1.5 s stereo impulse response generated as decaying noise straight into an
`AudioBuffer` (synchronous, zero-asset), on one `ConvolverNode` fed from a **send** so the dry
signal stays present.

**Tension drone.** Three detuned sawtooths (A2 root + a fifth) through a lowpass, with gain and
cutoff driven by the `nearFinish` value `updateBeds` already receives. It rises through the race
and **resolves** at the line — pitch steps up a fifth, filter opens, fast fade.

One bug this design required fixing: the audio context is built **once** and survives every
track regeneration, so `resolveDrone()`'s pitch step would compound race after race until the
drone was a whistle. `resetDrone()` restores the root pitch at each start gun.

---

## Verification results

Method: a headless Chromium harness (SwiftShader) serving the marblerace ES modules over a
local static server against the real CDN importmap — the game's own `wwwroot` JS is served live
from source, so no rebuild is involved. A git-HEAD copy of the same tree was measured
identically as a baseline.

**Draw calls / scene graph / triangles** — see the table above. Reported honestly: draw calls
and traversal improved, triangles regressed slightly.

**Every item engages at runtime** (observed, not asserted):

| Item | Evidence |
|---|---|
| 1 | `isInstancedMesh: true`, `count: 100`, `instanceColor` present, matrices seeded, per-instance tint varies across the pack, scene children 108 → 16 |
| 2 | Controlled pixel test: horizontal gradient energy **−28.8%** with blur held on |
| 3 | Controlled pixel test: `pick` → `final` moves mean RGB by **(−5.8, −32.9, −41.9)** — blue/green drop hard, red holds, i.e. the frame goes warm |
| 4a | 8 rings pooled; 1 visible immediately after `burstRing` |
| 4b | 12 shaft instances; material opacity observed mid-pulse (0.371) |
| 5 | `clearcoat: 0.55`, `clearcoatRoughness: 0.25`, `normalMap` present with empty (`NoColorSpace`) colour space, `envMapIntensity: 1.25` |
| 7 | `createDynamicsCompressor` called once |
| 8 | 8 `OfflineAudioContext` renders observed at startup |
| 9 | `createStereoPanner` × 38; `audioCue` returns gain 0.55 near vs 0.18 (the floor) at distance |
| 10 | `createConvolver` called once; drone oscillators constructed |

The pixel tests use a **control**: two samples with nothing changed, taken through the same
freeze-and-hand-render path, differ by (−0.09, −0.86, −0.35) RGB and +1.6% edge energy. The
treatment effects are one to two orders of magnitude larger, so they are real and not animation
noise. Pixels are read with `gl.readPixels` synchronously after a render — an earlier attempt
compared PNG screenshot *bytes*, which returns a large constant regardless of what changed and
proved nothing.

No page errors and no console errors across any run (the only 404s were the harness's own
`favicon.ico`).

`dotnet build` on the client: **succeeded, 0 warnings**.
`dotnet format --verify-no-changes` on the solution: **clean**.

### What is NOT verified

**The "net faster than today" goal is not proven.** Median frame time measured 806 ms before and
928 ms after — but that number is worthless as evidence: SwiftShader is a *software* rasteriser,
so it is dominated almost entirely by fill rate and triangle count, and it gives essentially no
weight to the draw-call and scene-traversal overhead that instancing actually removes. At
~1 FPS it is not modelling the CPU/GPU balance of a real machine. Confirming the perf goal needs
a run on real hardware; that has not been done.

## Out of scope

- Tailwind or any CSS framework adoption.
- New binary assets of any kind.
- SSAO, SSR, depth-of-field, TAA — rejected as poor impact-per-frame-cost on a scene that also
  runs a 101-body physics simulation.
- Gameplay/balance changes. The light shafts improve pad *readability* but do not alter pad
  behaviour.
- The pre-existing per-track material leak in `track.dispose()` (it disposes geometries but not
  materials). Noted, not fixed — the newly-added shaft material is disposed, but the surrounding
  issue is older than this work.
