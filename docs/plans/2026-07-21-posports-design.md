# PoSports — Family Track Meet Design Spec

**Status:** draft · **Tier:** complex · **Date:** 2026-07-21

## Summary

PoSports is the 10th game on the platform: a 2-leg family track meet (Sprint 100m, then
Hurdles 110m) rendered as a 2D side-view sprite race using the six family-member
spritesheets in `wwwroot/images/PoSports/`. Runners are driven by **sequence typing**
(P1 `Q→W→A→S`, P2 `I→O→K→L`); the leaderboard ranks **total combined time, lower is
better**. All four platform modes ship in this session: single-player vs AI, local 2P,
online multiplayer (server-authoritative, mirroring PoRacer), and kiosk demo.

## Context

- 9 games exist under `src/PoMiniGames.Client/Games/`; each registers a `GameKey`
  ([GameKey.cs](../../src/PoMiniGames.Client/Models/GameKey.cs)), catalog rows
  ([GameCatalog.cs](../../src/PoMiniGames.Client/Models/GameCatalog.cs)), a routed
  `*Page.razor` inside `GameShell`, and (for canvas games) a JS engine under
  `wwwroot/js/<game>/` exposing `window.<Game> = { init, destroy, … }`
  (pattern: [pobrawl/index.js](../../src/PoMiniGames.Client/wwwroot/js/pobrawl/index.js)).
- Online play mirrors PoRacer: `PoRacerLobbyHub` + `PoRacerRaceHub` +
  server-side `PoRacerSim` (clients send inputs, server broadcasts snapshots).
- High scores flow through `HighScoreDescriptor<T>` in
  [StorageService.cs](../../src/PoMiniGames.Infrastructure/Services/StorageService.cs),
  minimal-API endpoints under `Features/HighScores/`, and a builder in
  [UnifiedLeaderboardEndpoints.cs](../../src/PoMiniGames/Features/Leaderboard/UnifiedLeaderboardEndpoints.cs).
- The sprite assets are **untracked** and unusable as-is: 175 MB, of which 136 MB is a
  redundant `frames/` decomposition of the 38.5 MB of spritesheets. All six characters
  (Dad, Mom, Kim, Matt, Nick, Tong) have the full 8-animation set
  (idle/walk/run/jump `_right`, Punch, Kick, Hit React, Happy Dance) with `atlas.json`
  frame maps. Nick is already 256px/25-frame; the others are 512px/49–64-frame.

## Design

### Game rules

- **Meet** = Sprint leg (100 m) → results interstitial → Hurdles leg (110 m, 8 hurdles)
  → podium (winner plays Happy Dance).
- **Stride model (momentum):** each *completed* key sequence injects a speed impulse;
  speed decays continuously (`v' = v·decay^dt`); position integrates from speed. A wrong
  key resets sequence progress to the start (no speed penalty — lost time is the penalty).
- **Jump:** dedicated key (P1 `E`, P2 `P`). Jumping arcs the runner for a fixed duration.
  A hurdle contacted while not airborne (or landing on it) triggers a **stumble**: Hit
  React animation, speed×0.3, +1.5 s added to leg time.
- **Timing:** each leg is timed from gun to finish line; total = sprint + hurdles
  (stumble penalties are added into the hurdles leg time). Lower total wins.
- **False start:** typing before the gun resets that runner's sequence and holds them
  0.5 s — no restart of the race.
- **Lanes:** 4 side-view lanes. 1P = player + 3 AI; 2P = two players + 2 AI;
  online = up to 4 humans, AI fills empty lanes at race start; demo = 4 AI.

### Modes and routes

| Mode | Route | Entry (GameCatalog section) |
|---|---|---|
| 1P vs AI | `/posports` | SinglePlayer: 🏃 "Sports" |
| Local 2P | `/posports?mode=2p` | LocalTwoPlayer |
| Online MP | `/posports/lobby` → `/posports/race/{code}` | Multiplayer |
| Demo | `/posports/1` (`{Demo:int}` route like PoBrawl) | Demo |

### Architecture

```
Blazor PoSportsPage.razor ── JS interop ──> window.PoSports (js/posports/index.js)
     │  GameShell + GameIntro (char select)        │
     │                                             ├─ game.js      loop/orchestrator
     │  local modes (1p/2p/demo): pure client      ├─ physics.js   stride model (JS)
     │                                             ├─ sprites.js   atlas loader/cache
     │  online mode:                               ├─ input.js     sequence tracker
     │   PoSportsHubService (C#) <─SignalR─┐       ├─ ai.js        rival typists
     │                                     │       ├─ track.js     canvas renderer
     ▼                                     ▼       └─ touch.js     1P touch pad
Features/PoSports/ (server)          snapshots→page→JS (render-only in online mode)
  PoSportsLobbyHub + PoSportsLobbyService   lobby create/join/pick/ready state
  PoSportsRaceHub    JoinRace / SendKey; broadcasts PoSportsSnapshot ~15 Hz
  PoSportsSim        stride model (C#) — server-authoritative race state
  PoSportsRaceRegistry / PoSportsRaceService   (mirrors PoRacer's server layout:
    LobbyHub/LobbyService/RaceHub/RaceRegistry/RaceService + Sim)
```

Local modes run entirely in JS (offline-resilient, per platform promise). Online mode:
the C# sim is authoritative; the JS engine becomes a renderer fed by snapshots, and
keystrokes are forwarded raw (`SendKey`) so the server runs the same sequence/momentum
rules. The stride model is deliberately simple (~40 lines) to keep the dual
implementation cheap; shared constants are pinned by mirrored unit tests (below).

### Physics constants (single source of truth, duplicated by-spec)

```
SEQ_P1 = [KeyQ, KeyW, KeyA, KeyS]   SEQ_P2 = [KeyI, KeyO, KeyK, KeyL]
IMPULSE        = 1.9  m/s   per completed sequence
DECAY          = 0.45       fraction of speed retained per second (v *= DECAY^dt)
MAX_SPEED      = 9.5  m/s
JUMP_DURATION  = 0.55 s     airborne window
JUMP_DRAG      = 0.85       impulse multiplier while airborne
STUMBLE_FACTOR = 0.3        speed multiplier on hurdle hit
STUMBLE_PENALTY= 1.5  s     added to leg time
SPRINT_LENGTH  = 100 m      HURDLES_LENGTH = 110 m
HURDLE_POSITIONS = 8 hurdles at 20,30,40,50,60,70,80,90 m
TICK           = 1/60 s fixed step (both sims)
```

`physics.js` exports these; `PoSportsConstants.cs` declares them. A C# unit test asserts
the C# values equal the values parsed from `physics.js` (regex on the export block), so
drift breaks the build.

### Components

| Component | Responsibility | Path |
|---|---|---|
| PoSportsPage | Routes, GameShell/GameIntro, mode/phase state, HUD, results, score post | `src/PoMiniGames.Client/Games/PoSports/PoSportsPage.razor` (+`.razor.css`) |
| PoSportsLobbyPage | Online lobby create/join/ready (clone of PoRacerLobbyPage) | `src/PoMiniGames.Client/Games/PoSports/PoSportsLobbyPage.razor` |
| PoSportsHubService | SignalR client for lobby + race hubs | `src/PoMiniGames.Client/Games/PoSports/Services/PoSportsHubService.cs` |
| index.js | `window.PoSports = {init, startLeg, setMuted, applySnapshot, destroy}` | `src/PoMiniGames.Client/wwwroot/js/posports/index.js` |
| game.js | Fixed-step loop, leg/phase machine, lane state, Blazor callbacks (`OnHud`, `OnLegDone`, `OnMeetDone`) | `…/js/posports/game.js` |
| physics.js | Stride/momentum/jump/stumble model + exported constants | `…/js/posports/physics.js` |
| sprites.js | Loads `atlas.json`+`spritesheet.png` per (char, anim), draws frames | `…/js/posports/sprites.js` |
| input.js | Keyboard sequence tracker (2 layouts), jump keys, wrong-key reset | `…/js/posports/input.js` |
| ai.js | AI rivals: simulated typing cadence + error rate + jump-timing jitter. No difficulty picker in v1 — the 3 rivals are fixed at easy/medium/hard cadences so every 1P meet has a spread; demo uses the same three plus one medium | `…/js/posports/ai.js` |
| track.js | Canvas 2D: track, lanes, hurdles, finish line, crowd strip, camera follow | `…/js/posports/track.js` |
| touch.js | 1P on-screen 4-button sequence pad + jump button | `…/js/posports/touch.js` |
| PoSportsLobbyHub | Create/join/leave/pick-character/ready; starts race | `src/PoMiniGames/Features/PoSports/PoSportsLobbyHub.cs` |
| PoSportsLobbyService | Lobby state store (code → members/picks/ready), mirrors `PoRacerLobbyService` | `src/PoMiniGames/Features/PoSports/PoSportsLobbyService.cs` |
| PoSportsRaceHub | `JoinRace`, `SendKey`; snapshot broadcast | `src/PoMiniGames/Features/PoSports/PoSportsRaceHub.cs` |
| PoSportsSim | C# stride model + race state machine (both legs, penalties, finish order) | `src/PoMiniGames/Features/PoSports/PoSportsSim.cs` |
| PoSportsConstants | C# copy of physics constants | `src/PoMiniGames/Features/PoSports/PoSportsConstants.cs` |
| Registry/Service | Active-race registry + tick loop host (mirrors PoRacer) | `…/PoSports/PoSportsRaceRegistry.cs`, `PoSportsRaceService.cs` |
| PoSportsHighScore | Domain model | `src/PoMiniGames.Domain/Models/PoSportsHighScore.cs` |
| Score endpoints | GET/POST `/api/posports/highscores` | `src/PoMiniGames/Features/HighScores/PoSportsHighScoresEndpoints.cs` |
| Descriptor | `PoSportsScores` in StorageService + `IStorageService` methods | existing files, extended |
| Leaderboard builder | "Sports" board, seconds ascending | `UnifiedLeaderboardEndpoints.cs`, extended |
| Registration | `GameKeys.PoSports`, 4 catalog rows, endpoint + 2 hub mappings | `GameKey.cs`, `GameCatalog.cs`, `EndpointRouteExtensions.cs` |

### Data model

```csharp
// src/PoMiniGames.Domain/Models/PoSportsHighScore.cs
public sealed class PoSportsHighScore
{
    public string PlayerName { get; set; } = "";     // display name, ≤24 chars
    public string UserId { get; set; } = "";          // server-populated from auth cookie
    public bool IsGuest { get; set; }
    public double TotalTimeSeconds { get; set; }      // ranking key, ascending
    public double SprintSeconds { get; set; }
    public double HurdlesSeconds { get; set; }        // includes stumble penalties
    public int HurdlesClean { get; set; }             // 0-8, results screen only
    public string Character { get; set; } = "";       // dad|mom|kim|matt|nick|tong
    public string Date { get; set; } = "";            // ISO-8601 string (legacy-safe)
    public string GameCode { get; set; } = "";        // online lobby code, "" for 1P
}
```

Descriptor (in `StorageService`): table `posportshighscores`, partition `posports`.
**`RowKeyFields: ["PlayerName", "UserId", "IsGuest"]`** — one row per player, keyed on
player identity, NOT on the score (per repo convention; see MarbleRace descriptor
comment). `ShouldOverwrite`: incoming `TotalTimeSeconds` < existing (ratchet keeps the
best/lowest time). `Rank`: `OrderBy(TotalTimeSeconds)` then oldest first.
Validation on POST: name required/≤24; `0 < TotalTimeSeconds < 600`; sprint+hurdles
must sum to total within 0.05 s.

### Interfaces

**HTTP** (registered in `EndpointRouteExtensions` under the game API group):
- `GET  /api/posports/highscores?count=10` → `200 [PoSportsHighScore]`
- `POST /api/posports/highscores` → `201` | `400 {error}` (rate-limited `highscores`,
  UserId stamped server-side like PoRacer)
- Unified board: key `posports`, title "Sports", unit seconds, ascending.

**SignalR** (both hubs `RequireAuthorization()` like PoRacer):
- `/posports/lobby-hub`: `CreateLobby(displayName)` → `{code}`;
  `JoinLobby(code, displayName)`; `PickCharacter(code, character)` (first-come lock; a
  taken character is rejected and the lobby UI grays it); `SetReady(code, bool)`;
  server events `LobbyUpdated(PoSportsLobbyState)`, `RaceStarting(code)`.
- `/posports/race-hub`: `JoinRace(code, asPlayer, displayName, isGuest)` →
  `PoSportsSnapshot?` (character comes from the lobby pick, carried in the registry —
  not a JoinRace parameter); `SendKey(code, keyCode)` (raw key; server runs sequence
  rules); server event `Snapshot(PoSportsSnapshot)` ~15 Hz.

```csharp
public sealed record PoSportsLobbyMember(
    string ConnectionId, string Name, string Character, bool Ready);
public sealed record PoSportsLobbyState(
    string Code, IReadOnlyList<PoSportsLobbyMember> Members, string Phase); // waiting|starting
```

Snapshot cadence is a deliberate divergence from PoRacer (20 Hz snap / 50 Hz tick):
PoSports uses 60 Hz tick to match the JS fixed step exactly (constants-sync depends on
identical dt) and 15 Hz snapshots because 4 lanes of scalar state is tiny. Client
renders remote lanes by linear interpolation between the last two snapshots, delayed
one snapshot interval (~66 ms) — speed is in the payload, so no extrapolation needed.

```csharp
public sealed record PoSportsLaneState(
    string Name, string Character, bool IsAi,
    double Position, double Speed, int SeqProgress,
    bool Airborne, bool Stumbling, double LegTime, bool Finished);

public sealed record PoSportsSnapshot(
    string Phase,          // countdown|sprint|interstitial|hurdles|podium
    double Clock,
    IReadOnlyList<PoSportsLaneState> Lanes);
```

**JS interop** (`window.PoSports`):
- `init(containerId, dotnetRef, { mode, players:[{lane,character,layout|ai|remote}], demo })`
- `startLeg(leg)` · `applySnapshot(snapshot)` (online render-only) ·
  `setMuted(bool)` · `destroy()`
- Callbacks to Blazor: `OnHud(hudJson)` (speeds/positions for shell stats),
  `OnLegDone(legJson)`, `OnMeetDone(resultJson)` (per-lane sprint/hurdles/total, placings).

### Data flow — 1P meet

1. Page loads → GameIntro with character picker (6 portraits from idle atlas frame 0) →
   player picks; 3 AI get distinct remaining characters.
2. `PoSports.init(...)` → sprites.js lazy-loads only the 4 in-play characters'
   sheets for the needed anims (idle, run, jump, hit-react, dance) — ≤ ~4 MB.
3. Countdown (3-2-1-gun); early typing = false-start hold.
4. Sprint leg: input.js tracks sequences → physics impulses; camera follows leader;
   HUD shows live speed + sequence progress per player lane.
5. Leg done → `OnLegDone` → Blazor interstitial (leg times, placings) → user taps →
   `startLeg('hurdles')`.
6. Hurdles leg: same + jump/stumble handling.
7. `OnMeetDone` → results: placings, per-leg splits, total; winner dances on podium.
   1P: POST high score via `ApiService`; `GameShell.GameOver` + `GameKey="posports"`
   drive the shared score panel.

### Data flow — online race

1. Lobby page: create/join via lobby hub; ready-up; server moves lobby → race,
   navigates members to `/posports/race/{code}`.
2. Race page: `JoinRace` returns initial snapshot; JS engine `init` in `remote` mode
   (render-only). Keydowns forward to `SendKey`.
3. `PoSportsRaceService` ticks all active sims at 60 Hz, broadcasts 15 Hz snapshots;
   client interpolates between snapshots (see Interfaces).
4. Sprint→hurdles interstitial is server-owned: sim enters `interstitial` phase for a
   fixed 8 s (clients show leg results with a countdown), then auto-starts hurdles. No
   host/tap dependency — a disconnected player can't stall the meet.
5. Meet done: server computes placings and persists each player's high score
   server-side via `IStorageService` (deliberate divergence from PoRacer's client
   POST: the server already holds the authoritative times, and this closes the
   fake-time hole for online races). Guests store `IsGuest=true` with their lobby
   display name and empty `UserId`, same shape the POST endpoint produces.
6. Disconnect: lane's runner keeps last speed and decays to a stop; rejoin by lobby
   code within the race resumes the lane with sequence progress reset to the start of
   the cycle (registry keeps race 5 min past finish).

## Asset pipeline (one-time, scripted)

`scripts/posports-assets.ps1` (committed, idempotent):
1. Delete all `frames/` directories (136 MB redundant with the sheets).
2. For every 512px sheet: downscale spritesheet.png to 50% (512→256 frames) and halve
   all `x/y/w/h` in `atlas.json`. Nick (256px already) untouched.
3. Normalize dir names to lowercase keys (`Dad-spritesheet` → `dad`), anims to
   `idle|walk|run|jump|punch|kick|hitreact|dance`.
   Result: `wwwroot/images/PoSports/{char}/{anim}/{spritesheet.png,atlas.json}`,
   ~6–8 MB total, which is then committed.

⚠️ Assets are untracked — deletion is unrecoverable. The script requires an explicit
`-Confirm` flag, and execution waits for a user gate before running it.

Note: punch/kick sheets are kept (future Dodgeball event) but never loaded by PoSports.

## Error handling

| Failure | Behavior |
|---|---|
| Sprite fetch fails | Retry once; then colored-rectangle fallback runner (game stays playable), console warn |
| Score POST fails (offline) | Result screen still shows; a toast notes the score didn't post. No retry queue — platform's offline promise is "playable", not "syncs later" |
| Hub connect fails (lobby/race) | Error banner + "Back to games"; local modes unaffected (no hub dependency) |
| Player disconnects mid-race | Lane decays to stop; can rejoin via lobby code while race lives |
| Server sim exception | Registry drops the race; clients get hub-closed event → error banner |
| Invalid POST payload | `400 {error}` per validation rules above |
| Demo left running | Kiosk rotation unaffected: demo loops meets forever until navigation (KioskCoordinator pattern) |

## Testing strategy

Tiers per `scripts/test-all.ps1` (Unit → Integration → E2E-API → E2E-UI):

**Unit (xUnit, `tests/PoMiniGames.Unit`)**
- `PoSportsSimTests` (expected values from the constants block): one completed
  sequence from rest → speed 1.9 m/s exactly; no input for 2 s from 1.9 m/s →
  1.9·0.45² ≈ 0.385 m/s; impulse spam caps at 9.5; wrong key resets `SeqProgress` to 0,
  speed unchanged; jump at hurdle → airborne 0.55 s, no stumble; grounded at hurdle →
  speed×0.3 and legTime+1.5; finish order sorts by total ascending; key before gun →
  0.5 s hold + progress reset; AI-vs-AI full meet finishes within 180 sim-seconds
  (10 800 ticks).
- `PoSportsRaceServiceTests` (online path, no live hub): registry create→join→pick
  →ready starts a sim; `SendKey` routed to the right lane advances its sequence;
  interstitial auto-advances after 8 s; snapshot serializes with all lanes; finished
  race persists scores through a fake `IStorageService` (guest + authed shapes);
  disconnect decays lane, rejoin resets `SeqProgress`.
- `PoSportsConstantsSyncTests`: C# constants == values parsed from `physics.js`.
- `PoSportsHighScoreDescriptorTests`: sanitize clamps; ratchet keeps lower time;
  rank ascending; row key = player identity (mirrors existing descriptor tests).
- Leaderboard builder: `posports` board present, unit seconds, ascending.

**Integration (`tests/PoMiniGames.Integration`)**
- Score save/get/ratchet round-trip against Testcontainers Azurite.

**E2E-API (`tests/E2EAPI`)**
- GET empty board; POST valid → 201 + GET returns it; POST invalid (bad time, long
  name, mismatched splits) → 400; rate limit honored.

**E2E-UI (Playwright, `tests/E2EUI`)**
- `/posports/1` demo: page loads, canvas present, phase reaches `sprint`, HUD updates.
- 1P smoke: pick character, race starts, synthetic keydowns (Q,W,A,S) advance runner.

## Decision log

| Decision | Options considered | Chosen | Rationale |
|---|---|---|---|
| Concept | Multi-event sports day; single event; 2D fighter | 2-leg track meet | Uses run/jump anims; fighter would duplicate PoBrawl |
| Events | Sprint, hurdles, dodgeball, dance-off | Sprint + Hurdles | User-picked; combat anims deferred (Dodgeball later) |
| Structure | Back-to-back meet; event menu; hurdles-in-sprint | Back-to-back, one total | One leaderboard number; matches other games' single score |
| Modes | subsets vs all | All 4 (1P/2P/online/demo), one session | User accepted ~28-30-task session; board carries resumes |
| Score | Points high-wins; total time low-wins; points+ELO | Total combined time, lower better | User-picked; single unit like PoRacer's TotalTimeSeconds |
| Controls | Alternating mash; rhythm taps; hold-to-run | Sequence typing Q-W-A-S / I-O-K-L, wrong key restarts sequence | User-specified mechanic |
| Stride | Momentum+decay; fixed step; auto-hurdle | Momentum + decay, dedicated jump key (E / P) | Skill ceiling; jump stays a deliberate act |
| Online sync | Local sim + ghost relay; server-authoritative; +prediction | Server-authoritative, mirrors PoRacer | House pattern, cheat-resistant; accepts keystroke RTT + dual physics impl |
| Assets | Keep 512px; downscale 256px; also trim anims | Drop `frames/`, downscale to 256px, keep all 8 anims | 175→~7 MB; 256px covers ~150-200px display size; keeps Dodgeball option open |
| Renderer | Canvas 2D vs three.js | Canvas 2D | Sprite blitting needs no 3D lib; smaller payload |
| Roster | Pick from 6; random; stat-differentiated | Pick from 6, uniform stats | Fair leaderboard; GameIntro Options slot exists for select UI |
| Touch | 1P sequence pad; none; 2P split | On-screen pad, 1P/online only | Platform is mobile-visited; 2P on one phone impractical |
