# PRD Master

## Purpose
PoMiniGames is a mobile-first mini-games platform delivered as a same-origin ASP.NET Core host serving a Blazor WebAssembly client. The application combines local-first game play with authenticated leaderboards, real-time multiplayer rooms, and Azure Table Storage persistence.

## Vertical slice boundaries
- Platform concerns stay in the layered projects under src/PoMiniGames.Application, src/PoMiniGames.Domain, and src/PoMiniGames.Infrastructure.
- Feature-specific endpoints, contracts, hubs, and storage live under src/PoMiniGames/PoMiniGames/Features/<Slice>/.
- Client-only games remain under src/PoMiniGames.Client/Games/ and are not mirrored into the host feature tree.

## API surface
- Auth endpoints: /api/auth/config, /api/auth/me, /api/auth/handshake, /auth/login/microsoft, /auth/login/fake, /auth/logout
- Game statistics and leaderboard endpoints: /api/{game}/players/{playerName}/stats, /api/{game}/statistics/leaderboard, /api/statistics
- Health and diagnostics endpoints: /api/health, /api/health/liveness, /api/health/ping, /api/diag
- Real-time hubs: /couplequiz/hubs/game, /funquiz/gamehub, /porunner/gamehub, /poracer/lobby-hub

## Engineering standards
- Trim-safe models and shared contracts should stay compatible with <EnableTrimAnalyzer> and avoid IL-suppression-driven patterns.
- Logging should be structured, source-generated where practical, and avoid allocation-heavy string interpolation in hot paths.
- New persistence should follow the single-home rule: game-local storage under Features/<Slice>/Storage and shared platform storage under the infrastructure project.
