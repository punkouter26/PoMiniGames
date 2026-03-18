# PoMiniGames — Product Specification

## Why

Classic mini-games are universally loved but scattered across low-quality sites riddled with ads. PoMiniGames delivers a distraction-free, instant-play platform where players can compete against AI, challenge a friend online, and see how they rank globally — all without creating an account.

The platform is intentionally offline-resilient: every game works without an API connection, with stats synced opportunistically in the background.

---

## Target Users

| Persona | Goal |
|---|---|
| **Casual Player** | Quick 2–5 min session, no friction, no login |
| **Competitive Player** | Beat the AI on Hard, climb the leaderboard |
| **Social Player** | Real-time 2-player games with a friend |
| **Developer** | Explore a clean .NET 10 + React 18 reference architecture |

---

## Games Catalogue

| Game | Grid/Arena | AI Difficulty | Multiplayer | Persistence |
|---|---|---|---|---|
| **Tic-Tac-Toe** | 3×3 | Easy / Medium / Hard | Online PvP (SignalR) | Stats (wins/losses/draws) |
| **Connect Five** | 6×5 | Easy / Medium / Hard | Online PvP (SignalR) | Stats (wins/losses/draws) |
| **PoFight** | 2D arena | CPU opponent | Online PvP (SignalR) | Stats |
| **Po Snake Game** | 30s battle arena | — | 2-player live sync | High scores (score, length, food) |
| **PoDropSquare** | Physics board | — | — | High scores (survival time) |
| **PoBabyTouch** | Bubble pop | — | — | Offline only |
| **PoRaceRagdoll** | Physics track | CPU racers | Betting lobby | Session-based |
| **Voxel Shooter** | WebGL 3D map | — | — | Offline only |

---

## Core Feature Definitions

### Instant Play
No account required for solo play. Stats are saved locally and synced to the API opportunistically. The full game experience is available even when the API is offline.

### AI Opponents (3 Tiers)
- **Easy**: Random or near-random moves. Suitable for young players.
- **Medium**: Heuristic play. Blocks wins and takes obvious wins.
- **Hard**: Minimax / optimal strategy. Near-unbeatable for Tic-Tac-Toe.

### Leaderboards
- Per-game ranking by win rate (minimum game threshold required).
- Top 10 displayed publicly.
- Rate-limited to 10 requests/min per IP (fixed window).
- Endpoints: `GET /api/{game}/statistics/leaderboard?limit=10`

### Player Statistics
Granular stats per difficulty tier: wins, losses, draws, win streak, win rate.
Stored server-side after optional Microsoft login.
Persisted locally via localStorage when API is unreachable.

### Real-time Multiplayer
- Pre-game **Lobby** (`/api/hubs/lobby`): First player becomes host, invites second player.
- Host taps "Start Game" → all clients navigate to the game.
- Game moves exchanged via **MultiplayerHub** (`/api/hubs/multiplayer`): `SendRealtimeInput` / `RealtimeInput`.
- Spectator mode: any authenticated user can call `JoinSpectatorGroup(matchId)`.
- Auth: JWT Bearer token passed as `?access_token=` query param on WebSocket upgrade.

### Health & Diagnostics
- `GET /api/health` — Structured JSON report: SQLite reachability + dependency status.
- `GET /api/health/ping` — Liveness probe returning `"pong"`.
- `GET /diag` — Masked configuration dump (disabled in production).

### Microsoft Identity Auth
- Optional sign-in via Microsoft OAuth2 (MSAL popup).
- Required only for: submitting leaderboard stats, joining multiplayer matches.
- Dev auth bypass: `POST /api/auth/dev-login` (development environment only).

---

## Business Rules

1. **Stats only count for completed games** — forfeits do not update win/loss.
2. **Leaderboard win rate** is computed as `TotalWins / TotalGames × 100`.
3. **Multiplayer queue** matches first two players who request the same `gameKey`.
4. **Host privilege**: only the first lobby member can call `StartGame`; host disconnects triggers lobby reset.
5. **Rate limiting**: high score submission endpoints capped at 10 req/min/IP.
6. **Input sanitization**: game and player name inputs validated against illegal SQL characters before any DB write.

---

## Success Metrics

| Metric | Target | Rationale |
|---|---|---|
| Time-to-first-game | < 3s (cold) | CDN edge delivery + lazy-loaded game bundles |
| API availability | ≥ 99.5% uptime | Azure App Service SLA on B1 plan |
| Solo game works offline | 100% | LocalStorage fallback for all games |
| Leaderboard latency | < 200ms p95 | SQLite read path, indexed by WinRate |
| Multiplayer round-trip | < 80ms p95 (same region) | SignalR WebSocket on App Service |
| E2E test suite pass | 100% on master | Playwright critical-path coverage |
| Unit + integration tests | 100% on master | xUnit + Testcontainers coverage |

---

## Non-Goals (v1)

- Tournament brackets or ELO rating system.
- Mobile native app (PWA-friendly but no app store release).
- Monetisation, ads, or paid tiers.
- Game replay or spectator recording.
- More than 2 concurrent multiplayer players per match.
