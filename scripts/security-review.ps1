#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Invoke the security-review skill on the current repository.
.DESCRIPTION
  §6.3 of the PoMiniGames constitution requires a one-line entry point for OWASP /
  secret-leak / injection audits. This script is a thin wrapper: it prints the skill
  manifest so the agent knows which file to load before running the audit.
.EXAMPLE
  pwsh ./scripts/security-review.ps1
#>
[CmdletBinding()]
param()

$skillPath = Join-Path $env:USERPROFILE '.agents/skills/security-review/SKILL.md'
if (-not (Test-Path $skillPath)) {
    Write-Warning "Skill manifest not found at $skillPath. Install the security-review skill globally first."
    exit 1
}

Write-Host "=== security-review skill ===" -ForegroundColor Cyan
Write-Host "  manifest: $skillPath"
Write-Host ""
Write-Host "When the agent (Claude Code / Copilot) reads this script, it will:" -ForegroundColor Gray
Write-Host "  1. Open $skillPath and follow its instructions." -ForegroundColor Gray
Write-Host "  2. Apply its OWASP / injection / secrets / cryptography checks to $(Get-Location)." -ForegroundColor Gray
Write-Host "  3. Emit a findings table with severity + file:line references." -ForegroundColor Gray
