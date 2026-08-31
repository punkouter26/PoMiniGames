# scripts/

Working scripts only — the one-off debug files that used to live here were removed in
the 2026-08-18 cleanup (they referenced files that no longer exist and had no callers).

| Script | Purpose | Called from |
|---|---|---|
| `test-all.ps1` | Full CI-equivalent test run (Unit → Integration → E2E-API → E2E-UI); frees port 5000, starts Azurite, installs Playwright | CLAUDE.md, E2E-UI csproj, deploy.yml (policy) |
| `setup.ps1` | One-time dev-machine setup | CLAUDE.md, E2E-API fixture docs |
| `smoke-local.ps1` | Local smoke of the running app | `.vscode/tasks.json` |
| `deploy-preflight.ps1` | Pre-`azd up` checks | CLAUDE.md |
| `branch-hygiene.ps1` | Branch policy helper | deploy.yml (policy comment) |
| `_count-tests.ps1` | Counts `[Fact]`/`[Theory]` methods per tier (the 100/50/25/25 rule) | docs |
| `coverage-matrix.ps1` | Coverage matrix for the PRD | docs/PRD_Master.md |
| `posports-assets.ps1` | Re-exports PoSports sprite sheets: `*-spritesheet/` source dirs → lowercase runtime dirs (`atlas.json` + `spritesheet.webp`) | PoMiniGamesClient.csproj comment |
| `bake-marble-track.mjs` / `build-marble-track-2.py` / `marble_track_2.course.json` | PoMarbleRace track baking pipeline | js/pomarblerace/* |

Languages are mixed on purpose (PowerShell, Node, Python) — each pipeline uses
whatever its toolchain needs. Development is Windows/`pwsh`.

`build-marble-track-2.py` is Python because it runs **inside Blender** (via the Blender MCP
add-on) — it is the source-of-truth generator for the map-3 course geometry, and Blender's
embedded interpreter only speaks Python. It is not a stray toolchain choice; do not port it
to Node. See the file header for the run recipe and the export contract the baker asserts.
