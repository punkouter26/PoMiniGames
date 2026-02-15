# LocalSetup.md - Day 1 Guide + Docker Compose

## Simplified Version (AI-Friendly)

### Quick Start

```bash
# 1. Clone and start Azurite
docker-compose up -d

# 2. Start API
cd src/PoMiniGames/PoMiniGames
dotnet run

# 3. Start Client (new terminal)
cd src/PoMiniGames.Client
npm install
npm run dev
```

Open http://localhost:5173

---

## Detailed Version (Human Developers)

## Prerequisites

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| .NET SDK | 10.0+ | Backend runtime |
| Node.js | 18+ | Frontend runtime |
| Docker Desktop | Latest | Local storage emulator |
| Git | Latest | Version control |

### Verify Installation

```bash
dotnet --version   # Should show 10.0 or higher
node --version    # Should show 18.x or higher
npm --version     # Should show 9.x or higher
docker --version  # Should show latest
```

## Local Development Setup

### Step 1: Clone Repository

```bash
git clone <repository-url>
cd PoMiniGames
```

### Step 2: Start Local Storage (Azurite)

Azurite emulates Azure Table Storage locally.

```bash
# Option A: Using Docker Compose (recommended)
docker-compose up -d

# Option B: Using npm globally
npm install -g azurite
azurite --tableHost 127.0.0.1 --tablePort 10002
```

**Azurite Ports:**
- Table: 10002
- Blob: 10000
- Queue: 10001

### Step 3: Start the Backend API

```bash
# Navigate to API project
cd src/PoMiniGames/PoMiniGames

# Restore dependencies
dotnet restore

# Run in development mode
dotnet run
```

The API will start on `http://localhost:5000`

Verify it's running:
```bash
curl http://localhost:5000/api/health/ping
# Should return: {"pong":true}
```

### Step 4: Start the Frontend

```bash
# Navigate to client project
cd src/PoMiniGames.Client

# Install dependencies
npm install

# Start development server
npm run dev
```

The client will start on `http://localhost:5173`

### Step 5: Verify Everything Works

1. Open http://localhost:5173 in your browser
2. Click on "Tic-Tac-Toe" or "Connect Five"
3. Enter a player name
4. Play a game
5. Check that stats are saved

## Project Structure

```
PoMiniGames/
├── docs/                    # Documentation
├── screenshots/              # App screenshots
├── src/
│   ├── PoMiniGames/        # .NET API project
│   │   └── PoMiniGames/
│   │       ├── Features/   # API endpoints
│   │       ├── Models/     # Data models
│   │       ├── Services/   # Business logic
│   │       └── Program.cs # Entry point
│   └── PoMiniGames.Client # React frontend
│       └── src/
│           ├── components/ # UI components
│           ├── games/     # Game logic
│           └── services/  # API services
├── tests/                   # Integration tests
├── docker-compose.yml       # Local services
├── Directory.Build.props    # Build configuration
└── PoMiniGames.slnx        # Solution file
```

## Running Tests

### Unit Tests

```bash
cd tests/PoMiniGames.UnitTests
dotnet test
```

### Integration Tests

```bash
cd tests/PoMiniGames.IntegrationTests
dotnet test
```

### E2E Tests (Playwright)

```bash
# First, ensure services are running
docker-compose up -d
dotnet run --project src/PoMiniGames/PoMiniGames &

# Run Playwright tests
npx playwright test
```

## Troubleshooting

### Port Already in Use

```bash
# Find process using port 5000
netstat -ano | findstr :5000

# Kill process
taskkill /PID <process-id> /F
```

### Azurite Connection Issues

```bash
# Check if Azurite is running
docker ps | grep azurite

# Restart Azurite
docker-compose restart

# Or check logs
docker-compose logs azurite
```

### Node Module Issues

```bash
# Clean reinstall
cd src/PoMiniGames.Client
rm -rf node_modules package-lock.json
npm install
```

### DotNet Build Issues

```bash
# Clean and rebuild
dotnet clean
dotnet restore
dotnet build
```

## Development Workflow

### Daily Development

```bash
# 1. Start Azurite (if not running)
docker-compose up -d

# 2. Start API (terminal 1)
dotnet run --project src/PoMiniGames/PoMiniGames

# 3. Start Client (terminal 2)
cd src/PoMiniGames.Client
npm run dev
```

### Making Changes

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Run tests: `dotnet test`
4. Commit: `git commit -am "Add feature"`
5. Push: `git push origin feature/my-feature`

## Configuration Files

### appsettings.Development.json

Located in `src/PoMiniGames/PoMiniGames/`

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information"
    }
  },
  "ConnectionStrings": {
    "Tables": "UseDevelopmentStorage=true"
  },
  "Cors": {
    "AllowedOrigins": [
      "http://localhost:5000",
      "http://localhost:5173"
    ]
  }
}
```

### vite.config.ts

Located in `src/PoMiniGames.Client/`

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      }
    }
  }
});
```

## Useful Commands

| Command | Description |
|---------|-------------|
| `dotnet run` | Run API |
| `npm run dev` | Run frontend |
| `dotnet test` | Run all tests |
| `docker-compose up -d` | Start Azurite |
| `docker-compose down` | Stop Azurite |
| `dotnet build` | Build solution |

## Next Steps

After setup, you can:

1. [Read the Architecture docs](./Architecture.mmd)
2. [Understand the API contract](./ApiContract.md)
3. [Review the component map](./ComponentMap.md)
4. [Set up production deployment](./DevOps.md)

## Getting Help

- Check existing issues on GitHub
- Review test files for usage examples
- Examine the API endpoints in `src/PoMiniGames/PoMiniGames/Features/`
