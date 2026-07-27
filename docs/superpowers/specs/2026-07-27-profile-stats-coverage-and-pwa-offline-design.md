# Profile Stats Coverage + PWA Offline — Design

Date: 2026-07-27
Status: Approved, ready for implementation

Two independent improvements, delivered together because neither is large enough
to warrant its own cycle and they touch disjoint code.

- **Part A** — the profile page reports 3 of 10 games. Make it report all 10.
- **Part B** — the app ships a web manifest but registers no service worker. Make
  it installable and playable offline.

---

## Part A — Profile stats coverage (3 games → 10)

### Current state

`ProfilePage.GameDefs` lists exactly three games: `tictactoe`, `connectfive`,
`pomarblerace`. Everything the page renders — radar chart, win/draw/loss donut,
Best Game / Nemesis callouts, difficulty breakdown — is fed from that list.

The recording layer is further along than the display layer:

| Game | Records today | Storage shape | Shown on profile |
|---|---|---|---|
| `tictactoe` | yes | adaptive ELO | yes |
| `connectfive` | yes | adaptive ELO | yes |
| `pomarblerace` | yes | server high score | yes (score only) |
| `pobrawl` | yes | adaptive ELO | **no** |
| `posports` | yes | Medium bucket + server score | **no** |
| `pofunquiz` | yes | Medium bucket | **no** |
| `pocouplequiz` | match history only | — | **no** |
| `poracer` | nothing | — | **no** |
| `pojoker` | nothing | — | **no** |
| `posurvive` | nothing | — | **no** |

So three games need display only, two need a recording call added, and two have
no win condition at all.

### A1. Replace the hardcoded game special-case

`LoadStats` branches on `if (key == "connectfive")` to pick the adaptive-rating
path over the difficulty-bucket path, and `GameDefs` carries two booleans
(`HsOnly`, `OfflineOnly`) that encode a third and fourth variant. At three games
this is survivable; at ten it multiplies.

Replace both with a single discriminator on the game definition:

```csharp
private enum RatingKind
{
    Adaptive,       // single adaptive ELO vs a rating-matched CPU
    Difficulty,     // Easy/Medium/Hard buckets
    HighScoreOnly,  // no W/L semantics; server board carries the number
    PlayCountOnly,  // no W/L and no score; only "how many times played"
}
```

`LoadStats` switches on `RatingKind` once. Adding a game becomes a one-line
`GameDefs` entry with no new branch.

This is a prerequisite, not a nice-to-have: A2 adds a second adaptive game
(`pobrawl`), which the current `key == "connectfive"` check would silently route
down the wrong path — Brawl would report zeros despite having recorded data.

### A2. Display-only additions (no game code touched)

Add to `GameDefs`:

| Key | Label | Icon | RatingKind |
|---|---|---|---|
| `pobrawl` | Brawl | 🥊 | `Adaptive` |
| `posports` | Sports | 🏃 | `Difficulty` |
| `pofunquiz` | Fun Quiz | 🧠 | `Difficulty` |

All three already persist to localStorage via `GameResultService` /
`GameStatsService`. No changes to the game pages. A player with existing Brawl or
Sports history sees it appear on first load after this ships — the data was
always there.

### A3. Add recording where it is missing

**`poracer`** — `PoRacerPage.OnFinished(PoRacerFinalResult)` sets the final
result and submits the server score, but never records a local outcome. Add a
`GameResultService.RecordAsync("poracer", …)` call in the same handler: a win
when the player's finishing position is 1, a loss otherwise. The existing
`if (!_isDemo)` guard already excludes spectator demo races, and the recording
call goes inside it — a demo race has no player car and must not record.

**`pocouplequiz`** — already computes a `MatchOutcome` and writes it to match
history. Add the local stats write alongside the existing
`MatchHistory.RecordAsync` call, reusing the same computed outcome. No new
outcome logic.

**`pojoker` / `posurvive`** — neither has a win condition or a score. Joker is an
AI-jester/joke-API experience; Survive is a simulation. Inventing a score for
them is a separate feature, not stats coverage. They get play counts instead.

New method on `GameStatsService`:

```csharp
public int GetPlayCount(string gameKey, string playerName);
public void RecordPlay(string gameKey, string playerName);
```

Backed by `pomini_plays_{gameKey}_{playerName}` in localStorage, mirroring the
per-player keying `GetAdaptiveRating` already uses — switching between Guest and
a Microsoft identity on the same browser must not merge or clobber counts.

`RecordPlay` is called once per page session on the Joker and Survive pages, not
per round: the tile reads "Played N times", and N should mean sessions.

### A4. High-score section

`HsDefs` gains two entries:

| Key | Label | Icon | Metric | Direction |
|---|---|---|---|---|
| `posports` | Sports | 🏃 | `TotalTimeSeconds` | lower is better |
| `pobrawl` | Brawl | 🥊 | `KoTimeSeconds` | lower is better |

Both boards already have client getters (`GetPoSportsHighScoresAsync`,
`GetPoBrawlHighScoresAsync`).

`LoadHighScoresAsync` currently contains a local function `MarbleEntry` that
solves a real and subtle problem: the leaderboard endpoint returns the *global*
top-N, not the current player's own best, so the top row must never be presented
as "yours". It matches on server-stamped `UserId`, falls back to display name for
legacy/anonymous rows, and pulls a wide page so a personal best outside the
global top ten still resolves.

Generalize that one method rather than copy it twice. **Constraint:**
`PoSportsHighScore` and `MarbleRaceHighScore` both carry `UserId`, but
`PoBrawlHighScore` carries only `PlayerInitials` — the generalized matcher must
accept a null/absent user-id selector and degrade to name-only matching for
Brawl. Same suppression rule applies throughout: when no row belongs to the
player, show "Not played yet", never the global #1.

### A5. Radar chart

`BuildRadarSvg` draws one axis per `_entries` element. Going from 3 to 10 entries
crowds the labels past legibility, and `PlayCountOnly` / `HighScoreOnly` games
have no win rate to plot — they would pin to zero and read as catastrophic
losses.

The radar takes only entries where `RatingKind` is `Adaptive` or `Difficulty`
**and** `TotalGames > 0`. Everything else appears in the breakdown grid, which
already has an unplayed-card state. The existing `n == 0` empty-SVG guard stays
and now also covers "played only score-based games".

### A6. Play-count tiles

`PlayCountOnly` games render a distinct card in the Game Breakdown grid: icon,
name, "Played N times", and no win-rate bar or ELO row. At N = 0 they use the
existing `prf-game-card--unplayed` treatment with "Not played yet". They are
excluded from `_totalGames` / `_totalWins` aggregates — a Joker session is not a
match and must not dilute the overall win rate or the donut.

---

## Part B — PWA install + offline play

### Current state

`wwwroot/manifest.webmanifest` ships and is linked from `index.html`, but no
service worker is registered anywhere. The app is therefore not installable in
any meaningful sense and does not work offline at all.

Scope decision: **offline for client-only games.** Tic-Tac-Toe, Connect Five,
Brawl, Sports (1P/2P), Marble Race, and Survive run entirely in the browser and
will be fully playable with no network. Games requiring a live server — Racer
multiplayer, Couple Quiz, Fun Quiz multiplayer, and Joker (it calls a joke API) —
are marked unavailable while offline rather than failing obscurely.

### B1. Service worker registration

Standard Blazor WASM PWA wiring:

- `wwwroot/service-worker.js` — development no-op. Must stay a no-op; a caching
  SW in development makes every code change appear not to take effect.
- `wwwroot/service-worker.published.js` — production, cache-first against the
  generated asset manifest.
- `<ServiceWorkerAssetsManifest>service-worker-assets.js</ServiceWorkerAssetsManifest>`
  in `PoMiniGamesClient.csproj`.
- Registration script in `index.html`.

Game engine JS under `wwwroot/js/<game>/` (three.js / cannon-es for Marble Race,
Brawl, Sports, Survive) are static web assets and land in the generated manifest
automatically — no manual cache list to keep in sync.

Note: `StaticWebAssetsFingerprintingEnabled` is already `false` in the csproj.
The service worker asset manifest carries its own integrity hashes, so this does
not affect cache correctness.

### B2. Bypass list — the correctness-critical part

The service worker must **never** serve a cached response for:

- any non-GET request
- `/api/*`
- `/authentication/*` and `/signin-oidc`
- any SignalR hub path (`*/hubs/*`, `/funquiz/gamehub`, `/poracer/lobby-hub`, …)

The auth stack is a BFF cookie pattern over MSAL redirects. A cached auth
redirect or a cached `/api` response does not fail loudly — it produces a
mis-scoped session or stale game data, which is materially harder to diagnose
than an outright error. Serving `index.html` from cache is correct for app
routes and wrong for everything above.

The bypass list gets an explicit test (B6) rather than relying on review.

### B3. Offline must be visible

Silent offline mode reads as breakage. Add:

- `OnlineStatusService` — wraps `navigator.onLine` plus the `online`/`offline`
  events, exposed as a subscribable state like the existing services.
- A `MainLayout` banner while offline.
- Online-only game chips (Racer multi, Couple Quiz, Fun Quiz multi, Joker)
  visually marked unavailable while offline, driven from `GameCatalog`.

Scores earned offline already park in `ScoreSyncService`'s queue and replay on
reconnect, and `GameResultService.OnScoreParkedAsync` already produces the right
message for that case. This path is reused as-is, not rebuilt.

### B4. Update prompt

A cache-first service worker will otherwise serve a stale app indefinitely. On
detecting a new worker in `waiting`, show a toast through the existing
`ToastService`: "New version available — reload."

### B5. Verification

The published service worker activates only in `dotnet publish` output, never
under `dotnet run`. Verification is: publish → serve the published output →
DevTools offline → confirm a client-only game loads and plays from a cold start,
and confirm an online-only game shows the offline treatment.

This is a slower loop than the normal dev cycle and is expected to be.

### B6. Tests

The Unit tier sits at its 100-method ceiling (`TestCountCeilingTests`).

This design originally routed `RatingKind` classification and the play-count
round-trip to the **Integration tier**. That is not reachable: `RatingKind` is
private to the Razor component, and play counts go through `LocalStorageService`,
which is JS interop. Testing either from Integration would mean adding a seam that
exists only for tests. Both moved to E2E-UI instead, where they are exercised through
the real path.

- **E2E-UI (Playwright)**, `ProfileCoverageUiTests` (2 methods; the tier ceiling is
  25 and was at 7):
  - the profile lists all ten games, and a game with no win condition shows a
    session count and no win rate — driven by actually visiting the game, not by
    seeding storage
  - going offline shows the banner, suppresses network-dependent games, and leaves
    local games playable

The published service worker cannot be exercised from that tier — the test host
serves the development no-op worker. Its verification is the manual publish flow in
B5, which covered: precache populated (2257 entries), app boots with the server
killed, deep-linked local game loads offline, `/api` fails rather than serving stale
cache, and no `/api` or auth response present in the cache.

### B7. Precache must be batched (discovered during verification)

The stock Blazor template passes every asset to a single `cache.addAll()`. At this
app's size (~2250 assets) that call rejects outright with `TypeError: Failed to
fetch` — the browser runs out of connection resources issuing them all in parallel.
The install then fails and leaves an **empty** cache, so offline support silently
does not exist even though every individual asset fetches fine.

Measured: single `addAll` → fails; sequential batches of 40 → all 2257 cached in
~19s. The worker therefore batches, and a batch failure deliberately aborts the
install rather than leaving a half-filled cache.

### B8. Play counts are keyed by player id, not player name

A6 originally keyed play counts by player name, mirroring `GetAdaptiveRating`. That
is wrong for this counter, in two compounding ways:

1. `PlayerNameService.PlayerName` starts empty and is filled by a fire-and-forget
   async read of localStorage, so recording at page-init files the session under an
   empty name; the profile, reading later with the name resolved, reports zero.
2. The name is then *overwritten* by `SetPlayerNameFromAuth` when a guest signs in.
   Even with the ordering fixed, signing in orphans everything recorded before.

(2) is not hypothetical: it is what the E2E environment does via FakeAuth, and it is
what production does whenever a guest signs in with Microsoft.

Play counts are therefore keyed by `GetOrCreatePlayerId()` — created synchronously on
first use and never mutated. This removes the ordering hazard entirely (no awaiting
anything) and survives sign-in.

Trade-off, accepted: two identities in the same browser share one counter. For a
"times played" tally that is a better failure mode than losing the count on every
sign-in.

Recording happens on first render rather than `OnInitialized`, since the counter goes
through localStorage and JS interop is only guaranteed once the component has
rendered.

This does not affect the outcome-recording added in A3: PoRacer and PoCoupleQuiz
record at game end, and those stats use the existing name-keyed scheme shared with
every other rated game.

---

## Out of scope

- Scores for Joker and Survive (a feature, not stats plumbing)
- Achievements, daily challenges, leaderboard time windows (separate items)
- Any change to how scores are submitted or synced
