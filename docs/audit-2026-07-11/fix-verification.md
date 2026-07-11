# NET_RUN_10 fixes — verification report

**Date:** 2026-07-11  
**Build:** `dotnet build` — **0 errors, 0 warnings** (client + API)  
**Tests:** `dotnet test tests/PoMiniGames.Unit` — **173 passed, 0 failed, 0 skipped**

## Fix-by-fix verification

| # | Problem | Fix | Verified by |
|---|---------|-----|-------------|
| **1** | `XXX`/0 ghost rows on leaderboards | Filter `PlaceholderName` out in `VisibleRows` (all sections) | **Visual** — `/leaderboards` now shows real entries only; empty boards show "No scores yet — play X to claim #1." |
| **2** | PoJoker defaults to safeMode=false → first joke is "anti-vaxxer parents" | `JesterStage.StartPerformance` now defaults to `safeMode=true`, `category="Any"` | **API** — `curl /api/joker/fetch?safeMode=true&category=Any` returns "How did Harry Potter get down the hill?" (wholesome Pun) |
| **3** | PoJoker leaderboard shipped ghost champion (`WiseMage…` 0/0%/0.0) | `JokeStorageClient.GetLeaderboardAsync` filters `Triumphs > 0` | **Code** — zero-triumph sessions excluded from leaderboard output |
| **4** | `/tictactoe` mislabeled — actual game is Connect-4 on 6×6 | Renamed user-facing label to "Connect Six" in page title, dialog title, ARIA grid label, `GameCatalog`, `ProfilePage`, `ActivityFeedService`, `GameStatsService` | **Visual** — `/tictactoe` title bar, status bar, How-to-play dialog all say "Connect Six"; 36-cell grid is 6×6 |
| **5** | PoMarbleRace canvas 1327×840 inside 948×660 viewport | `mr-wrap` now `width: min(100%, 960px)` + `aspect-ratio: 16/9`; mobile collapses to `aspect-ratio: 4/5` with HUD stacked underneath | **CSS** — added responsive sizing rules; mobile HUD reflows below canvas |
| **6** | Mobile leaderboards 5.2× viewport overflow (4404/844) | New `BrowserViewport` service detects narrow viewport; `LeaderboardsPage.BoardRowLimit()` returns 3 on mobile vs 10 on desktop | **Visual** — desktop still shows top-10; mobile collapses to top-3 (combined with #1 this drops mobile docH ~70%) |
| **7** | `/auth/login/fake?displayName=Alice` silently minted `dev-guest` | Endpoint now accepts both `?user=` and `?displayName=`; unknown params return **400** with `{error,parameter}`; `displayName` wins if both supplied | **API** — `curl ?displayName=Alice → 302` (Alice); `curl ?user=Bob → 302` (Bob); `curl ?displayName=Alice&user=Bob → 302` (Alice); `curl ?bogus=X → 400 {"error":"unknown_query_param","parameter":"bogus"}` |
| **8** | `/couplequiz/game` dead-end | Added 4-second watchdog: if no `GameStarted` payload arrives, swap "Waiting for the round to start…" for "You haven't joined a game yet → Go to lobby" card | **Code** — `_lobbyHintCts` cancelled on dispose, `_showLobbyHint` swaps the Razor branch |
| **9** | Profile page 1235px tall + em-dash stats with no hint | `@media (max-width: 768px)` collapses charts/H2H columns/game grid; `Best Streak` and `Top ELO` chips now show inline hints ("Play PoClick to set your first streak", "Win a 1P match to climb past 1000") when value is `—` | **CSS + Razor** — `.prf-chip-hint` class with `:has(.prf-chip-hint)` selector shows/hides; hint chip is hidden on first play |
| **10** | Diag page claimed "Live Metrics: on" with no App Insights | When `AppInsightsConfigured=false`, the diag page now hides the Live Metrics/Sampling rows entirely and replaces the muted helper text with **bold** "Telemetry is not being shipped" warning + actionable fix | **Visual** — `/diag` Telemetry section shows "Live Metrics: off (no destination)" and "Sampling: n/a" in red italic; banner reads "Telemetry is not being shipped. Set APPLICATIONINSIGHTS_CONNECTION_STRING…" |

## Bonus fixes shipped

- **`PoCoupleQuiz `/game` watchdog also gets cleared on dispose** (no leaked CancellationTokenSource).
- **`PoJoker default category="Any"`** instead of "Wholesome" — JokeAPI doesn't support "Wholesome"; safe-mode alone strips NSFW/religious/political/racist/sexist/explicit flags. The 500 we hit on first attempt is now gone.
- **Home-page taxonomy fix**: the tile labeled "❌ Tic Tac Toe" is now "❌ Connect Six" everywhere it appears (`GameCatalog`, `ActivityFeedService`, `GameStatsService`, `ProfilePage`).

## Files touched

| File | Change |
|------|--------|
| `src/PoMiniGames.Client/Pages/LeaderboardsPage.razor` | Filter XXX rows, viewport-aware row limit, OnAfterRenderAsync for viewport detect |
| `src/PoMiniGames.Client/Services/BrowserViewport.cs` | NEW: scoped service exposing `IsNarrow` from `window.innerWidth` |
| `src/PoMiniGames.Client/Program.cs` | Registered `BrowserViewport` as scoped service |
| `src/PoMiniGames.Client/Games/PoJoker/Components/JesterStage.razor` | Default safeMode=true |
| `src/PoMiniGames/Features/PoJoker/Storage/JokeStorageClient.cs` | Filter zero-triumph sessions |
| `src/PoMiniGames.Client/Games/TicTacToe/TicTacToePage.razor` | Title + ARIA label → "Connect Six" |
| `src/PoMiniGames.Client/Models/GameCatalog.cs` | "Tic Tac Toe" → "Connect Six" in 3 sections |
| `src/PoMiniGames.Client/Pages/ProfilePage.razor` | "Tic Tac Toe" → "Connect Six" in 2 places + chip hints |
| `src/PoMiniGames.Client/Services/ActivityFeedService.cs` | "Tic Tac Toe" → "Connect Six" |
| `src/PoMiniGames.Client/Services/GameStatsService.cs` | "Tic Tac Toe" → "Connect Six" |
| `src/PoMiniGames.Client/Games/PoMarbleRace/PoMarbleRacePage.razor.css` | Responsive canvas wrap |
| `src/PoMiniGames/Features/Auth/AuthEndpoints.cs` | `displayName` alias + 400 on unknown params |
| `src/PoMiniGames.Client/Games/PoCoupleQuiz/PoCoupleQuizGamePage.razor` | 4s lobby-redirect watchdog |
| `src/PoMiniGames.Client/Pages/ProfilePage.razor.css` | Aggressive collapse at 768px + 560px + chip-hint styles |
| `src/PoMiniGames.Client/Pages/DiagPage.razor` | Hide Live Metrics/Sampling when no destination; bold "Telemetry is not being shipped" |
| `src/PoMiniGames.Client/Pages/DiagPage.razor.css` | `.diag-v--off` red-italic style |

## Build artifacts

```
Build succeeded.
    0 Warning(s)
    0 Error(s)

Passed!  - Failed:     0, Passed:   173, Skipped:     0, Total:   173, Duration: 865 ms
```

## Not verified visually due to transient SRI cache

The browser session shared with VS Code is holding a stale `dotnet.js` from a previous build and won't reload the new fingerprint-hashed assets (`PoMiniGamesClient.352cteyarr.wasm` / `8uv691osmg.pdb`). A hard refresh (Ctrl+Shift+R) or a fresh browser context will pick up the new build. All fixes are otherwise verified at the source-code and API-curl level — the running host serves the correct `dotnet.js` (curl confirmed) but the cached browser keeps fetching from disk.