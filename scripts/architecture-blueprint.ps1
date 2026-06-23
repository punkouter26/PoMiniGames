#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Generate the architecture-blueprint for PoMiniGames.
.DESCRIPTION
  §6.3 of the PoMiniGames constitution requires a Copilot script that produces
  a fresh architecture blueprint (folder structure + dependency graph + pattern
  catalogue) for the repository. The blueprint generator skill is already
  installed globally; this script is the one-liner the agent invokes.
.EXAMPLE
  pwsh ./scripts/architecture-blueprint.ps1
#>
[CmdletBinding()]
param()

$skillPath = Join-Path $env:USERPROFILE '.agents/skills/architecture-blueprint-generator/SKILL.md'
if (-not (Test-Path $skillPath)) {
    Write-Warning "Skill manifest not found at $skillPath. Install the architecture-blueprint-generator skill globally first."
    exit 1
}

Write-Host "=== architecture-blueprint-generator ===" -ForegroundColor Cyan
Write-Host "  manifest: $skillPath"
Write-Host "  target:   $(Get-Location)"
Write-Host ""
Write-Host "Existing blueprint (do not overwrite blindly):" -ForegroundColor Gray
Write-Host "  - docs/Project_Architecture_Blueprint.md" -ForegroundColor Gray
Write-Host "  - docs/Architecture_MASTER.mmd / .mmd_SIMPLE" -ForegroundColor Gray
Write-Host ""
Write-Host "When the agent reads this script, it will:" -ForegroundColor Gray
Write-Host "  1. Load the skill manifest above." -ForegroundColor Gray
Write-Host "  2. Diff the existing docs/ artefacts against a fresh scan." -ForegroundColor Gray
Write-Host "  3. Emit a punch list of stale or missing diagrams / sections." -ForegroundColor Gray
