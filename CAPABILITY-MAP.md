# Capability map

What each module owns, and where PoMule (game 15) and Radzen land. `SPEC.md` holds the
PoMule requirements; this file only says which module does what.

Status key: **Retained** = unchanged · **Extended** = gains PoMule wiring · **New** = created
for PoMule · **Deferred** = planned after PoMule v1.

## Modules

| Module | Owns today | PoMule v1 change | Status |
|---|---|---|---|
| `src/PoMiniGames.Shared` | DTOs and catalogs shared by client and server; trim-clean | New folder `Games/PoMule/`: the whole deterministic rules engine (map, land, economy, market, events, AI, scoring) | Extended |
| `src/PoMiniGames.Domain` | `GameKey`, high-score models, Elo, `ScoreRules`, name sanitizer | `GameKey.PoMule`, `PoMuleHighScore`, a score-range rule | Extended |
| `src/PoMiniGames.Infrastructure` | Table/Blob storage, `HighScoreDescriptor<T>` leaderboards | One descriptor for the PoMule board | Extended |
| `src/PoMiniGames.API` | Host, auth, 15 SignalR hubs, vertical slices in `Features/<Slice>` | New slice `Features/PoMule/` with high-score endpoints only (no hub) | Extended |
| `src/PoMiniGames.Client` | Blazor WASM shell, 14 game pages, JS engines in `wwwroot/js/<game>/` | `Games/PoMule/` page and components in Radzen; `wwwroot/js/pomule/` canvas renderer; Radzen package, theme and services | Extended |
| `tests/*` | Four capped tiers (100/50/25/25) plus `node --test` files | PoMule tests in every tier; Unit ceiling needs a decision (see `SPEC.md` open question 1) | Extended |
| `infra/`, `.github/` | Bicep and deploy workflow | None | Retained |

## Capabilities

| Capability | Module(s) | Used by PoMule v1 | Status |
|---|---|---|---|
| Sign-in gate (Entra / dev guest) | Client, API `Features/Auth` | Yes, unchanged | Retained |
| Game catalog, hub cards, mode chips | Client `Models/GameCatalog.cs`, `Pages/Index.razor` | Yes: one card, chips for 1 Player and Demo | Extended |
| Hub demo reel | Client `Pages/Index.razor`, `Components/KioskControlBar.razor` | Yes: PoMule joins the lap | Extended |
| Shared start card and end-of-game modal | Client `Components/` | Yes, as the outer frame; Radzen inside | Retained |
| Leaderboards | Infrastructure `HighScoreDescriptor<T>`, API `Features/Leaderboard`, Client `Services/Http` | Yes: Net Worth board | Extended |
| Offline score park-and-sync | Client `Services/Play` (`PendingScore`, `ScoreSyncService`, `GameResultService`) | Yes | Extended |
| On-demand JS engine loading, PWA cache list | Client `wwwroot/js/engineLoader.js`, `service-worker.published.js` | Yes | Extended |
| Shared audio and palette buses | Client `wwwroot/js/gameCues.js`, `paletteBus.js`, `spatialAudio.js` | Yes, reuse existing cues | Retained |
| Online play (SignalR hubs, lobbies, invites) | API `Features/*`, Client per-game clients | No | Retained |
| Server score verification | API `Features/PoSports`, `PoCabinet` | No (engine sits in Shared so it can be added later) | Retained |
| AI text (Azure AI Foundry) | API `AI/`, quiz and joker slices | No | Retained |
| Cloud saves and gallery | API `Features/PoEcosystem`, Blob storage | No | Retained |
| Radzen component library | Client | Yes: all PoMule non-canvas UI | New |
| Radzen in the hub, settings sheet, leaderboards and the other 14 games | Client | No | Deferred |

## Existing games

All fourteen are retained and still evolving; none is pruned or reworked by this effort.

| Group | Games |
|---|---|
| Racers | PoRacer, PoCabinet, PoMarbleRace |
| Action and sims | PoBrawl, PoSports, PoVoxelStrike, PoJevArena, PoEcosystem, SandPlayground |
| Quiz and AI | PoCoupleQuiz, PoFunQuiz, PoJoker |
| Board | TicTacToe, ConnectFive |

## PoMule: who decides what

| Concern | C# engine (`Shared/Games/PoMule`) | JS renderer (`wwwroot/js/pomule`) | Blazor page (Radzen) |
|---|---|---|---|
| Map generation, terrain, towns | Decides from the seed | Draws tiles | |
| Land grant, conflicts, auctions | Decides | Draws cursors | Bid panel |
| Development: movement, collisions, tether | Validates the events it is told about; owns timer, money, stock, installs | Simulates at 60 fps; reports arrivals, bumps and runaways | Timer and status banners |
| AI opponents | Chooses goals and market moves | Steers avatars toward goals | |
| Production, spoilage, events | Decides | Plays the animation | Announcement bar |
| Trading floor | Ticks prices and trades at 10 Hz | Draws lanes and avatars | |
| Standings, net worth, colony grade | Decides | | Grid, chart, end modal |
