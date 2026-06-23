# PoMiniGames.E2ETests

C# end-to-end tests, replacing the legacy Playwright JavaScript spec suite
(`tests/e2e/`, removed during the 2026-06-23 §5 migration to satisfy the
"Unit & Integration: C# only" rule).

## What runs here

- **`ApiContractSmokeTests`** — verifies the public HTTP shape of the BFF
  (`/api/health/ping`, `/api/auth/config`, `/auth/me`, fake-auth header flow).
- **`HomeSmokeTests`** — verifies that the root path and deep links return the
  WASM shell `index.html` (SPA fallback contract).
- **`DeploymentSmokeTests`** — verifies the routes the Azure availability
  test pings in production (`/health`, `/api/auth/config`, `/openapi/v1.json`).

## What is NOT yet covered (TODO)

The following JS specs were dropped in the migration and need C# ports:

| Source spec (deleted)            | Suggested C# home                       |
|----------------------------------|------------------------------------------|
| `connectfive.spec.js`            | `tests/PoMiniGames.UnitTests/Features/ConnectFive/` (component-level) |
| `dev-bypass-identity.spec.js`    | Extend `ApiContractSmokeTests` with `/api/auth/dev-bypass` flow |
| `error-scenarios.spec.js`        | `DeploymentSmokeTests` (status-code asserts) |
| `offline-resilience.spec.js`     | `HomeSmokeTests` (route-fallback) + unit-level `LocalStorageService` |
| `poclick.spec.js`                | New file: `PoClickSmokeTests.cs` |
| `pofight.spec.js`                | New file: `PoFightSmokeTests.cs` |
| `posnakegame.spec.js`            | New file: `PoSnakeGameSmokeTests.cs` |
| `tictactoe.spec.js`              | New file: `TicTacToeSmokeTests.cs` |

Each port should follow the `PoMiniGamesE2EFixture` pattern: spin the host
in-process via `WebApplicationFactory<Program>`, force
`Auth:EnableFakeAuth=true` so `[Authorize]`-guarded routes are reachable,
and assert against the HTTP contract (status code + JSON shape) rather than
the rendered DOM.

## Running

```pwsh
# from repo root
dotnet test tests/PoMiniGames.E2ETests/PoMiniGames.E2ETests.csproj
```

> Requires Docker (Azurite) for the storage layer. `UseDevelopmentStorage=true`
> in the fixture is honored by the in-process host; the test runner does not
> need an external Azurite instance because the storage is reached on
> `127.0.0.1:10002`, which is where `scripts/setup.ps1` brings it up.
