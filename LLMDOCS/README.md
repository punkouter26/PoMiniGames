# PoMiniGames LLM Notes

## Project identity
- Solution name: PoMiniGames
- Prefix convention: PoMiniGames for namespaces, app resources, and app-scoped secrets.
- Runtime ports: HTTP 5000 and HTTPS 5001.

## Current architecture map
- Server API host: src/PoMiniGames/PoMiniGames
- Client WASM: src/PoMiniGames.Client
- Shared library: src/PoShared
- Tests: tests/PoMiniGames.UnitTests, tests/PoMiniGames.IntegrationTests, tests/e2e

## Public APIs
- Health: /health, /api/health, /api/health/ping, /alive
- Diagnostics: /diag
- OpenAPI: /openapi/v1.json and /scalar/v1
- Auth: /api/auth/config, /api/auth/dev-login, /api/auth/me, /api/auth/dev-logout

## Testing summary
- Unit tests validate pure logic and helper behavior.
- Integration tests validate API and local auth paths.
- E2E tests validate critical Blazor UI flows and offline resilience.

## Local dev expectations
- Use kill-dotnet prelaunch cleanup before debugging.
- Start API host and open Edge to https://localhost:5001.
- Keep diagnostics enabled only in development.
