#!/usr/bin/env pwsh
<#
.SYNOPSIS
  First-run setup for PoMiniGames on bare hardware.
  Installs required tooling via WinGet, starts the Azurite Table Storage container,
  and validates Azure CLI login for Key Vault access.
.NOTES
  Idempotent — safe to re-run. Skips anything already present.
#>

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Message) { Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "  [OK]   $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WinGet([string]$Id, [string]$Command) {
    if (Test-Command $Command) {
        Write-Ok "$Command already installed"
        return
    }
    if (-not (Test-Command 'winget')) {
        Write-Warn "winget not available — install '$Id' manually."
        return
    }
    Write-Host "  Installing $Id ..." -ForegroundColor Gray
    winget install --id $Id --silent --accept-source-agreements --accept-package-agreements
    Write-Ok "Installed $Id"
}

# ── 1. Tooling ───────────────────────────────────────────────────────────
Write-Step 'Installing required tooling (WinGet)'
Install-WinGet -Id 'Microsoft.DotNet.SDK.10' -Command 'dotnet'
Install-WinGet -Id 'Docker.DockerDesktop'    -Command 'docker'
Install-WinGet -Id 'Microsoft.AzureCLI'      -Command 'az'
Install-WinGet -Id 'OpenJS.NodeJS.LTS'       -Command 'node'

# ── 2. Azurite (local Table Storage) ─────────────────────────────────────
Write-Step 'Starting Azurite container (local Table Storage)'
if (Test-Command 'docker') {
    try {
        docker compose -f (Join-Path $repoRoot 'docker-compose.yml') up -d | Out-Null
        Write-Ok 'Azurite container "pominigames" is running'
    } catch {
        Write-Warn "Could not start Azurite via docker compose: $($_.Exception.Message)"
    }
} else {
    Write-Warn 'Docker not available — skipping Azurite startup.'
}

# ── 3. Azure CLI login (Key Vault access) ────────────────────────────────
Write-Step 'Validating Azure CLI login (Key Vault access)'
if (Test-Command 'az') {
    try {
        $account = az account show --output json 2>$null | ConvertFrom-Json
        if ($account) {
            Write-Ok "Signed in to Azure as $($account.user.name) (sub: $($account.name))"
        } else {
            Write-Warn 'Not signed in. Run: az login'
        }
    } catch {
        Write-Warn 'Not signed in. Run: az login'
    }
} else {
    Write-Warn 'Azure CLI not available — skipping login check.'
}

# ── 4. Restore + build ───────────────────────────────────────────────────
Write-Step 'Restoring and building the solution'
dotnet restore (Join-Path $repoRoot 'PoMiniGames.slnx')
dotnet build   (Join-Path $repoRoot 'PoMiniGames.slnx') -c Debug --no-restore

Write-Host "`nSetup complete. Run the app with:" -ForegroundColor Cyan
Write-Host "  dotnet run --project src/PoMiniGames/PoMiniGames" -ForegroundColor Gray
Write-Host "Then it is available at http://localhost:5000`n" -ForegroundColor Gray
