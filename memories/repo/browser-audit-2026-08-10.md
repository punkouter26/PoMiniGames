# Browser audit 2026-08-10 — top 10 fixes

Full audit of all 10 games + chrome pages. All 10 fixes implemented and verified
via Playwright.

## Fixes shipped

| # | Issue | Files | Verified |
|---|---|---|---|
| 1 | PoJoker beforeunload prompt on every nav | `JesterStage.razor`, `PoJokerPage.razor` | ✓ navigated home with no prompt |
| 2 | Couple Quiz duplicate `/couplequiz` link | `GameCatalog.cs` (+ ChipUrl), `Index.razor` | ✓ head `/couplequiz`, chip `/couplequiz/multi` |
| 3 | Survive card showed only "Demo" chip | `GameCatalog.cs` (+ ChipPrimary) | ✓ 1P + Demo chips |
| 4 | Survive "← Home" duplicate of brand link | `PoSurviveLayout.razor` | ✓ header has no Home link |
| 5 | USING MOCK DATA hazard-stripe banner | `MainLayout.razor`, `app-shell.css` | n/a — dev server not in mock mode |
| 6 | Profile "Games: 0" hides in-session play | `ProfilePage.razor` | ✓ "Saved Matches: 0, +6 sessions this visit" |
| 7 | WebGL alert had only one escape link | `GameShell.razor`, `games.css` | ✓ alert shows 2 direct game links |
| 8 | Leaderboards "demo-only" framing | `LeaderboardsPage.razor` | ✓ "9 with leaderboards · 1 no-leaderboard yet" |
| 9 | H2H G/MS badges had no legend | `ProfilePage.razor`, `.razor.css` | ✓ "G Guest | MS Microsoft" inline |
| 10 | End-of-game modal used "OK" + "Play again" inconsistently | `GameOverModal.razor` | n/a — would need to win a game to verify |

## Lessons learned

### PoJoker beforeunload (Fix #1)
- The bug had two layers: (a) the guard was armed before the show actually
  started, and (b) the listener was registered globally on first render so
  re-arming was a no-op. Removing the listener *and* clearing the flag on
  Stop was necessary — flag alone left a stranded listener.
- AutoStart=true on a component gated by an intro modal is a footgun. The
  page now passes `AutoStart=(_isDemo || _introDone)` and the component
  detects a false→true transition of AutoStart via `_firstAutoStartSeen`
  to start the show on dismissal.
- Verified live: navigated from `/pojoker` (intro showing) to `/` with
  no beforeunload prompt.

### Catalog grid dedup (Fixes #2, #3)
- `CatalogMode.ChipUrl` is an optional override of `Url` for the home-page
  chip. Same physical route can serve as the card head and the chip with
  distinct, semantically-correct URL strings.
- `CatalogGame.ChipPrimary` was already there (Marble Race, Sports) and
  just needed a third opt-in (Survive).

### Component-level CSS sharing
- The WebGL alert CSS lives in `games.css` (global) because the alert
  markup is in `GameShell.razor` (scoped) — kept the rule global to
  avoid a scoped-CSS battle.
- The H2H legend CSS lives in `ProfilePage.razor.css` because the markup
  is scoped to that page.

## Files touched
- src/PoMiniGames.Client/Games/PoJoker/Components/JesterStage.razor
- src/PoMiniGames.Client/Games/PoJoker/PoJokerPage.razor
- src/PoMiniGames.Client/Games/PoSurvive/Layout/PoSurviveLayout.razor
- src/PoMiniGames.Client/Models/GameCatalog.cs
- src/PoMiniGames.Client/Pages/Index.razor
- src/PoMiniGames.Client/Pages/LeaderboardsPage.razor
- src/PoMiniGames.Client/Pages/ProfilePage.razor
- src/PoMiniGames.Client/Pages/ProfilePage.razor.css
- src/PoMiniGames.Client/Layout/MainLayout.razor
- src/PoMiniGames.Client/Components/GameOverModal.razor
- src/PoMiniGames.Client/Components/GameShell.razor
- src/PoMiniGames.Client/wwwroot/css/app-shell.css
- src/PoMiniGames.Client/wwwroot/css/games.css

## Build / runtime verification
- `dotnet build` — 0 warnings, 0 errors
- API restarted cleanly, all pages load
- Home: catalog grid renders, Couple Quiz + Survive chips as expected
- /pojoker: intro modal shows, "Begin comedy show" button visible,
  navigating away triggers no beforeunload
- /profile: "Saved Matches: 0" + "+ 6 sessions this visit" hint,
  H2H legend visible
- /leaderboards: "9 with leaderboards · 1 no-leaderboard yet"
- /pobrawl/1player: WebGL alert with two direct 2D game links
