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
├── PoMiniGames.Application/   # Application services & DTOs
├── PoMiniGames.Client/        # Blazor WebAssembly client
│   ├── Components/            # Shared UI (GameShell, HomeHighScores)
│   ├── Games/                 # Game modules (TicTacToe, ConnectFive, etc.)
│   ├── Services/              # API, Auth, GameStats services
│   ├── Layout/                # MainLayout, navigation
│   └── Pages/                # Index, SinglePlayer, OnlineMultiplayer
├── PoMiniGames.Domain/        # Domain models (PlayerStats, HighScores)
├── PoMiniGames.Infrastructure/ # Azure storage & health checks
├── PoShared/                  # Shared utilities (Identity, Diagnostics)
tests/
├── PoMiniGames.UnitTests/        # Pure logic tests (xUnit)
├── PoMiniGames.IntegrationTests/ # API + DB integration tests
└── e2e/                          # Playwright E2E tests
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

All diagrams are in [`/docs`](./docs).

### 1. Architecture & CI/CD

| File | Type | Description |
|---|---|---|
| [docs/Architecture_MASTER.mmd](./docs/Architecture_MASTER.mmd) | flowchart | Hybrid C4 L1/L2 — Edge, Compute, Data, Identity, CI/CD |
| [docs/ReleasePipeline_MASTER.mmd](./docs/ReleasePipeline_MASTER.mmd) | flowchart | Feature → Build → Test → Artifact → Deploy → Prod |

### 2. User Usage & Behavioral Flowcharts

| File | Type | Description |
|---|---|---|
| [docs/OnboardingJourney.mmd](./docs/OnboardingJourney.mmd) | flowchart | New user path — anonymous play → auth → Aha moment |
| [docs/PrimaryValueFlow.mmd](./docs/PrimaryValueFlow.mmd) | flowchart | Happy path — visit → select → play → stats → leaderboard |
| [docs/ExceptionUserFlows.mmd](./docs/ExceptionUserFlows.mmd) | flowchart | Auth errors · offline resilience · multiplayer disconnection · rate limiting |

### 3. Logic & State Dynamics

| File | Type | Description |
|---|---|---|
| [docs/SystemFlow_MASTER.mmd](./docs/SystemFlow_MASTER.mmd) | sequenceDiagram | Full system — Startup secrets → Auth → Stats CRUD → Multiplayer |
| [docs/StateDynamics_MASTER.mmd](./docs/StateDynamics_MASTER.mmd) | stateDiagram-v2 | Match · Lobby · Race Session · PlayerStats lifecycles |

### 4. Data & Security Schema

| File | Type | Description |
|---|---|---|
| [docs/DataModel.mmd](./docs/DataModel.mmd) | erDiagram | Full ERD — PlayerStats · HighScores · Match · Lobby · Race with PKs and enums |
| [docs/AccessControl_MATRIX.mmd](./docs/AccessControl_MATRIX.mmd) | flowchart | Roles (Anonymous · Auth · Host · Dev) mapped to every endpoint group |
| [docs/DataLifecycle_MASTER.mmd](./docs/DataLifecycle_MASTER.mmd) | flowchart | Ingest → Rate-limit → Auth → Sanitize → UPSERT → Store → Serve |

### 5. Dependency & UI Hierarchy

| File | Type | Description |
|---|---|---|
| [docs/SystemInteractionFlow.mmd](./docs/SystemInteractionFlow.mmd) | sequenceDiagram | Real-time multiplayer — queue → lobby → SignalR move sync → stats |
| [docs/ServiceMap_MASTER.mmd](./docs/ServiceMap_MASTER.mmd) | flowchart | Full service dependency graph — source of truth for blast radius assessment |
| [docs/InterfaceHierarchy_MASTER.mmd](./docs/InterfaceHierarchy_MASTER.mmd) | flowchart | React component tree — routes · shared components · game modules · state layer |
| [docs/ProductSpec.md](./docs/ProductSpec.md) | Markdown | PRD — Why, features, business rules, success metrics |
| [docs/DevOps.md](./docs/DevOps.md) | Markdown | CI/CD, secrets, Docker Compose, Day 1 onboarding |

## Screenshots

See the [`screenshots/`](./screenshots/) folder for application screenshots.

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
