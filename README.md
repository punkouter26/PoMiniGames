# PoMiniGames

Instant-play mini-games platform — 8 games, AI opponents, real-time 2P multiplayer, global leaderboards. Built with .NET 10 + React 18 + SignalR. Offline-resilient: every game works without an API connection.

## Games

| Game | AI | Multiplayer | Leaderboard |
|---|---|---|---|
| **Tic-Tac-Toe** | Easy / Medium / Hard | Online PvP | Win rate |
| **Connect Five** | Easy / Medium / Hard | Online PvP | Win rate |
| **PoFight** | CPU | Online PvP | Win rate |
| **Po Snake Game** | — | 2P live sync | High scores |
| **PoDropSquare** | — | — | Survival time |
| **PoBabyTouch** | — | — | Offline only |
| **PoRaceRagdoll** | CPU racers | Betting lobby | Session |
| **Voxel Shooter** | — | — | Offline only |

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS v4 |
| Routing | React Router v6 |
| Real-time | SignalR WebSockets (`@microsoft/signalr` v10) |
| 3D / Physics | Three.js · Cannon-ES · Matter.js |
| Backend | .NET 10 Minimal API + MVC |
| Storage | SQLite (`/home/data/pominigames.db`) |
| Auth | Microsoft MSAL (OAuth2 JWT Bearer) + DevCookie |
| Logging | Serilog → file + console + App Insights |
| Telemetry | OpenTelemetry → Azure Application Insights |
| Secrets | Azure Key Vault (Managed Identity) + `dotnet user-secrets` |
| IaC | Azure Bicep + `azd` |
| Testing | xUnit · Testcontainers · Playwright · Vitest |

## Architecture

```mermaid
flowchart TD
    Player["Player (Browser)"] --> SWA["Azure Static Web App\nReact 18 · CDN Edge"]
    Player -- "WSS Multiplayer" --> API["Azure App Service\n.NET 10 API · SignalR"]
    SWA -- "REST + WSS" --> API
    API --> DB[("SQLite\n/home/data")]
    API --> Shared["PoShared\nKey Vault + App Insights"]
    API --> MSID["Microsoft Identity\nOAuth2 / OIDC"]
    GH["GitHub Actions\nCI/CD"] -- "Deploy React" --> SWA
    GH -- "Deploy .NET" --> API
```

## Source Layout

```
src/
├── PoMiniGames/           # .NET 10 Backend API
│   ├── Features/          # Minimal API endpoints + SignalR hubs
│   │   ├── Auth/          # /api/auth/* + dev bypass
│   │   ├── Health/        # /api/health + /diag
│   │   ├── Leaderboard/   # /api/{game}/statistics/*
│   │   ├── HighScores/    # /api/snake/highscores + podropsquare
│   │   ├── Multiplayer/   # /api/multiplayer/* + MultiplayerHub
│   │   ├── Lobby/         # /api/lobby + LobbyHub
│   │   └── PoRaceRagdoll/ # /api/game/* race sessions
│   ├── Models/            # PlayerStats, SnakeHighScore, PoDropSquareHighScore
│   ├── DTOs/              # API contracts
│   ├── Services/          # StorageService, MultiplayerService, LobbyService
│   └── HealthChecks/      # /api/health checks
tests/
├── PoMiniGames.UnitTests/        # Pure logic tests (xUnit)
├── PoMiniGames.IntegrationTests/ # API + DB via Testcontainers
└── e2e/                          # Playwright E2E (Chromium)
src/PoMiniGames.Client/    # React 18 + TypeScript + Vite
    ├── components/        # Shared UI (Home, Lobby, GameLayout)
    ├── context/           # AuthContext (MSAL), PlayerNameContext
    └── games/             # 8 game modules + shared apiService
```

## Quick Start

```bash
# Install deps
dotnet restore
cd src/PoMiniGames.Client && npm install && cd ../..

# Set dev secrets
cd src/PoMiniGames/PoMiniGames
dotnet user-secrets set "PoMiniGames:MicrosoftAuth:ClientId" "<client-id>"
dotnet user-secrets set "PoMiniGames:MicrosoftAuth:ApiClientId" "<api-client-id>"
cd ../../..

# Launch (F5 in VS Code — kills dotnet, starts Vite, then API)
# API: http://localhost:5000  |  Client dev server: http://localhost:5173
```

## Documentation

All diagrams are in [`/docs`](./docs). Every file has a full `_MASTER` version and a `_SIMPLE` stakeholder variant.

### 1. Architecture & CI/CD

| File | Type | Description |
|---|---|---|
| [docs/Architecture_MASTER.mmd](./docs/Architecture_MASTER.mmd) | flowchart | Hybrid C4 L1/L2 — Edge, Compute, Data, Identity, CI/CD |
| [docs/Architecture_MASTER_SIMPLE.mmd](./docs/Architecture_MASTER_SIMPLE.mmd) | flowchart | 7-node Azure topology at a glance |
| [docs/ReleasePipeline_MASTER.mmd](./docs/ReleasePipeline_MASTER.mmd) | flowchart | Feature → Build → Test → Artifact → Deploy → Prod |
| [docs/ReleasePipeline_MASTER_SIMPLE.mmd](./docs/ReleasePipeline_MASTER_SIMPLE.mmd) | flowchart | 5-step pipeline overview |

### 2. User Usage & Behavioral Flowcharts

| File | Type | Description |
|---|---|---|
| [docs/OnboardingJourney.mmd](./docs/OnboardingJourney.mmd) | flowchart | New user path — anonymous play → auth → Aha moment |
| [docs/OnboardingJourney_SIMPLE.mmd](./docs/OnboardingJourney_SIMPLE.mmd) | flowchart | 5-step onboarding summary |
| [docs/PrimaryValueFlow.mmd](./docs/PrimaryValueFlow.mmd) | flowchart | Happy path — visit → select → play → stats → leaderboard |
| [docs/PrimaryValueFlow_SIMPLE.mmd](./docs/PrimaryValueFlow_SIMPLE.mmd) | flowchart | 5-node happy path |
| [docs/ExceptionUserFlows.mmd](./docs/ExceptionUserFlows.mmd) | flowchart | Auth errors · offline resilience · multiplayer disconnection · rate limiting |
| [docs/ExceptionUserFlows_SIMPLE.mmd](./docs/ExceptionUserFlows_SIMPLE.mmd) | flowchart | 4 exception categories at a glance |

### 3. Logic & State Dynamics

| File | Type | Description |
|---|---|---|
| [docs/SystemFlow_MASTER.mmd](./docs/SystemFlow_MASTER.mmd) | sequenceDiagram | Full system — Startup secrets → Auth → Stats CRUD → Multiplayer |
| [docs/SystemFlow_MASTER_SIMPLE.mmd](./docs/SystemFlow_MASTER_SIMPLE.mmd) | flowchart | Auth · Stats · Multiplayer lanes |
| [docs/StateDynamics_MASTER.mmd](./docs/StateDynamics_MASTER.mmd) | stateDiagram-v2 | Match · Lobby · Race Session · PlayerStats lifecycles |
| [docs/StateDynamics_MASTER_SIMPLE.mmd](./docs/StateDynamics_MASTER_SIMPLE.mmd) | stateDiagram-v2 | Core state transitions only |

### 4. Data & Security Schema

| File | Type | Description |
|---|---|---|
| [docs/DataModel.mmd](./docs/DataModel.mmd) | erDiagram | Full ERD — PlayerStats · HighScores · Match · Lobby · Race with PKs and enums |
| [docs/DataModel_SIMPLE.mmd](./docs/DataModel_SIMPLE.mmd) | erDiagram | 5 main entities |
| [docs/AccessControl_MATRIX.mmd](./docs/AccessControl_MATRIX.mmd) | flowchart | Roles (Anonymous · Auth · Host · Dev) mapped to every endpoint group |
| [docs/AccessControl_MATRIX_SIMPLE.mmd](./docs/AccessControl_MATRIX_SIMPLE.mmd) | flowchart | 4 roles → 4 endpoint groups |
| [docs/DataLifecycle_MASTER.mmd](./docs/DataLifecycle_MASTER.mmd) | flowchart | Ingest → Rate-limit → Auth → Sanitize → UPSERT → Store → Serve |
| [docs/DataLifecycle_MASTER_SIMPLE.mmd](./docs/DataLifecycle_MASTER_SIMPLE.mmd) | flowchart | 4-stage data pipeline |

### 5. Dependency & UI Hierarchy

| File | Type | Description |
|---|---|---|
| [docs/SystemInteractionFlow.mmd](./docs/SystemInteractionFlow.mmd) | sequenceDiagram | Real-time multiplayer — queue → lobby → SignalR move sync → stats |
| [docs/SystemInteractionFlow_SIMPLE.mmd](./docs/SystemInteractionFlow_SIMPLE.mmd) | flowchart | 5-step multiplayer lifecycle |
| [docs/ServiceMap_MASTER.mmd](./docs/ServiceMap_MASTER.mmd) | flowchart | Full service dependency graph — source of truth for blast radius assessment |
| [docs/ServiceMap_MASTER_SIMPLE.mmd](./docs/ServiceMap_MASTER_SIMPLE.mmd) | flowchart | Client → API → SignalR → DB → External |
| [docs/InterfaceHierarchy_MASTER.mmd](./docs/InterfaceHierarchy_MASTER.mmd) | flowchart | React component tree — routes · shared components · game modules · state layer |
| [docs/InterfaceHierarchy_MASTER_SIMPLE.mmd](./docs/InterfaceHierarchy_MASTER_SIMPLE.mmd) | flowchart | 5-node frontend structure |
| [docs/DataModel.mmd](./docs/DataModel.mmd) | Mermaid erDiagram | Full ERD — all entities and relationships |
| [docs/DataModel_SIMPLE.mmd](./docs/DataModel_SIMPLE.mmd) | Mermaid erDiagram | Core tables only |
| [docs/ProductSpec.md](./docs/ProductSpec.md) | Markdown | PRD — Why, features, business rules, success metrics |
| [docs/DevOps.md](./docs/DevOps.md) | Markdown | CI/CD, secrets, Docker Compose, Day 1 onboarding |

## Screenshots

| Lobby | Multiplayer |
|---|---|
| ![Lobby](./docs/screenshots/multiplayer-step9-lobby-current.png) | ![Multiplayer](./docs/screenshots/multiplayer-dom-debug-home.png) |

## Key Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health/ping` | Liveness probe — returns `"pong"` |
| `GET /api/health` | Structured health report (SQLite status) |
| `GET /diag` | Masked config dump (dev/staging only) |
| `GET /scalar` | OpenAPI UI (Scalar — purple theme) |
| `GET /api/auth/me` | Authenticated user profile |
| `GET /api/{game}/statistics/leaderboard` | Top 10 by win rate |
| `WS /api/hubs/lobby` | Pre-game lobby (SignalR) |
| `WS /api/hubs/multiplayer` | Real-time game moves (SignalR) |
| [docs/ProductSpec.md](./docs/ProductSpec.md) | Markdown | PRD, game catalog, API surface, success metrics |
| [docs/DevOps.md](./docs/DevOps.md) | Markdown | CI/CD, secrets, Docker Compose, blast radius |
| [docs/screenshots/](./docs/screenshots/) | Images | App screenshots for visual reference |

## Quick Start

### Prerequisites

- .NET 10 SDK (`dotnet --version` → `10.x`)
- Node.js 20+ (`node --version`)

### Local Development

1. **Start the Backend API (hosts the React client):**
   ```bash
   cd src/PoMiniGames/PoMiniGames
   dotnet run
   ```

2. **Open the app:** http://localhost:5000

3. **Optional hot-reload frontend mode (new terminal):**
   ```bash
   cd src/PoMiniGames.Client
   npm install
   npm run dev
   ```

4. **Hot-reload app URL:** http://localhost:5173

5. **Run the local smoke check:** use the VS Code task `smoke-local` after the client and API are running.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health/ping` | Health check |
| GET | `/api/{game}/players/{player}/stats` | Get player stats |
| PUT | `/api/{game}/players/{player}/stats` | Save player stats |
| GET | `/api/{game}/statistics/leaderboard` | Get leaderboard |
| GET | `/api/{game}/statistics/all` | Get all stats |

## Games

| Route | Game | Mode | Difficulty | Stats |
|---|---|---|---|---|
| `/tictactoe` | Tic-Tac-Toe | PvAI · PvP · Demo | Easy/Medium/Hard | PlayerStats |
| `/connectfive` | Connect Five | PvAI · PvP · Demo | Easy/Medium/Hard | PlayerStats |
| `/pofight` | PoFight | PvCPU · CPUvCPU · Demo | Easy/Medium/Hard | PlayerStats |
| `/posnakegame` | Po Snake Game | Solo arena | — | SnakeHighScore |
| `/podropsquare` | PoDropSquare | Physics survival | — | PoDropSquareHighScore |
| `/pobabytouch` | PoBabyTouch | Tap sensory | — | Local only |
| `/poraceragdoll` | PoRaceRagdoll | Betting + racing | — | RaceSession |
| `/voxelshooter` | Voxel Shooter | FPS WebGL | — | Local only |

## Testing

```bash
# Run unit tests
dotnet test tests/PoMiniGames.UnitTests

# Run integration tests
dotnet test tests/PoMiniGames.IntegrationTests

# Run E2E tests
cd tests/e2e
npm install
npx playwright test
```

## Deployment

See [docs/DevOps.md](./docs/DevOps.md) for full CI/CD pipeline, Docker Compose, secrets setup, and blast radius assessment.

```bash
# Provision and deploy to Azure
azd auth login
azd up
```

## Configuration

### Development
Configuration is in `appsettings.Development.json`:
- Local SQLite storage
- CORS: localhost:5173
- Diagnostics enabled at `/diag`
- Rolling application logs written to `src/PoMiniGames/PoMiniGames/logs/pominigames-.log`

### Production
Configuration is in `appsettings.json`:
- SQLite storage
- Azure Key Vault integration
- Production CORS settings
- Diagnostics disabled by default unless explicitly re-enabled

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests
5. Submit a pull request

## License

ISC License - See LICENSE file for details

## Screenshots

See the `screenshots/` folder for application screenshots.
