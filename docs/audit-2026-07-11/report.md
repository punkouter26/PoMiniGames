# PoMiniGames NET_RUN_10 audit — 2026-07-11

## Environment snapshot
- API on http://localhost:5000 (PID ~6 dotnet processes, host from prior runs)
- Azurite node process listening on 10000/10001/10002 (in-memory Blob/Queue/Table)
- `/api/auth/config`: `devLoginEnabled=true, autoGuestLogin=false, usingMockData=false`
- `/api/face/status`: `isMockFaceApi=false` (Azure OpenAI live in Dev)
- `/api/health`: `Healthy` (Storage OK; Table storage not configured)
- `/api/diag`: 4 integrations `keyVaultConfigured, applicationInsightsConfigured (not-configured), microsoftAuthConfigured, aiFoundryConfigured`
- App Insights: NOT configured locally → "live telemetry" path is dormant

## Route audit (52 routes × 2 viewports)
- Console errors: 0
- Broken images: 0
- 4xx/5xx responses: 0
- Network aborts: 1 (`/api/auth/handshake` during `/pobrawl/1` — likely a redirect race; user lands authenticated)
- Overflow (docH > vpH): 26 / 52 (50%)

## Severe overflow (docH > 1.3 × vpH)
| Viewport | Route                                  | docH/vpH |
|----------|----------------------------------------|----------|
| mobile   | /leaderboards                          | 5.2×     |
| desktop  | /face/recap/{SessionId}                | 2.5×     |
| desktop  | /                                      | 1.8×     |
| desktop  | /leaderboards                          | 1.8×     |
| desktop  | /profile                               | 1.8×     |
| desktop  | /diag                                  | 1.8×     |
| desktop  | /test                                  | 1.8×     |
| desktop  | /connectfive/1                         | 1.8×     |
| desktop  | /pobrawl/1                             | 1.8×     |
| desktop  | /face/demo                             | 1.8×     |
| desktop  | /face                                  | 1.8×     |

## Multi-session connectivity (2 isolated browser contexts)
- `/auth/login/fake?displayName=NetRun10-Alice` and `…Bob` BOTH resolved to `userId="dev-guest", displayName="Guest"`. `displayName` query param is silently ignored — the endpoint takes `user`, not `displayName`.
- `/poracer/lobby`: both contexts joined, saw "Players · 3/8" (Alice + Bob + 1 ghost from prior session). Real-time broadcast works.
- `/funquiz/multiplayer`: both contexts landed on the create-game screen. No "auto-join shared lobby" path on this page (unlike couplequiz).
- `/couplequiz/lobby`: both contexts landed on the create-game screen. Per-host code required to join each other; no shared-lobby affordance exposed.

## Telemetry / observability
- App Insights not configured → no correlation IDs flowing into live telemetry; only the in-process `0HNMVHMHQGGFF:…` shown on `/diag`.
- OTel exporter: not configured.
- Live Metrics: on (but with no destination).

---

# Top 10 ideas — fix problems + enhance app

## 1 — Strip the "XXX/0" padding rows from the leaderboards UI
**Where:** `/leaderboards` (single-player section)
**Problem:** Every game shows 10 rows of which 9 are the literal string `"XXX"` with score `0` — looks like 9 ghost players and confuses "how many people have played?". The Razor code intentionally renders them (`PlaceholderName = "XXX"`) but the visual effect is wrong: users see "Connect Five #1 Guest 1,104 / #2 XXX 0 / #3 XXX 0 …" and think those are real users.
**Fix:** Either (a) collapse empty boards to a single "No scores yet — be the first!" state with one row showing the current user's entry, or (b) only render rows where `Name != PlaceholderName` (the 2P and multiplayer sections already do this).
**Files:** [src/PoMiniGames.Client/Pages/LeaderboardsPage.razor:80](src/PoMiniGames.Client/Pages/LeaderboardsPage.razor#L80), `:115-120`.

## 2 — PoJoker defaults to "Any" category with safeMode=false → shows anti-vax joke on first run
**Where:** `/pojoker`
**Problem:** On first visit the show auto-starts and the first joke rendered is *"Jokes about anti-vaxxer parents never get old."* (Dark category). New users get hit with potentially offensive content before they've chosen anything. No content filter UI is shown on the landing page.
**Fix:** Default `_orchestrator.SelectedSafeMode = true` and `SelectedCategory = "Wholesome"` (or "Any" with safe mode on). Expose a category/safe filter inline above the "▶ FIGHT" CTA so the choice is explicit before the first joke plays.
**Files:** [src/PoMiniGames.Client/Games/PoJoker/Components/JesterStage.razor:62-65](src/PoMiniGames.Client/Games/PoJoker/Components/JesterStage.razor#L62-L65).

## 3 — PoJoker leaderboard ships placeholder character "WiseMage…" at rank #1 with 0/0%/0.0
**Where:** `/pojoker/leaderboard`
**Problem:** The 🥇 entry shows `WiseMage…` with `0` triumphs, `0.0%` success, `0.0` score. This looks like a real player record but is seeded/fixture data. Same "ghost player" anti-pattern as #1.
**Fix:** Either gate the leaderboard behind "at least one completed session" or surface "No champions yet — play a show to claim the throne" as the default state.
**Files:** [src/PoMiniGames/PoMiniGames/Features/PoJoker/JokerEndpoints.cs](src/PoMiniGames/PoMiniGames/Features/PoJoker/JokerEndpoints.cs) (seed data).

## 4 — Tic Tac Toe page is mislabeled: it's Connect 4 on a 6×6 board
**Where:** `/tictactoe`, `/tictactoe/{Demo:int}`
**Problem:** Page title says "Tic Tac Toe", icon is ❌, "How to play" dialog opens with the title "❌ Tic Tac Toe", but the actual game rules are *"Line up 4 in a row on the 6×6 board"* and the grid has 36 cells. The home page also calls it "Tic Tac Toe". New users will arrive expecting the classic 3×3 and bail.
**Fix:** Rename route + page to "Connect Six" (6×6, 4-in-a-row) or "Connect Four (6×6)" and update home-page card text. The internal `TicTacToePage.razor` should be renamed to `ConnectSixPage.razor`.
**Files:** [src/PoMiniGames.Client/Games/TicTacToe/TicTacToePage.razor](src/PoMiniGames.Client/Games/TicTacToe/TicTacToePage.razor), [src/PoMiniGames.Client/Pages/Index.razor](src/PoMiniGames.Client/Pages/Index.razor).

## 5 — PoMarbleRace canvas overflows the viewport on every device
**Where:** `/pomarblerace`, `/pomarblerace?demo=1`
**Problem:** The marble track `<canvas>` is 1327×840 in a 948×660 desktop viewport — extends 379px past the right edge and 281px below the fold. On a 390px mobile viewport it becomes unusable. Caused by canvas being sized to internal pixel dimensions rather than `min(100vw, 1327) × min(100vh, 840)`.
**Fix:** Replace fixed `canvas.width/height` with `clientWidth`/`clientHeight` and use `aspect-ratio: 1` or container-driven sizing. Add `@media (max-width: 480px) { canvas { width: 100vw; height: auto } }`.
**Files:** [src/PoMiniGames.Client/Games/PoMarbleRace/PoMarbleRacePage.razor](src/PoMiniGames.Client/Games/PoMarbleRace/PoMarbleRacePage.razor) + companion .razor.css.

## 6 — Mobile leaderboards: 4404px docH in an 844px viewport (5.2× overflow)
**Where:** `/leaderboards` (mobile)
**Problem:** Every board renders the full 10-row padded top-N (see #1), then stacks them in three region sections (`1 Player`, `2 Player`, `Multiplayer`). On a 390px phone the page is **5× taller than the viewport** — the user has to scroll past 30+ ghost rows per game before reaching any real content. Even with the #1 fix this will still be a long page; needs virtualization or an "expand to see top 10" affordance.
**Fix:** Show only **top 3 per board** on mobile (≤768px) with a "See full board →" link. Combined with #1 this drops mobile docH by ~60%.
**Files:** [src/PoMiniGames.Client/Pages/LeaderboardsPage.razor:115-120](src/PoMiniGames.Client/Pages/LeaderboardsPage.razor#L115-L120).

## 7 — `/auth/login/fake?displayName=X` silently ignores `displayName`
**Where:** dev login route
**Problem:** Per `AuthEndpoints.cs:127` the route binds `string? user`, **not** `displayName`. A curl/Puppeteer/Postman request with `?displayName=Alice` mints identity `dev-guest/Guest/guest@local.dev` silently — there's no 400 for unknown query params, no warning, no log line. Two browser contexts calling `?displayName=Alice` and `?displayName=Bob` end up as the same user, which is a footgun for E2E tests and for anyone copy-pasting the AGENT.MD example.
**Fix:** Either (a) accept `displayName` as an alias of `user`, or (b) reject unknown query params with a 400. Add a `[FromQuery(Name = "user")]` + `[FromQuery(Name = "displayName")] string?` and document both names in the route XML summary.
**Files:** [src/PoMiniGames/Features/Auth/AuthEndpoints.cs:127](src/PoMiniGames/Features/Auth/AuthEndpoints.cs#L127).

## 8 — PoCoupleQuiz `/game` page is a dead-end: "Waiting for the round to start…" with no controls
**Where:** `/couplequiz/game`
**Problem:** When a player navigates directly to `/couplequiz/game` (deep-link, refresh, etc.) the page renders only `Waiting for the round to start…` with no "Back to lobby" link, no host identification, no reconnect affordance. The Hub expects a `JoinGame` from the lobby first; if that didn't happen the player is stuck.
**Fix:** (a) Auto-redirect to `/couplequiz/lobby` if `_state == null && !_joined`, or (b) render an inline "You haven't joined a game — go to lobby" card with a CTA button. Same pattern probably applies to `/funquiz/multiplayer` deep-links.
**Files:** [src/PoMiniGames.Client/Games/PoCoupleQuiz/PoCoupleQuizGamePage.razor](src/PoMiniGames.Client/Games/PoCoupleQuiz/PoCoupleQuizGamePage.razor), [src/PoMiniGames.Client/Games/PoFunQuiz/PoFunQuizMultiplayerPage.razor](src/PoMiniGames.Client/Games/PoFunQuiz/PoFunQuizMultiplayerPage.razor).

## 9 — Profile page is 1235px tall on a 768 desktop — best streak shows `—`
**Where:** `/profile`
**Problem:** Profile has 6 stacked sections (Header KPIs → High Scores → Head-to-Head → Win Rate chart → Overall Record → Game Breakdown → Best Game card) which together scroll the user past 4× the viewport on first load. The "Best Streak" KPI shows a literal em-dash `—` for users who haven't played PoClick — should be a real empty-state ("Play PoClick to set your first streak!").
**Fix:** (a) On `<=1024px` collapse the side-by-side chart cards into a single column and shorten the Game Breakdown rows; (b) replace `—` empty KPI values with a one-line hint + icon.
**Files:** [src/PoMiniGames.Client/Pages/ProfilePage.razor](src/PoMiniGames.Client/Pages/ProfilePage.razor).

## 10 — App Insights not configured → live telemetry path is dormant; "Live Metrics" toggle is misleading
**Where:** `/diag`, every endpoint's correlation flow
**Problem:** `/api/diag` reports `applicationInsightsConfigured: not-configured` and `OTel exporter: —`. The UI shows "Live Metrics: on / Sampling: 1.00" — but there's no destination. The status banner on the home page is similarly silent. Users/operators have no way to verify what telemetry is actually being shipped from this build, which makes incident response blind. From a user POV it's also a regression risk: every page load logs "App Insights not configured" warnings into the dev console that aren't actionable.
**Fix:** (a) When `applicationInsightsConfigured == false`, the `/diag` "Live Metrics: on" toggle should be hidden or replaced with "Local only — set `APPLICATIONINSIGHTS_CONNECTION_STRING` to ship traces"; (b) add a banner on `/diag` and the home page when the connection string is missing in Dev so it's not silent; (c) in the API log filter section, only show "Filter by correlation" when there's something to filter.
**Files:** [src/PoMiniGames.Client/Pages/DiagPage.razor](src/PoMiniGames.Client/Pages/DiagPage.razor), [src/PoMiniGames/Features/Diagnostics/](src/PoMiniGames/Features/Diagnostics/).

---

## Bonus observations (would have made the cut if size wasn't tight)

- **PoSurvive is a different visual identity inside the same shell.** The "AGENT SURVIVAL COMMAND DECK" has its own banner, button styles, and color palette — `developer tools` icon and `🔧` collapse panel appear in the top bar. From the home page the user clicks "🛡️ PoSurvive" expecting the same polished tile-grid; instead they land in a tactical terminal. Acceptable if intentional, jarring if not.
- **Home page taxonomy is duplicative.** Connect Five / PoBrawl / PoClick / PoMarbleRace / PoRacer all appear in **both** the "Demo" row and the "1 Player" row — they share the same underlying games, just with different default modes. A new user can't tell why Connect Five is listed twice.
- **Tic Tac Toe / Connect Five / PoBrawl / PoJoker all show a "How to play" dialog on first visit** even after dismissing it — `localStorage` key may not be persisted across browser sessions, so every fresh visitor sees the modal. The `pomini_howto_pobrawl` key works (per memory); the others probably need the same `localStorage.setItem('pomini_howto_X', '1')` pattern.
- **Top bar "🔧 Developer tools" panel** is collapsed but its `[hidden]` markup is still 16 elements tall (0px height) — these should be `display: none` until opened, not just 0-height, to keep the DOM tree clean for screen readers.

## Files / artifacts

- Audit script: [scripts/netrun10-audit.mjs](scripts/netrun10-audit.mjs)
- Multiplayer script: [scripts/netrun10-multiplayer.mjs](scripts/netrun10-multiplayer.mjs)
- JSON dump: [docs/audit-2026-07-11/audit.json](docs/audit-2026-07-11/audit.json)
- MP results: [docs/audit-2026-07-11/mp_results.json](docs/audit-2026-07-11/mp_results.json)
- Screenshots: 13 desktop PNGs in [docs/audit-2026-07-11/](docs/audit-2026-07-11/) (`desktop___.png` etc.)
- MP screenshots: [docs/audit-2026-07-11/mp_lobby_A.png](docs/audit-2026-07-11/mp_lobby_A.png) + `_B` variants for lobby/funquiz/couplequiz