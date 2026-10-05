# PoMule task list

Plan and risks: `tasks/plan.md`. Requirements: `SPEC.md`. Tick a box when its commit lands.

Each task: failing test → code → related tests → `dotnet build PoMiniGames.slnx` (0 warnings)
→ restart the app when runtime code changed → one commit, pushed. Unit methods are budgeted
in brackets; total 38 of the 40 new slots.

- [x] **T0 Docs.** Write `tasks/plan.md`, `tasks/todo.md`; commit with `SPEC.md` and
  `CAPABILITY-MAP.md`. *Accept:* files exist and match this plan.
- [x] **T1 Radzen spike.** Files: `Directory.Packages.props`, `PoMiniGamesClient.csproj`,
  `_Imports.razor`, `Program.cs`. Add Radzen 12.0.5 and `AddRadzenComponents()`; bump ASP.NET
  pins as needed. *Accept:* build has 0 warnings; `dotnet publish src/PoMiniGames.API -c Release`
  succeeds; `pwsh scripts/bundle-report.ps1` before and after shows ≤ 1.5 MB growth.
  *Deps:* none.
- [x] **T2 Ceiling, RNG, map.** Files: `tests/PoMiniGames.Unit/TestCountCeilingTests.cs`
  (100 → 140), `PoMuleRng.cs`, `PoMuleMap.cs`, `PoMuleMapTests.cs`. [4] *Accept:* 24×8, 4
  towns, wrap distance, same seed gives same map. *Verify:* `dotnet test tests/PoMiniGames.Unit
  --filter "FullyQualifiedName~PoMule"`; `pwsh scripts/test-ceilings.ps1`.
- [x] **T3 Species, state, scoring.** Files: `PoMuleSpecies.cs`, `PoMuleState.cs`,
  `PoMuleTuning.cs`, `PoMuleScoring.cs`, `PoMuleScoringTests.cs`. [3] *Accept:* 8 species with
  PRD funds; Net Worth formula; colony grade rule. *Deps:* T2.
- [x] **T4 Land.** Files: `PoMuleLand.cs`, `PoMuleLandTests.cs`. [4] *Accept:* contested tile
  has one winner, losers get nearest free plot by wrapped spiral, 1,000 seeds with no double
  ownership; auction on even months, highest affordable bid wins. *Deps:* T3.
- [ ] **T5 Development.** Files: `PoMuleDevelopment.cs`, `PoMuleDevelopmentTests.cs`. [6]
  *Accept:* buy, outfit, install, swap, assay, pub payout, three runaway causes, food speed
  factor, starvation skip, every refusal case in SPEC §12. *Deps:* T3.
- [ ] **T6 Production and events.** Files: `PoMuleProduction.cs`, `PoMuleEvents.cs`,
  `PoMuleProductionTests.cs`. [5] *Accept:* yields with species bonuses, energy shutdown
  order, spoilage, six events. *Deps:* T5.
- [ ] **T7 Market.** Files: `PoMuleMarket.cs`, `PoMuleMarketTests.cs`. [5] *Accept:* trade
  fires when bid meets ask, at that price, one unit per 0.25 s; stops on no cash or no goods;
  Store as last resort; monthly Store price move; Smithore to M.U.L.E. conversion. *Deps:* T6.
- [ ] **T8 AI.** Files: `PoMuleAi.cs`, `PoMuleAiTests.cs`. [5] *Accept:* each of 7 archetypes
  shows its defining behaviour in a scripted state (for example Hoarder holds Food below the
  cap price). *Deps:* T7, T4.
- [ ] **T9 Match driver and balance.** Files: `PoMuleMatch.cs`, `PoMuleSave.cs` (with JSON
  context), `PoMuleMatchTests.cs`, Verify snapshot file. [6] *Accept:* phase order; snapshot
  layout; determinism; save round trip; 100 seeded matches meet criteria 8 and 11; Demo
  timing rule. *Verify:* add `--collect:"XPlat Code Coverage"`; ≥ 90% on the engine folder.
  *Deps:* T8.
- [ ] **T10 Domain.** Files: `Domain/Primitives/GameKey.cs`, `Domain/Models/PoMuleHighScore.cs`,
  `Domain/Services/ScoreRules.cs`, `tests/…/Domain/ScoreRulesTests.cs` (rows only). [0]
  *Accept:* `GameKey.TryParse("pomule")` works; bounds 0 to 500,000, higher is better.
- [ ] **T11 Storage.** Files: `IStorageService.cs`, `StorageService.cs`,
  `StorageService.HighScores.cs`, `Features/Account/PlayerDataService.cs`,
  `tests/PoMiniGames.Integration/Features/PoMule/PoMuleHighScoreTests.cs`. *Accept:* save, read
  and best-score ratchet against Azurite (+2 integration methods → 48/50). *Deps:* T10.
- [ ] **T12 API.** Files: `Features/PoMule/PoMuleEndpoints.cs`, `EndpointRouteExtensions.cs`,
  `UnifiedLeaderboardEndpoints.cs`, `tests/PoMiniGames.E2EAPI/PoMuleEndpointsTests.cs`.
  *Accept:* anonymous is refused, valid POST is 201, out-of-range is 400, unified board lists
  PoMule (+1 method → 25/25). *Deps:* T11.
- [ ] **T13 Client API.** Files: `Client/Models/GameKey.cs`, `GameModels.cs`,
  `ApiJsonContext.cs`, `ApiService.cs`. *Accept:* builds trim-clean. *Deps:* T12.
- [ ] **T14 Score sync.** Files: `PendingScore.cs`, `ScoreSyncService.cs`,
  `GameResultService.cs`. *Accept:* `RecordAndSubmitPoMuleAsync` parks when offline. *Deps:* T13.
- [ ] **T15 JS world and physics.** Files: `js/pomule/world.js`, `js/pomule/physics.js`,
  `tests/pomule-world.test.mjs`, `tests/pomule-physics.test.mjs`. *Accept:* wrap, camera across
  the seam, mass-based push, Bonz never displaced, tether snap. *Verify:* `node --test
  tests/pomule-*.test.mjs`. *Deps:* T2.
- [ ] **T16 Page shell.** Files: `Games/PoMule/PoMulePage.razor`, `.razor.cs`, `.razor.css`,
  `Models/GameCatalog.cs` (1 Player only), `js/pomule/index.js` (+ `engineLoader.js` and
  `MainLayout.razor` one-line entries). *Accept:* `/pomule/1player` shows the start card with
  a Radzen species picker; map draws and scrolls across the seam; leaving the page removes
  Radzen CSS. Screenshot. *Deps:* T1, T9, T14, T15, Phase 3.
- [ ] **T17 Development live.** Files: `js/pomule/index.js`, `js/pomule/avatars.js`,
  `PoMulePage.razor.cs`, `Games/PoMule/PoMuleHud.razor` (+ css). *Accept:* 8 avatars move at
  once; buying, installing, pub and runaways work by hand; HUD banners, timer and
  announcement bar update. *Deps:* T16.
- [ ] **T18 Land UI.** Files: `js/pomule/land.js`, `Games/PoMule/PoMuleAuction.razor`,
  `PoMulePage.razor.cs`. *Accept:* 8 cursors, 10 s grant, auction bids. *Deps:* T17.
- [ ] **T19 Market UI.** Files: `js/pomule/market.js`, `PoMulePage.razor.cs`. *Accept:* 8
  lanes, Store in the middle, trades visible. Screenshot. *Deps:* T18.
- [ ] **T20 Standings, submit, resume.** Files: `Games/PoMule/PoMuleStandings.razor`,
  `Games/PoMule/PoMuleSaveStore.cs`, `PoMulePage.razor.cs`, `Program.cs`. *Accept:* grid and
  chart each month; score on the board after month 12; reload offers Continue. *Deps:* T19.
- [ ] **T21 Touch.** Files: `js/pomule/touch.js`, `PoMulePage.razor.css`, `js/pomule/index.js`.
  *Accept:* stick, action and dash on coarse pointers; rotate prompt in portrait. *Deps:* T17.
- [ ] **T22 Demo and reel.** Files: `PoMulePage.razor.cs`, `Models/GameCatalog.cs` (Demo mode
  and reel array), `Pages/Index.razor.css` (grid for 16 cells),
  `tests/PoMiniGames.E2EUI/PoMuleUiTests.cs`. *Accept:* `/pomule/demo` plays 12 months in 5–8
  min with no score post; `Kiosk.MarkFinished()` at the end; 2 Playwright methods (→ 25/25).
  *Deps:* T20.
- [ ] **T23 Docs and trim.** Files: `README.md` (fifteen games, Radzen note, Unit cap 140),
  `js/paletteBus.js`, `js/gameCues.js`, the "Unit 100" message in `scripts/test-ceilings.ps1`, stale "fourteen" comments in `Index.razor` and
  `LeaderboardsPage.razor`. *Accept:* `css-lint.ps1` passes. *Deps:* T22.

Blast radius: only the files listed. Anything else needed is raised first.
