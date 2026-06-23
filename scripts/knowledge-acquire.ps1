#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Invoke the acquire-codebase-knowledge skill on this repository.
.DESCRIPTION
  §6.3 of the PoMiniGames constitution requires a single entry point for repository
  onboarding / mapping. This script is a thin wrapper: it points the agent at the
  installed skill manifest and the working directory to map.
.EXAMPLE
  pwsh ./scripts/knowledge-acquire.ps1 -Depth thorough
#>
[CmdletBinding()]
param(
    [ValidateSet('quick', 'medium', 'thorough')]
    [string]$Depth = 'medium'
)

$skillPath = Join-Path $env:USERPROFILE '.agents/skills/acquire-codebase-knowledge/SKILL.md'
if (-not (Test-Path $skillPath)) {
    Write-Warning "Skill manifest not found at $skillPath. Install the acquire-codebase-knowledge skill globally first."
    exit 1
}

Write-Host "=== acquire-codebase-knowledge ===" -ForegroundColor Cyan
Write-Host "  manifest: $skillPath"
Write-Host "  depth:    $Depth"
Write-Host "  target:   $(Get-Location)"
Write-Host ""
Write-Host "When the agent reads this script, it will:" -ForegroundColor Gray
Write-Host "  1. Load $skillPath." -ForegroundColor Gray
Write-Host "  2. Map the PoMiniGames solution: src/, tests/, infra/, scripts/, docs/." -ForegroundColor Gray
Write-Host "  3. Emit a Markdown summary suitable for handoff to a new contributor." -ForegroundColor Gray
