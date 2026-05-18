# Scripts

This folder contains PowerShell utility scripts for the PoMiniGames project.

| Script | Purpose |
|--------|---------|
| `poshared-dryrun.ps1` | Dry-run scan of PoShared candidate orphan Azure resources. Outputs a go/no-go matrix and safe deletion commands for resources unused in the last 90 days. Does **not** delete anything. Run before any manual cleanup of the shared resource group. |
| `smoke-local.ps1` | Quick smoke-test that verifies the locally running API responds on port 5000 (`/health`, `/api/health`, `/diag`). Requires the app to already be running. |

## Usage

```powershell
# Scan PoShared for orphan resources (read-only)
./scripts/poshared-dryrun.ps1

# Smoke-test the locally running app
./scripts/smoke-local.ps1
```

## Requirements

- **Azure CLI** (`az`) logged in with an account that has read access to the `PoShared` resource group.
- **PowerShell 7+** (the `pwsh` executable).
- The app running locally on http://localhost:5000 for `smoke-local.ps1`.
