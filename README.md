# PoMiniGames

Instant-play mini-games platform: a .NET 10 Minimal API host that also serves its
Blazor WebAssembly client from a single origin (port 5080), with SignalR for real-time
multiplayer, Azure Table Storage for persistence, and opt-in Azure AI Foundry models behind
the two quizzes.

## Overview

Fourteen small games on one website. The browser runs each game in full, including its
computer opponents; the server signs players in, referees online play, checks and stores
scores, and, only when a player opts in, talks to AI models on the player's behalf.

- **One origin.** The API host serves the Blazor client it is then called by, so there is no
  cross-site setup in production.
- **Each game is a Razor page plus a JavaScript engine** (`wwwroot/js/<game>/`), loaded on
  demand and wired together with JS interop callbacks.
- **Online play runs over 15 SignalR hubs.** Match, lobby and race state is held in server
  memory and is lost on restart.
- **PoBrawl's online 1v1 uses rollback netcode.** Both browsers and the server run the same
  integer, 60 Hz fight sim, written twice to give bit-identical results
  (`Shared/Games/PoBrawlRollbackSim.cs` and `wwwroot/js/pobrawl/rollbackSim.js`). Your own
  keys apply at once, two frames ahead; the opponent is predicted and the fight is
  re-simulated when their real input arrives. The match hub relays frame-stamped inputs
  (`matchInput`, echoed to everyone with the frame the server applied them on) and answers
  `Ping` for clock sync. Snapshots (`matchState`, the full sim state plus a checksum) go out
  at 10 Hz. The server decides which frame each input lands on and is the only source of the
  result. Corrections are presented, not hidden: a rollback that moves a fighter plays a
  2–3 frame chromatic smear, an unconfirmed swing trails a faint ghost, and a signal meter
  beside the corner pill shows the round trip and rollbacks per second.
- **Haptics are one platform layer.** `wwwroot/js/impactBus.js` gates every controller rumble
  and phone vibration in the app: the Haptics setting (`pomini_haptics`, on by default), reduced
  haptics under reduced motion, and rate and duty caps so nothing holds a motor on. PoBrawl
  routes rumble to the local human only (`js/pobrawl/haptics.js`): a rising pulse while a strike
  charges, a tick on a perfect guard, thumps scaled by the hit, a long KO thud.
- **No database.** Scores, ratings, saves and AI spend ledgers live in Azure Table Storage;
  PoEcosystem world files live in Blob Storage. A player is whoever the sign-in token says
  they are; there is no Player table.
- **Computer opponents are hand-written rules, not trained models.** Difficulty is a table of
  numbers in source.
- **Free by default; paid AI is opt-in.** PoFunQuiz deals from a permanent question bank
  (Open Trivia DB plus a bundled set, stored in the `PoFunQuizBank` table), and PoCoupleQuiz
  uses a curated bank with free fuzzy answer matching (`AnswerMatcher`). A signed-in player can
  pick *Fresh AI* questions or the *AI judge* (Azure AI Foundry, `gpt-5.4-nano`). PoJevArena's
  battle calls come from a free local rules brain; TypeSafe's Jev (OpenRouter) answers only when
  `PoMiniGames:Jev:Brain` is `Jev` and the player picks it in Settings, and an on-device WebLLM
  model (`js/localAi.js`, off by default) can serve it in the browser instead. Paid calls have a
  daily cap per player and fall back to the free path. Ecosystem, Brawl and Cabinet use no AI
  service: their commentary is scripted.
- **Around the games.** The hub has a *Today* card (one seeded daily game for everyone, with a
  cross-game streak), a *Continue* strip, pins and filters, and launches games without
  rebooting the app. Leaderboards have all-time and weekly boards. The profile shows
  achievements. PoRacer and PoMarbleRace race your best-run ghost. Gamepads work in every game
  and on the hub. The game-over sheet can share a result card. Settings is a side drawer.
- **Works offline.** A score that cannot reach the server is parked in the browser and sent
  automatically later.

### Documentation

| Document | What it covers |
|---|---|
| [Architecture & game loop](DOCS/20261003/architecture_overview.md) | How agents look, decide and act; scoring rules; tuning settings |
| [Agent & rig inventory](DOCS/20261003/model_summary.md) | Every computer-controlled character, its source file and physics setup |
| [Creature dashboard](DOCS/20261003/creatures_dashboard.html) | Abilities grid with an Executive / Technical toggle |
| [Level & arena setup](DOCS/20261003/scene_layout.html) | To-scale arena drawings, spawn points, hazards, collision layers |
| [Performance comparison](DOCS/20261003/creature_benchmarks.html) | Skill by difficulty, smoothness, update rates and running cost |
| [Training charts guide](DOCS/20261003/training_metrics_guide.md) | The four training charts in plain English, and what stands in for them here |
| [Architecture map](https://claude.ai/artifact/HGHLwMdGyveqtknNC1o5ar) | Component diagrams, request flows and the data model (private link; share it from the page to give others access) |

## Games (`src/PoMiniGames.Client/Games/`)

| Game | One-liner |
|---|---|
| TicTacToe | 4-in-a-row on 6×6 vs AI, hot-seat, or online quick-match (SignalR) |
| ConnectFive | Five-in-a-row vs AI, hot-seat, or online quick-match (SignalR) |
| PoBrawl | Physics brawler with a presidents ladder, an 8-fighter CPU tournament (`/pobrawl/tournament`, random draw, Elo after every bout; golden-hour → dusk → night arena, an Elo-upset crowd, an animated bracket and a belt ceremony; a TV-style director camera with a picture-in-picture iso cam in demo and tournament; 1P/2P/online keep a plain side view); a showtime layer of charge auras and president motifs over a crowd that stomps and chants, plus — with the settings sheet's **Brawl show** set to Full (`pobrawl_show`; Simple is the default) — convention balloon drops, LED ribbon boards, a stadium wave, an instant replay, a glass result screen, the belt ceremony and the director camera; live 3D fighter select; an election-night campaign map for the ladder + fighter Elo demo board; **Brawl HQ** (`/pobrawl/hq`) puts the ladder, campaign map, local record, the ladder / fastest-KO / fighter-Elo boards and Cup titles on one page |
| PoCoupleQuiz | Two-player realtime couples quiz (SignalR); curated questions, free answer matching, opt-in AI judge |
| PoFunQuiz | Multiplayer trivia lobby from a free question bank (opt-in Fresh AI questions) |
| PoMarbleRace | Physics marble race on baked GLB tracks; online 2-player via host-streamed physics |
| PoRacer | Canvas racer with WebGL effects, solo races, and a multiplayer lobby |
| PoCabinet | 3D circuit racer: solo career across four tracks, AI officials, and a server-simulated online lobby |
| PoVoxelStrike | Third-person survival shooter with fully destructible voxel structures |
| PoJevArena | Design creatures, draft 10 v 10, and watch the arena brain (free local rules, or TypeSafe's Jev when picked in Settings) make every tactical call; post-match Black Box scrubber |
| PoMule | Eight-player M.U.L.E.: claim land, work M.U.L.E.s and trade on a walking-floor market for twelve months vs seven AI personalities; all-AI demo |
| PoEcosystem | Watch-only island simulation: species, tribes and chronicle cards for landmark events; cloud save slots and a shared gallery |
| SandPlayground | GPU sand-and-water sandbox |

## Quick start

```powershell
# prerequisites: .NET SDK 10.0.100 or a later feature band (global.json), Docker
docker compose up -d azurite                                  # local table storage
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj
# → http://localhost:5080  (API + client, one origin)

pwsh scripts/test-all.ps1                                     # full test suite
```

## Layout

```
src/
├── PoMiniGames.API/            Host + vertical feature slices (Features/<Slice>)
├── PoMiniGames.Client/         Blazor WASM client (assembly: PoMiniGamesClient)
├── PoMiniGames.Infrastructure/ Table Storage, HighScoreDescriptor<T> leaderboards (all-time + weekly, ?period=week)
├── PoMiniGames.Domain/         Domain primitives (EloCalculator, GameKey, ...)
└── PoMiniGames.Shared/         DTOs shared between client and server
tests/
├── PoMiniGames.Unit/           ≤100 tests (hermetic)
├── PoMiniGames.Integration/    ≤50 tests (Testcontainers Azurite)
├── PoMiniGames.E2EAPI/         ≤25 tests (HTTP contract)
├── PoMiniGames.E2EUI/          ≤25 tests (Playwright)
└── Shared/                     TestBudgetGuard (no test ever spends AI tokens)
infra/                          Bicep (azd); deployed by .github/workflows/deploy.yml
scripts/                        Working scripts only — see scripts/README.md
```

## Notes

- Auth: Microsoft Entra sign-in in the browser (MSAL), sent to the API as a bearer token.
  Guest login exists only in Development/Test and only from loopback. The whole app sits
  behind the sign-in gate; leaderboard reads are anonymous at the API, and all game-data
  writes require auth + antiforgery.
- UI is native Blazor + plain CSS for thirteen of the games. PoMule was the first screen built
  on Radzen (Material Dark), and Brawl HQ (`/pobrawl/hq`) is the second; the hub, settings,
  leaderboards and the other games move to Radzen next. Until then each of those pages loads
  the Radzen stylesheet itself and removes it on the way out (`wwwroot/js/radzenTheme.js`,
  sharing PoMule's element id). In-game HUDs stay custom CSS.
- **Each game is a Razor page plus a JavaScript engine, except PoMule**, whose rules are C# in
  `PoMiniGames.Shared/Games/PoMule` (unit-tested, seeded, deterministic) with JavaScript only
  drawing and moving the avatars. The server replays a submitted match from its seed and
  action log (`PoMuleRunVerifier`). See `SPEC.md` and `CAPABILITY-MAP.md`.
- Offline-friendly PWA: finished scores park locally and sync on reconnect/sign-in.
- Deploy: `azd up` (App Service F1, resource group `PoMiniGames`).

PoRacer ranks **best completed laps**, separately from final race times. Its legacy JSON
field and Azure Table column `totalTimeSeconds` / `TotalTimeSeconds` retain their names
for stored-score compatibility; existing rows are preserved without inferred conversion.
Solo races have 99 AI rivals and spectator demos have 100 AI cars; online rooms remain
capped at 8 cars. The minimap is removed. Add `?perf=1` to a PoRacer URL and inspect
`window.PoRacer.getPerformanceProfile()` for frame rates and render-stage timings.
Track bitmaps respect the canvas pixel budget, including backing-store ratios below 1,
without rebuilding on every frame.
Join/rejoin snapshot numbers use Blazor's direct byte-array interop transfer rather than
JSON-formatting 1,400 floating-point values on the browser's WASM main thread.
Streaming snapshots retain the existing SignalR wire format but are decoded in native
JavaScript; only the four visible standings rows return to Blazor. All cars still feed
interpolation, rendering, and audio, and the HUD's field size comes from the complete roster.
Run `node --test tests\poracer-snapshot.test.mjs` for focused native snapshot coverage.
Run `pwsh scripts/test-ceilings.ps1` to check all four test-method budgets without Docker.
Run `node --test tests/pomule-world.test.mjs tests/pomule-physics.test.mjs` for PoMule's renderer maths.
CI validates Bicep and deploys application code; use `azd up` for resource provisioning.

## Configuration and endpoint changes (2026-10-17)

| Key | Meaning |
|---|---|
| `PoFunQuiz:QuestionSource`, `AllowFreshAi`, `BankTargetPerCategory` | `Bank` (free, default) or `FreshAi`; Fresh AI only for signed-in players while allowed; bank size per category |
| `PoFunQuiz:OpenTriviaDb:*` | `Enabled`, `BaseUrl`, `TimeoutSeconds` for the free question source |
| `PoCoupleQuiz:Features:QuestionSource`, `AllowFreshAi`, `AnswerMatching`, `AllowAiJudge` | `Bank` and `Smart` (free) by default; `FreshAi` and `AiJudge` only for a signed-in host |
| `PoMiniGames:AI:QuizPrebake:*` | Background bank filler: `Enabled` (on), `Interval`, `DelayBetweenCategories`, `Categories`, `AllowAiTopUp` (off, the only part that spends) |
| `PoMiniGames:Jev:Brain` | `Local` (free rules, default) or `Jev` (paid; also needs `ApiKey` and the player's choice) |
| `PoMiniGames:AI:Deployments` | `funquiz`, `couplequiz` and `couplequiz.similarity` all run on `gpt-5.4-nano` |
| `PoMiniGames:PoBrawl:Dossier:FetchWikipedia`, `CacheHours` | Fighter dossiers: enrich the static facts from the free Wikimedia REST API (default `true`), cached 24 h; off or failing, static facts are served. Tests pin it to `false` |

| Endpoint | Change |
|---|---|
| `GET /api/diag/ai` | New home of the AI usage and cost read-model |
| `GET /api/health/ai` | Removed (moved to `/api/diag/ai`) |
| `/api/joker/*` | Removed with the Joker game |
| `GET /api/ecosystem/culture/{seed}` and the ecosystem chronicle, thought, treaty and lore routes | Removed; PoEcosystem calls no AI |
| `GET /api/pocabinet/banter`, `POST /api/pocabinet/debrief` | Removed; Cabinet's radio lines are scripted in the browser |
| `POST /api/pobrawl/presser`, `POST /api/pobrawl/intro` | Removed; Brawl's press lines are scripted |
| `GET /api/leaderboards` and `/api/leaderboards/{game}` | New `period=week` query for this ISO week's boards |
| `GET /api/pobrawl/dossier` | New, anonymous: every Brawl fighter's dossier (number, term, party, fighting style, Wikipedia summary, portrait, article link) in one call |
| `/pobrawl/hq` (client route) | New (2026-10-18): Brawl HQ, one page over the existing reads (`GET /api/pobrawl/progress`, `/api/leaderboards/pobrawl`, `pobrawlko`, `pobrawldemo`) and this browser's ladder and Cup titles. No new endpoint |
| `/pobrawl/match-hub` (SignalR) | Rollback protocol: `SubmitInput` takes `{ frame, held, press, sequence }`; new `matchInput` event (each accepted input with the frame the server used) and `Ping` method (clock sync); `matchState` now carries `frame`, `sim` (26 packed ints) and `checksum` in place of the per-tick swing fields |

Trivia questions in PoFunQuiz come in part from the [Open Trivia Database](https://opentdb.com/),
licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
PoBrawl's fighter dossiers quote summaries and portraits from [Wikipedia](https://en.wikipedia.org/)
(text CC BY-SA 4.0); each card links its article with a "From Wikipedia" attribution.
