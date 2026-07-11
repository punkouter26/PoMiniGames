---
description: Restart and verify the local PoMiniGames app on Windows.
---

# Restart Local App

Restart the local PoMiniGames runtime and report only the facts needed to continue development.

Follow this sequence:

1. Read [AGENT.MD](../../AGENT.MD), especially Build & run and Data & local dev.
2. Stop existing `dotnet` processes and free port `5000` using the workspace task when available.
3. Start Azurite with Docker using the workspace task when Docker/WSL is healthy.
4. If Docker/WSL is broken, state the exact failure and use the existing local Azurite fallback only for this run.
5. Start the host project at `src/PoMiniGames/PoMiniGames.csproj`.
6. Verify `http://localhost:5000/api/health/ping` returns `pong` and check `/api/health` if storage status matters.

Stop once the app is reachable or the root blocker is identified. Include the endpoint, storage status, and any active fallback in the final response.