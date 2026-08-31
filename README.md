# PoMiniGames

Instant-play mini-games platform: a .NET 10 Minimal API host that also serves its
Blazor WebAssembly client from a single origin (port 5000), with SignalR for real-time
multiplayer, Azure Table Storage for persistence, and Azure AI Foundry behind the
AI-powered games.

> This file is the short tour. **`CLAUDE.md` is the authoritative engineering
> reference** (commands, gates, architecture contracts); `docs/PRD_Master.md` and
> `docs/PoVoxelStrike-PRD.md` hold the product specs.

## Games (`src/PoMiniGames.Client/Games/`)

| Game | One-liner |
|---|---|
| TicTacToe | Classic 3×3 vs AI |
| ConnectFive | Five-in-a-row vs AI |
| PoBrawl | Physics brawler with a presidents ladder + fighter Elo demo board |
| PoCoupleQuiz | Two-player realtime couples quiz (SignalR) |
| PoFunQuiz | AI-generated multiplayer quiz lobby |
| PoJoker | AI joke judge with a grandma audience |
| PoMarbleRace | Physics marble race on baked GLB tracks |
| PoRacer | 3D racer with multiplayer lobby |
| PoSports | Sprite-based sports mini-game |
| PoSurvive | Endless survival sim with in-browser (WebLLM) or relayed AI inference |
| PoVoxelStrike | Third-person survival shooter with fully destructible voxel structures |

## Quick start

```powershell
# prerequisites: .NET SDK 10.0.203 (global.json), Docker
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
├── PoMiniGames.Infrastructure/ Table Storage, HighScoreDescriptor<T> leaderboards
├── PoMiniGames.Application/    Application services (PoSurvive simulation engine)
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

- Auth: Microsoft Entra (BFF cookie pattern) plus guest login; leaderboard reads are
  anonymous, all game-data writes require auth + antiforgery.
- UI is native Blazor + plain CSS by design — no heavy component libraries.
- Offline-friendly PWA: finished scores park locally and sync on reconnect/sign-in.
- Deploy: `azd up` (App Service F1, resource group `PoMiniGames`).
