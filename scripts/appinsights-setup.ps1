#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Apply the appinsights-instrumentation skill to the PoMiniGames host project.
.DESCRIPTION
  §6.3 of the PoMiniGames constitution requires a Copilot script that wires the
  Application Insights instrumentation. The host project already ships with
  Serilog + Azure Monitor OTel wiring (see src/PoMiniGames.API/Infrastructure/
  TelemetryExtensions.cs and LoggingExtensions.cs); this script is the entry point
  for an agent to (re)validate the configuration against the skill's checklist.
.EXAMPLE
  pwsh ./scripts/appinsights-setup.ps1
#>
[CmdletBinding()]
param()

$skillPath = Join-Path $env:USERPROFILE '.agents/skills/appinsights-instrumentation/SKILL.md'
if (-not (Test-Path $skillPath)) {
    Write-Warning "Skill manifest not found at $skillPath. Install the appinsights-instrumentation skill globally first."
    exit 1
}

Write-Host "=== appinsights-instrumentation ===" -ForegroundColor Cyan
Write-Host "  manifest: $skillPath"
Write-Host ""
Write-Host "Existing instrumentation (do not regress):" -ForegroundColor Gray
Write-Host "  - src/PoMiniGames.API/Infrastructure/TelemetryExtensions.cs" -ForegroundColor Gray
Write-Host "  - src/PoMiniGames.API/Infrastructure/LoggingExtensions.cs" -ForegroundColor Gray
Write-Host "  - Serilog -> ApplicationInsights sink (TraceTelemetryConverter)" -ForegroundColor Gray
Write-Host "  - OTel UseAzureMonitor with cloud_RoleName = assembly name" -ForegroundColor Gray
Write-Host "  - SamplingRatio = 1.0 in Dev/Test, 0.1 in Prod" -ForegroundColor Gray
Write-Host ""
Write-Host "When the agent reads this script, it will diff the skill checklist against" -ForegroundColor Gray
Write-Host "the implementation above and emit any missing-instrumentation findings." -ForegroundColor Gray
