# PoMiniGames

A modern web-based mini-games platform featuring classic games with AI opponents, persistent player statistics, and competitive leaderboards.

## Overview

PoMiniGames is a full-stack web application built with .NET 10 and React 18. It provides an engaging platform for players to enjoy classic games like Tic-Tac-Toe and Connect Five against AI opponents at various difficulty levels.

### Key Features

- **Tic-Tac-Toe**: Classic 3x3 grid game with AI opponents
- **Connect Five**: Connect 5 in a row on a 6x5 grid
- **Difficulty Levels**: Easy, Medium, and Hard AI opponents
- **Player Statistics**: Track wins, losses, draws, and win streaks
- **Leaderboards**: Compete with other players
- **Health & Diagnostics**: Integrated health monitoring and diagnostic endpoints:
    - `/api/health`: Comprehensive system health status (Azure Table Storage, etc.)
    - `/diag`: Filtered configuration and secrets visibility (masked for security)
- **Offline Support**: Works without internet using local storage

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + TypeScript + Vite |
| Routing | React Router v6 |
| Backend | .NET 10 Minimal API |
| Storage | Azure Table Storage |
| Logging | Serilog |
| Testing | xUnit + Playwright |

## Architecture

The project follows a clean architecture with separated concerns:

```
src/
├── PoMiniGames/           # .NET Backend API
│   ├── Features/          # API Endpoints
│   ├── Models/            # Data Models
│   ├── Services/          # Business Logic
│   └── HealthChecks/     # Health Monitoring
└── PoMiniGames.Client    # React Frontend
    ├── components/        # UI Components
    ├── games/            # Game Logic
    └── services/          # API Services
```

## Documentation

Comprehensive documentation is available in the `docs/` folder:

### Architecture & Design

| Document | Description |
|----------|-------------|
| [docs/Architecture.mmd](./docs/Architecture.mmd) | System Context + Container Architecture |
| [docs/ApplicationFlow.mmd](./docs/ApplicationFlow.mmd) | Auth Flow + User Journey |
| [docs/DataModel.mmd](./docs/DataModel.mmd) | Database Schema + State Transitions |
| [docs/ComponentMap.mmd](./docs/ComponentMap.mmd) | Component Tree + Dependencies |
| [docs/DataPipeline.mmd](./docs/DataPipeline.mmd) | Data Workflow + User Workflow |

### Product & API

| Document | Description |
|----------|-------------|
| [docs/ProductSpec.md](./docs/ProductSpec.md) | PRD + Success Metrics |
| [docs/ApiContract.md](./docs/ApiContract.md) | API Specs + Error Handling |

### Operations

| Document | Description |
|----------|-------------|
| [docs/DevOps.md](./docs/DevOps.md) | Deployment Pipeline + Secrets |
| [docs/LocalSetup.md](./docs/LocalSetup.md) | Day 1 Guide + Docker |

## Quick Start

### Prerequisites

- .NET 10 SDK
- Node.js 18+
- Docker Desktop

### Local Development

1. **Start Azurite (local storage):**
   ```bash
   docker-compose up -d
   ```

2. **Start the Backend API:**
   ```bash
   cd src/PoMiniGames/PoMiniGames
   dotnet run
   ```

3. **Start the Frontend (new terminal):**
   ```bash
   cd src/PoMiniGames.Client
   npm install
   npm run dev
   ```

   Optional: configure external game URLs before `npm run dev`:
   ```bash
   # src/PoMiniGames.Client/.env.local
   VITE_GAME_URL_POFIGHT=http://localhost:5174
   VITE_GAME_URL_PODROPSQUARE=http://localhost:5280
   VITE_GAME_URL_POBABYTOUCH=http://localhost:5180
   VITE_GAME_URL_PORACERAGDOLL=http://localhost:3000
   ```

4. **Open the app:** http://localhost:5173

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health/ping` | Health check |
| GET | `/api/{game}/players/{player}/stats` | Get player stats |
| PUT | `/api/{game}/players/{player}/stats` | Save player stats |
| GET | `/api/{game}/statistics/leaderboard` | Get leaderboard |
| GET | `/api/{game}/statistics/all` | Get all stats |

## Games

### Tic-Tac-Toe
- **Grid**: 3x3
- **Win Condition**: 3 in a row
- **AI Levels**:
  - Easy: Random moves
  - Medium: Block wins + some offense
  - Hard: Minimax algorithm (unbeatable)

### Connect Five
- **Grid**: 6 columns × 5 rows
- **Win Condition**: 5 in a row
- **AI Levels**: Same as Tic-Tac-Toe

### Integrated External Games
- **PoFight**: `/pofight`
- **PoDropSquare**: `/podropsquare`
- **PoBabyTouch**: `/pobabytouch`
- **PoRaceRagdoll**: `/poraceragdoll`

## Testing

```bash
# Run unit tests
dotnet test tests/PoMiniGames.UnitTests

# Run integration tests
dotnet test tests/PoMiniGames.IntegrationTests

# Run E2E tests
npx playwright test
```

## Deployment

See [docs/DevOps.md](./docs/DevOps.md) for detailed deployment instructions.

### Azure Resources Required

- Azure App Service (containerized)
- Azure Storage Account (Table Storage)
- Azure Key Vault (secrets)

## Configuration

### Development
Configuration is in `appsettings.Development.json`:
- Local Azurite storage
- CORS: localhost:5173

### Production
Configuration is in `appsettings.json`:
- Azure Table Storage
- Azure Key Vault integration
- Production CORS settings

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
