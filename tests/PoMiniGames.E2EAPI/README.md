# PoMiniGames.E2EAPI

C# end-to-end **API** tests — pure HTTP calls that emulate functionality against
the in-process host. No browser. Browser/UI coverage lives in the sibling
[`PoMiniGames.E2EUI`](../PoMiniGames.E2EUI/) project.

These replaced the legacy Playwright JavaScript spec suite (`tests/e2e/`, removed
during the 2026-06-23 §5 migration to satisfy the "Unit & Integration: C# only"
rule).

## What runs here

- **`ApiContractSmokeTests`** — verifies the public HTTP shape of the BFF
  (`/api/health/ping`, `/api/auth/config`, `/auth/me`, fake-auth header flow).
- **`HomeSmokeTests`** — verifies that the root path and deep links return the
  WASM shell `index.html` (SPA fallback contract).
- **`DeploymentSmokeTests`** — verifies the routes the Azure availability
  test pings in production (`/health`, `/api/auth/config`, `/openapi/v1.json`).

Each test follows the `PoMiniGamesE2EFixture` pattern: spin the host in-process
via `WebApplicationFactory<Program>`, force `Auth:EnableFakeAuth=true` so
`[Authorize]`-guarded routes are reachable, and assert against the HTTP contract
(status code + JSON shape) rather than the rendered DOM.

## What is NOT yet covered (TODO)

The following JS specs were dropped in the migration and need C# ports. Pure-API
asserts belong here; anything that needs the rendered DOM belongs in
`PoMiniGames.E2EUI`.

| Source spec (deleted)            | Suggested home                          |
|----------------------------------|------------------------------------------|
| `dev-bypass-identity.spec.js`    | Extend `ApiContractSmokeTests` with `/api/auth/dev-bypass` flow |
| `error-scenarios.spec.js`        | `DeploymentSmokeTests` (status-code asserts) |
| `offline-resilience.spec.js`     | `HomeSmokeTests` (route-fallback) + unit-level `LocalStorageService` |
| `poclick.spec.js`                | `PoMiniGames.E2EUI` (real clicks) or `PoClickSmokeTests.cs` (API) |
| `connectfive.spec.js`            | `tests/PoMiniGames.UnitTests/` (component) or E2EUI (browser) |

## Running

```pwsh
# from repo root — requires Azurite on 127.0.0.1:10002 (scripts/setup.ps1)
dotnet test tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj
```
