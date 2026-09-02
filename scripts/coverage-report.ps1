<#
.SYNOPSIS
  Build one HTML coverage report from every tier that produced coverage.

.DESCRIPTION
  Collects coverlet Cobertura output from the xUnit tiers (dotnet test with
  --collect:"XPlat Code Coverage") and the Vitest cobertura file for the
  PoEcosystem simulation, then merges them with ReportGenerator
  (.config/dotnet-tools.json) into coverage/report/index.html.

  Run the tiers yourself first (see scripts/test-all.ps1); this script only
  renders what already exists so it never re-runs the slow tiers.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$inputs = @()
$inputs += Get-ChildItem -Path (Join-Path $repoRoot 'tests') -Recurse -Filter 'coverage.cobertura.xml' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
$vitest = Join-Path $repoRoot 'coverage/poecosystem/cobertura-coverage.xml'
if (Test-Path $vitest) { $inputs += $vitest }

if ($inputs.Count -eq 0) {
    Write-Host 'No coverage files found. Run `npm run test:coverage` and/or `dotnet test --collect:"XPlat Code Coverage"` first.' -ForegroundColor Yellow
    exit 1
}

dotnet tool restore | Out-Null
$reports = ($inputs -join ';')
dotnet reportgenerator "-reports:$reports" "-targetdir:coverage/report" "-reporttypes:Html;TextSummary"
Get-Content (Join-Path $repoRoot 'coverage/report/Summary.txt')
Write-Host "Report: $(Join-Path $repoRoot 'coverage/report/index.html')" -ForegroundColor Green
