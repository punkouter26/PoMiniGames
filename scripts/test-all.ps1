#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Singular, CI-equivalent test orchestrator for PoMiniGames. Runs the full tiered
  suite (Unit -> Integration -> E2E-API -> E2E-UI) the same way locally and in CI.
.DESCRIPTION
  Preflight (idempotent):
    1. Free the host lock — a running `dotnet run` host (port 5000) locks the build
       output DLLs and breaks a full-solution build. Kill only that host, never the
       unrelated dotnet processes (MCP servers, language servers).
    2. Bring up the shared Azurite container (the E2E-API tier binds 127.0.0.1:10002).
       The Unit tier needs nothing; Integration and E2E-UI spin their own Azurite via
       Testcontainers.
    3. Install the pinned Playwright Chromium build (no-op if already present).
    4. Build once with -warnaserror honored.
  Then each tier runs in order, results roll up, and structural ceilings
  (the 100/50/25/25 Rule) are checked. Exit code is non-zero on any tier failure.
.NOTES
  Ceiling overage is reported as a loud WARN (non-fatal) so coverage is never deleted
  to satisfy a counter; runaway growth still surfaces immediately in the summary.
#>

param(
    [switch]$SkipPlaywrightInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$slnx = Join-Path $repoRoot 'PoMiniGames.slnx'

function Write-Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Err([string]$m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red }

# ── Preflight 1: free the host lock (scoped, not a blanket dotnet kill) ───────
Write-Step 'Freeing host lock (port 5000 + PoMiniGames host process)'
try {
    $conns = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Ok "Stopped process $($c.OwningProcess) holding port 5000"
    }
} catch { Write-Warn "Port 5000 check skipped: $($_.Exception.Message)" }
Get-Process -Name 'PoMiniGames' -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    Write-Ok "Stopped host process PoMiniGames ($($_.Id))"
}

# ── Preflight 2: shared Azurite for the E2E-API tier ─────────────────────────
Write-Step 'Ensuring shared Azurite container (E2E-API tier)'
if (Get-Command docker -ErrorAction SilentlyContinue) {
    try {
        docker compose -f (Join-Path $repoRoot 'docker-compose.yml') up -d | Out-Null
        Write-Ok 'Azurite container "pominigames" is up'
    } catch { Write-Warn "Could not start Azurite: $($_.Exception.Message)" }
} else {
    Write-Warn 'Docker not available — E2E-API/Integration storage tiers may fail.'
}

# ── Preflight 3: build once ──────────────────────────────────────────────────
Write-Step 'Building the solution (warnings are errors)'
dotnet build $slnx -c Debug --nologo -v minimal

# ── Preflight 4: Playwright browsers ─────────────────────────────────────────
if (-not $SkipPlaywrightInstall) {
    Write-Step 'Ensuring Playwright Chromium (E2E-UI tier)'
    $pw = Join-Path $repoRoot 'tests/PoMiniGames.E2EUI/bin/Debug/net10.0/playwright.ps1'
    if (Test-Path $pw) {
        try { & $pw install chromium | Out-Null; Write-Ok 'Playwright Chromium ready' }
        catch { Write-Warn "Playwright install failed: $($_.Exception.Message)" }
    } else { Write-Warn "Playwright script not found at $pw" }
}

# ── Tiered run ───────────────────────────────────────────────────────────────
# Tier name -> @{ Project; Ceiling } per the 100/50/25/25 Rule.
$tiers = [ordered]@{
    'Unit'        = @{ Project = 'tests/PoMiniGames.UnitTests/PoMiniGames.UnitTests.csproj';        Ceiling = 100 }
    'Integration' = @{ Project = 'tests/PoMiniGames.IntegrationTests/PoMiniGames.IntegrationTests.csproj'; Ceiling = 50 }
    'E2EAPI'      = @{ Project = 'tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj';               Ceiling = 25 }
    'E2EUI'       = @{ Project = 'tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj';                 Ceiling = 25 }
}

$summary = @()
$anyFailed = $false

foreach ($name in $tiers.Keys) {
    $proj = $tiers[$name].Project
    $ceiling = $tiers[$name].Ceiling
    Write-Step "Running $name tier"

    $output = dotnet test (Join-Path $repoRoot $proj) --no-build -c Debug --nologo 2>&1
    $output | ForEach-Object { Write-Host $_ }

    $line = ($output | Select-String -Pattern 'Passed:\s*\d+|Failed:\s*\d+|Total:\s*\d+' | Select-Object -Last 1)
    $passed = 0; $failed = 0; $total = 0
    if ($line -match 'Failed:\s*(\d+).*Passed:\s*(\d+).*Total:\s*(\d+)') {
        $failed = [int]$Matches[1]; $passed = [int]$Matches[2]; $total = [int]$Matches[3]
    }

    $tierFailed = ($LASTEXITCODE -ne 0) -or ($failed -gt 0)
    if ($tierFailed) { $anyFailed = $true; Write-Err "$name: $failed failed / $total total" }
    else { Write-Ok "$name: $passed passed / $total total" }

    $ceilingNote = ''
    if ($total -gt $ceiling) {
        $ceilingNote = "OVER CEILING ($total/$ceiling)"
        Write-Warn "$name exceeds the $ceiling-test ceiling ($total). Consolidate or relocate — do not raise the cap."
    } else {
        $ceilingNote = "$total/$ceiling"
    }

    $summary += [pscustomobject]@{ Tier = $name; Passed = $passed; Failed = $failed; Total = $total; Ceiling = $ceilingNote }
}

# ── Roll-up ──────────────────────────────────────────────────────────────────
Write-Step 'Test summary'
$summary | Format-Table -AutoSize | Out-String | Write-Host

if ($anyFailed) {
    Write-Err 'One or more tiers failed.'
    exit 1
}
Write-Ok 'All tiers passed.'
exit 0
