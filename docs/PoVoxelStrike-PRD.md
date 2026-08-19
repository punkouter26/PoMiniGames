do # PoVoxelStrike — Product Requirements Document

**Version 1.0 — 2026-08-18 — FINAL (all elicitation rounds locked)**
**Platform:** PoMiniGames (.NET 10 Minimal API host + Blazor WebAssembly client, single origin, port 5000)

---

## 1. Executive Summary & Core Objectives

### Problem statement

Browser games rarely offer meaningful environmental destruction: the world is static scenery, and the player's only verb is "shoot the enemy." PoVoxelStrike inverts that. It is a third-person endless-survival shooter in which the **environment is the weapon**: every imported 3D asset becomes a fully destructible, physics-governed voxel structure. The player survives by carving supports out from under structures and dropping them onto pursuing enemies — while the same falling debris can crush the player.

### Scope (v1)

- A new self-contained mini-game in the existing PoMiniGames catalog, working name **PoVoxelStrike**.
- **Single-player, endless survival.** No campaign, no waves-with-a-win, no multiplayer.
- **Server-side GLB → voxel ingestion pipeline**: on API startup, a background job scans a drop folder, voxelizes any GLB whose content hash has not been converted yet, and persists compact binary voxel volumes to disk.
- **Client-side simulation**: Three.js rendering + Rapier.js physics run the full 60 FPS game loop inside the browser. Blazor WASM is the application shell, HUD, and lifecycle orchestrator only.
- **Score-only persistence**: the .NET backend stores best score and run statistics via the existing `HighScoreDescriptor<T>` leaderboard pattern in Azure Table Storage. A run that ends is gone; there are no save games.

### Target audience

- Existing PoMiniGames players (signed-in Entra users and guests) looking for a 5–15 minute instant-play session.
- The repo owner as level author: dropping GLB files into a folder is the entire content pipeline — no editor, no build step.

### Success criteria

| Objective | Measure |
|---|---|
| Instant play | First playable frame ≤ 5 s on warm cache, ≤ 15 s cold on broadband |
| Destruction is the core verb | ≥ 30 % of enemy kills in playtests come from debris crushes, not direct fire |
| Performance holds under chaos | 60 FPS sustained on a mid-range desktop with caps saturated (150 rigidbodies, 2000 particles) |
| Zero-touch content pipeline | A new GLB dropped in the folder appears in-game after one API restart with no manual step |
| Platform fit | Ships inside existing gates: 25 MB WASM `_framework` budget, trim audit, test-count ceilings |

### Locked architectural decisions (elicitation record)

| Area | Decision |
|---|---|
| Game mode | Endless survival; score to leaderboard; loss = player death |
| Structural model | Load-bearing / stress simulation (mass distribution + material strength thresholds), not pure connectivity flood-fill |
| Ingestion | Server-side (.NET), startup scan, SHA-256 content-hash dedup, fixed detail (longest axis = 64 voxels) |
| Voxel delivery | Single binary stream per asset; immutable HTTP caching; `IEndpointFilter` validation |
| Persistence | Score + run stats only, via `HighScoreDescriptor<T>` |
| Client shell | Blazor WASM = shell/HUD; Three.js + Rapier.js = render/physics loop |
| Interop | Throttled coarse-grained event bus, 10–20 Hz, `[JSInvokable]` lifecycle events only |
| Input | Pointer Lock owned by the canvas during play; Blazor overlays on pause/menu |
| Player kit | One gun, two fire modes (rapid carve / explosive alt-fire); debris damages enemies **and** the player |
| Enemies | Three archetypes: Swarmer, Brute, Spitter |
| World | Flat procedural ground; imported assets scattered randomly per run (seeded) |
| Perf strategy | Hard caps + hierarchical attrition (rigidbody → particle → dissolve); no auto quality scaling in v1 |
| Client asset cache | Browser Cache API keyed by content hash |
| Auth | Platform standard: Entra (BFF cookie) + guest; guest scores parked in `PendingScoreStore` until sign-in |

---

## 2. Feature Breakdown & User Stories

### F1 — GLB asset ingestion (server)

*As the level author, I drop GLB files into a folder so that they appear as destructible structures without any manual conversion.*

- **Given** a GLB file exists in the drop folder and no `.pvx` output exists for its SHA-256 content hash, **when** the API starts, **then** a background job voxelizes it (longest axis = 64 voxels) and writes `<hash>.pvx` to the converted-assets folder before the job completes.
- **Given** a GLB whose content hash already has a `.pvx` file, **when** the API starts, **then** the file is skipped and no CPU is spent re-converting it.
- **Given** a malformed or unreadable GLB, **when** ingestion runs, **then** the failure is logged with the file name and reason, the file is skipped, and ingestion of the remaining files continues (per-file failures are never fatal to boot).
- **Given** ingestion is still running, **when** a client requests the asset manifest, **then** the manifest returns only fully converted assets (partially written files are never served; output is written to a temp name and atomically renamed).
- **Given** the drop folder is empty or missing, **when** the API starts, **then** the game still boots and the world generator falls back to procedural primitives only, with a logged warning.

### F2 — Voxel asset delivery (API)

*As the game client, I fetch a manifest and binary voxel volumes so that I can build the world.*

- **Given** converted assets exist, **when** the client calls `GET /api/povoxelstrike/assets`, **then** it receives a JSON manifest listing each asset's content hash, display name, voxel dimensions, byte size, and URL.
- **Given** a valid hash, **when** the client calls `GET /api/povoxelstrike/assets/{hash}`, **then** the server streams the `.pvx` binary with `Cache-Control: public, max-age=31536000, immutable` and `ETag: "<hash>"`.
- **Given** a hash that fails the format check (not 64 lowercase hex chars) or matches no file, **when** requested, **then** the endpoint returns RFC 7807 `ProblemDetails` with 400 or 404 respectively (validated by an `IEndpointFilter` before the handler runs).

### F3 — World generation (client)

*As a player, every run gives me a fresh arena so that no two runs play the same.*

- **Given** a new run starts, **when** the world builds, **then** a flat procedural ground plane is generated and every manifest asset is instantiated one or more times at seeded-random positions and yaw rotations, with a minimum spacing constraint so structures never interpenetrate at spawn.
- **Given** the same seed, **when** two runs start, **then** the scatter layout is identical (seeded PRNG; the seed is generated client-side per run and shown on the game-over screen).
- **Given** the manifest is empty, **when** a run starts, **then** the generator places procedural primitive structures (towers, walls) so the game remains playable.

### F4 — Combat: one gun, two fire modes

*As the player, I carve the world and drop it on enemies.*

- **Given** active play with primary-fire ammo policy (unlimited, heat-limited), **when** I hold primary fire, **then** rapid projectiles carve a small spherical volume (radius ≈ 1.5 voxels) at each impact point on any voxel structure or dynamic cluster.
- **Given** alt-fire is off cooldown (≈ 5 s), **when** I trigger alt-fire, **then** a slow projectile detonates on impact, carving a large spherical volume (radius ≈ 6 voxels) and applying a radial impulse to nearby dynamic bodies and enemies.
- **Given** a projectile hits an enemy directly, **then** the enemy takes direct-fire damage (primary: light; alt: heavy area).
- **Given** sustained primary fire past the heat ceiling, **then** the weapon locks out for a short cooldown; the HUD shows heat continuously.

### F5 — Destruction, stress, and attrition

*As the player, structures fail believably when I cut their supports.*

- **Given** a carve removes voxels from a static structure, **when** the stress solver re-evaluates the affected region, **then** any voxel cluster whose supported load exceeds the compressive/tensile strength budget of its remaining connections — or which has no load path to the ground at all — detaches and becomes a Rapier dynamic rigidbody with mass derived from its voxel count and material density.
- **Given** a dynamic cluster is struck again (projectile or hard impact), **when** its size is above the fragmentation floor, **then** it splits hierarchically into smaller clusters; below the floor it converts to transient particle debris.
- **Given** the active rigidbody count exceeds **150**, **when** the next physics tick runs, **then** the oldest/smallest clusters are demoted to particles until the cap holds; **given** particles exceed **2000**, the oldest fade out and dissolve. Attrition is deterministic and identical on every machine.
- **Given** a dynamic cluster lands on an enemy or the player with sufficient momentum, **then** crush damage proportional to mass × impact velocity is applied — debris is impartial.
- **Given** a cluster comes to rest and survives ≈ 10 s without further impact, **then** it freezes to a static obstacle (sleeps) to reclaim simulation budget.

### F6 — Enemies

*As the player, I face three readable archetypes that respect and react to the changing world.*

| Archetype | Role | Movement | Attack | Structural behaviour |
|---|---|---|---|---|
| **Swarmer** | Pressure | Fast, ground | Melee lunge | Flows around debris; cannot break voxels |
| **Brute** | Siege | Slow, ground | Heavy melee | Carves through structures blocking its path to the player |
| **Spitter** | Area denial | Medium, keeps distance | Ranged projectile (also carves a tiny volume) | Repositions to keep line of sight |

- **Given** the pathfinding graph changes because voxels were destroyed or debris came to rest, **when** an enemy replans (staggered, budgeted per frame), **then** it routes around or over the new geometry.
- **Given** the stress solver flags a structure as critically strained, **when** an enemy is inside its predicted fall zone, **then** the enemy attempts to evacuate the zone (threat perception) — killable, but not free.
- **Given** elapsed survival time, **when** the spawn director ticks, **then** spawn rate and archetype mix escalate on a continuous curve (no wave breaks); spawns occur at map-edge points outside the player's view frustum.

### F7 — Survival loop, scoring, and game over

- **Given** the player's HP reaches 0 (from enemy attacks or debris crush), **when** death resolves, **then** the run ends, the canvas freezes into a brief kill-cam, and the Blazor game-over overlay appears with the run summary.
- **Given** a completed run, **then** `score = floor(survivalSeconds) × 10 + kills × 25 + bruteKills × 50 + crushKills × 40 + voxelsDestroyed ÷ 20`, computed in the JS engine and reported once in the game-over event.
- **Given** a signed-in player with a finished run, **when** the client submits the result, **then** the server persists it only if it beats the player's stored best score (`ShouldOverwrite` on the descriptor).
- **Given** a guest or an offline player, **when** the run ends, **then** the result is parked in `PendingScoreStore` (localStorage) and flushed by `ScoreSyncService` on sign-in / reconnect — the platform-standard durable submission path. A parked score is never lost.

### F8 — Leaderboard

- **Given** any visitor (anonymous included), **when** they open the PoVoxelStrike leaderboard, **then** they see the top-N best runs: player name, score, survival time, kills, voxels destroyed, date.
- **Given** the platform leaderboard hub, **then** PoVoxelStrike appears alongside the other games using the same shared leaderboard UI conventions (column labels, virtualized list).

### F9 — Shell, HUD, and lifecycle (Blazor)

- **Given** the player opens the game page, **then** Blazor renders the pre-game screen (title, best score, asset-load progress, Play button) while assets stream in the background.
- **Given** active play, **when** the JS engine pumps its throttled HUD event (10–20 Hz), **then** the Blazor HUD overlay re-renders HP, weapon heat, alt-fire cooldown, score, elapsed time, and kill count. No per-frame interop ever occurs.
- **Given** active play, **when** the player presses `Esc` (or pointer lock is lost, e.g. tab switch), **then** the engine pauses the simulation, releases pointer lock, and Blazor shows the pause overlay (Resume / Restart / Quit). Pointer-lock loss for any reason **always** pauses — the player is never killed while unable to steer.
- **Given** the pause overlay, **when** the player clicks Resume, **then** Blazor calls the engine's resume function, which re-acquires pointer lock and unfreezes the simulation.
- **Given** navigation away from the page, **then** the Blazor component's `DisposeAsync` calls the engine's dispose function, which tears down the render loop, physics world, GPU resources, and event listeners (verified: no orphaned `requestAnimationFrame` after unmount).

### F10 — Client asset caching (PWA)

- **Given** a voxel binary is fetched for the first time, **when** the response arrives, **then** the client stores it in the browser **Cache API** in a dedicated `povoxelstrike-assets` cache, keyed by its content-hash URL.
- **Given** a subsequent run, **when** the same hash is requested, **then** it is served from the Cache API with no network round trip (content hash ⇒ immutable ⇒ no revalidation needed).
- **Given** a manifest that no longer contains a previously cached hash, **when** the game finishes loading, **then** stale entries are evicted from the cache.
- **Given** the device is offline and all manifest assets are cached, **then** a full run is playable offline; the score parks locally per F7.

---

## 3. Domain Model & Bounded Contexts

Three bounded contexts. Only two live on the server; the Gameplay context is deliberately client-only and ephemeral — the server has **no** knowledge of in-run world state.

### 3.1 Asset Ingestion context (server — `Features/PoVoxelStrike` + `AssetPipeline`)

**Aggregate: `VoxelAsset`** — identity is the **SHA-256 content hash** of the source GLB bytes (rename-proof, edit-sensitive).

| Member | Notes |
|---|---|
| `ContentHash` (id) | 64-char lowercase hex |
| `DisplayName` | Source file name without extension |
| `Dimensions (X,Y,Z)` | Voxel grid extents, longest = 64 |
| `PayloadPath` / `SizeBytes` | Converted `.pvx` on disk |
| `MaterialTable` | Per-material density, compressive strength, tensile strength, palette |
| `IngestedAtUtc` | |

**Commands** (internal, driven by the hosted service — no public write API):
- `ScanDropFolder` → enumerates GLBs, hashes, diffs against converted set.
- `VoxelizeAsset(glbPath)` → parse (SharpGLTF) → normalize scale → conservative surface voxelization → interior flood fill → per-voxel material/color sampling → palette quantization (≤ 256) → RLE encode → atomic write.

**Queries** (public):
- `GetAssetManifest` → all converted assets' metadata.
- `GetAssetPayload(hash)` → binary stream.

**Invariants:** an asset is visible in the manifest only when its payload file is complete; identical bytes are never converted twice; conversion failure never blocks host boot.

### 3.2 Gameplay context (client — JS engine, ephemeral, no persistence)

Entities (never serialized, never sent to the server): `World` (seed, ground, structures), `Structure` (voxel grid + stress graph: nodes = voxel clusters, edges = connection strength budgets), `DynamicCluster` (detached rigidbody: voxel subset, mass, fragmentation depth), `DebrisParticle`, `Projectile` (primary | alt), `Enemy` (archetype, HP, nav state, threat state), `PlayerState` (HP, heat, cooldown, score accumulators), `SpawnDirector` (escalation curve), `AttritionGovernor` (cap enforcement).

The single fact that crosses the boundary out of this context is the immutable `RunSummary` produced at death.

### 3.3 Scoring context (server — reuses platform HighScores machinery)

**Aggregate: `PoVoxelStrikeRun`** (one row per player — best run only).

| Field | Notes |
|---|---|
| Player identity | RowKey material — immutable identity fields only, per descriptor rules |
| `Score` | int |
| `SurvivalSeconds`, `Kills`, `CrushKills`, `VoxelsDestroyed`, `StructuresCollapsed` | Run stats |
| `Seed` | For bragging/repro |
| `AchievedAtUtc` | |

**Command:** `SubmitRun(RunSummary)` — auth required, antiforgery-armed, rate-limited; persisted through a new `PoVoxelStrikeHighScoreDescriptor` (`RowKeyFields` = player identity; `ShouldOverwrite` = `candidate.Score > existing.Score`). This is a best-result ratchet — exactly what the descriptor pattern exists for; it does **not** join the two accumulator boards that bypass it.

**Query:** `GetLeaderboard(top)` — anonymous.

**Trust model:** the score is client-computed and therefore client-trusted, consistent with every existing single-player board on the platform. Server-side sanity bounds (reject `score > f(survivalSeconds)` outliers, negative values, absurd durations) are validation, not anti-cheat. Real anti-cheat is out of scope (§7).

---

## 4. Client Architecture (Blazor WASM)

### 4.1 Component hierarchy

```
Games/PoVoxelStrike/
├─ PoVoxelStrikePage.razor          @page "/povoxelstrike" (auth-gated like sibling games)
│   ├─ GameCanvasHost.razor         Owns the <canvas>, JS module load, engine lifecycle
│   ├─ HudOverlay.razor             HP bar, heat, cooldown, score, time, kills (absolute-positioned over canvas)
│   ├─ PreGamePanel.razor           Title, best score, asset-load progress, Play
│   ├─ PauseOverlay.razor           Resume / Restart / Quit
│   ├─ GameOverModal.razor          Run summary, seed, score-submit state, Replay (platform modal conventions)
│   └─ PoVoxelStrikeLeaderboard.razor  Shared leaderboard UI, this game's board
├─ PoVoxelStrikeState.cs            Scoped state store (see 4.2)
└─ PoVoxelStrikeInterop.cs          Typed JS module wrapper + [JSInvokable] receiver
```

JS engine (served live from source in dev, no rebuild — platform convention for JS-heavy games):

```
wwwroot/js/povoxelstrike/
├─ game.js            ES module entry: init/start/pause/resume/dispose exports
├─ world.js           Seeded scatter, ground gen, .pvx decode, greedy-meshed chunk builder
├─ destruction.js     Carve ops, stress solver, cluster detach/fragment, attrition governor
├─ enemies.js         Archetype AI, spawn director, nav re-plan budget, threat evacuation
├─ combat.js          Weapon state machine, projectiles, damage resolution
└─ vendor/            three.js, Rapier.js (+ its .wasm) — pinned local copies, no CDN
```

Three.js/Rapier live under `wwwroot/js/`, **outside** `_framework` — they do not count against the 25 MB WASM bundle budget. No new client NuGet packages ⇒ no new trim-analyzer surface.

### 4.2 State management and cache boundaries

- **`PoVoxelStrikeState`** — a **scoped** C# store owning one explicit lifecycle state machine: `Loading → Ready → Playing → Paused → GameOver`, plus HUD snapshot (last received telemetry record) and run-submission status (`Submitting | Submitted | Parked | Failed`). Components subscribe via event → `StateHasChanged`; there is exactly one writer (the interop receiver + UI commands). No global/singleton game state.
- **Cache boundaries, innermost to outermost:**
  1. **JS engine memory** — decoded voxel grids, meshes, physics world. Lives for one page mount; fully torn down on dispose.
  2. **Cache API (`povoxelstrike-assets`)** — `.pvx` binaries by content-hash URL; immutable; survives sessions; evicted only when a manifest drop proves the hash dead. The engine's fetch path checks this cache before the network.
  3. **HTTP cache** — belt-and-braces via `immutable` headers; not relied on.
  4. **`PendingScoreStore`** (platform, localStorage) — parked run results for guests/offline.
  5. **Server Table Storage** — the only durable truth: best runs.
- **Interop contract** (the whole surface — nothing else crosses):
  - C# → JS: `init(canvas, manifest, dotNetRef, options)`, `start(seed)`, `pause()`, `resume()`, `abort()`, `dispose()`.
  - JS → C# `[JSInvokable]`, coarse and throttled: `OnReady(loadStats)`, `OnHudTick(snapshot)` at 10 Hz (single flat record: hp, heat, cooldown, score, elapsed, kills, activeBodies, particleCount), `OnPaused(reason)`, `OnGameOver(runSummary)` once, `OnFatalError(message)`.
  - Rule: **no per-frame interop, no callbacks inside the physics step.** Diagnostics wanting more detail read `OnHudTick`'s existing counters.

### 4.3 Input

During `Playing`, the canvas holds Pointer Lock and the engine reads raw `keydown`/`mousemove`/`mousedown` directly — Blazor's event system is bypassed entirely for gameplay input (zero added latency). `pointerlockchange` → lock lost for any reason (Esc, tab switch, OS dialog) → engine pauses itself and raises `OnPaused("pointerlock-lost")`; Blazor shows the pause overlay and owns all input until Resume.

### 4.4 Authentication flow

Platform-standard, nothing new: the page is auth-gated like sibling games (Entra BFF cookie via `BffAuthenticationStateProvider`, or guest). Run submission POSTs ride the existing four-deep handler pipeline (`TransientRetryHandler → AntiforgeryHandler → IncludeCredentialsHandler → HttpClientHandler`) — antiforgery token and credentials are attached automatically; PoVoxelStrike adds no custom HTTP handling. Guests play fully; their results park in `PendingScoreStore` and flush on sign-in (anonymous reads never become anonymous writes).

---

## 5. Server & API Architecture

### 5.1 Feature slice

```
src/PoMiniGames.API/Features/PoVoxelStrike/     (namespace PoMiniGames.Features.PoVoxelStrike — RootNamespace is pinned)
├─ PoVoxelStrikeEndpoints.cs        Manifest, payload, leaderboard, submit
├─ AssetIngestionHostedService.cs   Startup scan (BackgroundService)
├─ GlbVoxelizer.cs                  GLB parse → voxel grid → material sampling
├─ PvxSerializer.cs                 Binary format encode/decode
├─ PvxHashEndpointFilter.cs         IEndpointFilter: hash shape validation
└─ PoVoxelStrikeOptions.cs          Bound from "PoVoxelStrike" config section
```

All routes register in the **single** platform registration point, `Infrastructure/EndpointRouteExtensions.MapPoMiniGamesEndpoints()` — never inline in `Program.cs`. The leaderboard descriptor lives in `PoMiniGames.Infrastructure` beside its siblings; `RunSummary`/manifest DTOs in `PoMiniGames.Shared`.

### 5.2 Endpoints

| Method & route | Auth | Rate limit | Returns |
|---|---|---|---|
| `GET /api/povoxelstrike/assets` | Anonymous | — | `200` JSON manifest `[{ hash, name, dims, sizeBytes, url }]` |
| `GET /api/povoxelstrike/assets/{hash}` | Anonymous | — | `200` `application/octet-stream` (.pvx), `Cache-Control: public, max-age=31536000, immutable`, `ETag`; `304` on `If-None-Match`; `400/404` ProblemDetails |
| `GET /api/povoxelstrike/leaderboard?top=25` | Anonymous | — | `200` JSON top runs |
| `POST /api/povoxelstrike/runs` | **Required** | `highscores` policy | `200` `{ accepted, isNewBest, bestScore }`; `400` validation ProblemDetails |

Consistent with the platform route-group contract: reads anonymous, game-data writes authenticated. `POST /runs` sits under `/api/*`, so the antiforgery synchronizer token is enforced automatically — and **every test that POSTs it must call `client.ArmAntiforgeryAsync()`** or it earns a 403.

### 5.3 `.pvx` binary format (v1, little-endian)

```
magic 'PVX1' (4B) | version u16 | dims u16×3 | flags u16
paletteCount u16  | palette entries: RGBA u8×4 + materialId u8      (≤256)
materialCount u8  | materials: density f32, compressiveStr f32, tensileStr f32
payloadLength u32 | RLE runs of (count u16, paletteIndex u8), X→Y→Z order
                    paletteIndex 0 = empty; asset is solid-filled (interior flood-filled)
```

Budget: a 64³ grid worst-cases at ~260 KB raw indices; RLE on real assets lands ~30–80 KB. Ten assets ≈ well under 1 MB total transfer, once, then Cache API. Decode target < 50 ms per asset in the client.

**Ingestion invariants:** write to `<hash>.pvx.tmp`, then atomic rename — the manifest endpoint globs `*.pvx` only, so a crashed conversion is invisible, not corrupt. Conversion parallelism is bounded to `Environment.ProcessorCount / 2` so an F1-tier host still serves traffic during a large first-time scan. Ingestion is scoped to server-owned folders (`PoVoxelStrike:AssetDropPath`, default `App_Data/povoxelstrike/drop`; converted output beside it). SharpGLTF (or equivalent) is added to the **API project only** — the host publish is untrimmed, so no trim-audit exposure; central package management via `Directory.Packages.props` as usual.

### 5.4 Persistence strategy

- **Leaderboard:** `PoVoxelStrikeHighScoreDescriptor` in Table Storage. `RowKeyFields` = immutable player identity (never the score); `ShouldOverwrite` keeps the better score from being clobbered. Table auto-creation on startup, platform-standard. This board is a ratchet, so the descriptor pattern applies cleanly — no `TableConcurrency` accumulator path needed.
- **Voxel payloads:** local disk under the app content root, **not** Table Storage (row-size hostile) and not blob storage in v1 (assets deploy with the app; the drop folder is an author-time input). `WEBSITE_RUN_FROM_PACKAGE=1` mounts the deployment read-only — therefore in Azure the drop folder ships **inside the package** and ingestion output targets a writable path (`%HOME%\data\povoxelstrike`); locally both live under `App_Data`. The options class carries both paths so the environments diverge in config, not code.
- **No AI boundary.** PoVoxelStrike touches no chat client, so `TestBudgetGuard` needs **no** new entry — noted explicitly so nobody adds one "just in case."

### 5.5 Validation & error contract

- All error responses are RFC 7807 `ProblemDetails`, matching platform conventions.
- `PvxHashEndpointFilter` rejects malformed hashes before the handler (`400`, no filesystem touch — also the path-traversal guard: the hash is the only client-supplied path component and must match `^[0-9a-f]{64}$`).
- `POST /runs` validation: score/stat fields non-negative; `SurvivalSeconds` ≤ 4 h; `Score` ≤ plausibility ceiling derived from `SurvivalSeconds` and kill counts; violations → `400` with field-level errors. Accepted-but-not-best submissions return `200 { isNewBest: false }` — not an error.

---

## 6. Non-Functional Requirements

### Performance & latency

| Metric | Target |
|---|---|
| Frame rate, mid-range desktop, caps saturated | 60 FPS sustained; physics fixed-step 60 Hz decoupled from render |
| Hard caps (deterministic attrition) | ≤ 150 active rigidbodies; ≤ 2000 particles; oldest/smallest demoted first |
| Interop frequency | HUD pump ≤ 10 Hz (tolerance to 20 Hz); zero per-frame interop |
| Stress solve after a carve | Localized re-solve ≤ 4 ms amortized (region-scoped, budgeted across frames for large collapses) |
| Enemy re-plan budget | ≤ 2 ms/frame, staggered round-robin |
| Asset manifest + payloads, warm Cache API | ≤ 500 ms to Ready |
| `GET /assets/{hash}` p95 (server) | ≤ 100 ms TTFB local; F1-tier cold start excepted |
| `POST /runs` p95 | ≤ 500 ms |
| Startup ingestion, 10 typical GLBs, first run | ≤ 60 s, non-blocking (host serves traffic while converting) |

### Resilience

- Per-file ingestion failures are logged and skipped; host boot never fails on a bad GLB.
- Run submission rides `TransientRetryHandler`; on terminal failure or offline the result parks in `PendingScoreStore` and `ScoreSyncService` flushes later — a finished run's score is never lost, including for guests.
- Pointer-lock loss, tab-hide (`visibilitychange`), and WebGL context loss all pause the simulation; context loss shows a Blazor "restart run" prompt rather than a broken canvas.
- Full offline replay works when assets are cached (PWA service worker + Cache API); the offline banner and update prompt are the existing `OnlineStatusService`/`AppUpdateService` — nothing new.
- `OnFatalError` from the engine transitions the Blazor state machine to a recoverable error panel; it never strands the player on a dead canvas.

### Telemetry

- Server: ingestion summary log (converted/skipped/failed + durations); standard request logging. App Insights only in production via the existing Key Vault-fed connection string — local stays console/Serilog by design (do not "fix" the empty local connection string).
- Client: run summaries carry the diagnostic aggregates (peak rigidbodies, attrition demotions, min FPS bucket) inside the existing `OnGameOver` payload — logged server-side with the submission, no new telemetry channel.
- `/api/diag` picks up the new config section automatically; `/health` JSON remains untouched.

### Security

- Writes authenticated + antiforgery-validated (automatic under `/api/*`); reads anonymous — matching the platform's route-group contract exactly.
- The asset payload route's only dynamic input is the hash, regex-pinned before any filesystem access (no traversal surface).
- `POST /runs` under the `highscores` rate-limit policy; asset GETs are immutable-cached so repeat load is absorbed by the browser, not the F1 host.
- No new secrets, no user-supplied uploads (the drop folder is server-side, author-controlled), no new cookie or identity surface. Client-trusted scores are bounded by server plausibility checks; true anti-cheat is explicitly out of scope.

### Concurrency

- Leaderboard writes go through the descriptor's compare-and-ratchet (`ShouldOverwrite`); two racing submissions from the same player converge on the higher score.
- Ingestion is single-flight (one hosted-service scan per boot); bounded parallel conversion; atomic rename is the only publish step, so the manifest endpoint and the converter never race on a partial file.
- The JS engine is single-threaded by design in v1 (no SharedArrayBuffer/COOP-COEP requirements); Rapier runs on the main thread inside the fixed-step budget.

### Testing (platform gates)

- **Route new tests to Integration by default** (Unit is at its 100 ceiling; Integration holds 50 slots — spend them carefully). Planned: Integration — ingestion skip/dedup/atomicity against a temp folder, descriptor ratchet semantics, `.pvx` round-trip; E2E-API — endpoint contract incl. antiforgery arming and hash validation; E2E-UI — one Playwright smoke (load page → start run → force game over via test hook → leaderboard row appears). Pure-function tests (`PvxSerializer`, score plausibility) go Unit **only if** slots free up via consolidation — never raise a cap.
- All suites run token-free automatically (no AI boundary), Azurite via `docker compose up -d azurite` as usual.

---

## 7. Out of Scope & Future Milestones

### Explicitly out of scope (v1)

- Multiplayer, co-op, or any server-authoritative simulation
- Save games / mid-run resume (server saves score + stats only — locked decision)
- Weapon arsenal, pickups, unlocks, or progression meta
- Live folder watching (restart-to-ingest is the contract) and per-file sidecar config
- Auto quality scaling / mobile-tier tuning (hard caps only; desktop-first)
- Anti-cheat beyond server plausibility bounds
- Voxel resolution options (fixed 64), texture-atlas material fidelity, GLB animation/skinning support
- Blender/authoring integrations of any kind

### Delivery milestones

| Milestone | Contents | Exit criterion |
|---|---|---|
| **M1 — Pipeline & world** | Ingestion slice, `.pvx` format, manifest/payload endpoints, Cache API layer, world scatter, static render | Drop a GLB → restart → walk around it in-browser |
| **M2 — Destruction core** | Carving, stress solver, cluster detach, hierarchical fragmentation, attrition governor, caps | Shoot a tower's legs → it falls, fragments, dissolves at 60 FPS |
| **M3 — Combat & enemies** | Weapon (two modes), damage model incl. crush, three archetypes, spawn director, threat evacuation, HUD pump | Full survival loop playable start → death |
| **M4 — Platform integration & ship** | Descriptor + submit/leaderboard endpoints, game-over modal, pending-score parking, catalog entry, tests within ceilings, deploy | Green `test-all.ps1`; run visible on the live leaderboard after `azd up` |

### Future candidates (post-v1, in rough priority order)

1. Layout files (authored placement instead of random scatter) and per-asset material sidecars
2. Daily seed challenge (shared seed, separate board — a ratchet, so the descriptor pattern still fits)
3. Auto quality scaling for low-end and mobile
4. Weapon variety and salvage/resource loop feeding a build-mode
5. Ghost replays from the recorded seed + input stream
