param(
    [string]$ApiBase = 'http://127.0.0.1:5000',
    [string]$ClientBase = 'http://127.0.0.1:5173'
)

$ErrorActionPreference = 'Stop'

# ─── Dist freshness guard ─────────────────────────────────────────────────────
$distIndex = Join-Path $PSScriptRoot '..' 'src' 'PoMiniGames.Client' 'dist' 'index.html'
$srcRoot   = Join-Path $PSScriptRoot '..' 'src' 'PoMiniGames.Client' 'src'

if (Test-Path $distIndex) {
    $distTime = (Get-Item $distIndex).LastWriteTimeUtc
    $newestSrc = Get-ChildItem $srcRoot -Recurse -Include '*.ts','*.tsx' |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($newestSrc -and $newestSrc.LastWriteTimeUtc -gt $distTime) {
        Write-Warning "SPA dist may be stale: '$($newestSrc.Name)' ($($newestSrc.LastWriteTimeUtc)) is newer than dist/index.html ($distTime). Run 'npm run build' in src/PoMiniGames.Client."
    } else {
        Write-Host '[PASS] SPA dist is up-to-date'
    }
} else {
    Write-Warning 'dist/index.html not found — SPA has not been built. Run ''npm run build'' in src/PoMiniGames.Client.'
}

$checks = @(
    @{ Name = 'API ping'; Url = "$ApiBase/api/health/ping"; Expected = @('pong') },
    @{ Name = 'API health'; Url = "$ApiBase/api/health"; Expected = @('"status":"Healthy"', 'SqliteStorage') },
    @{ Name = 'Diagnostics summary'; Url = "$ApiBase/diag"; Expected = @('"environment"', '"devLogFile":"logs/pominigames-.log"') },
    @{ Name = 'Vite proxy health'; Url = "$ClientBase/api/health/ping"; Expected = @('pong') },
    @{ Name = 'Client home'; Url = "$ClientBase/"; Expected = @('PoMiniGames') },
    @{ Name = 'Client PoDropSquare route'; Url = "$ClientBase/podropsquare"; Expected = @('PoMiniGames') },
    @{ Name = 'Client PoRaceRagdoll route'; Url = "$ClientBase/poraceragdoll"; Expected = @('PoMiniGames') }
)

foreach ($check in $checks) {
    Write-Host "[CHECK] $($check.Name): $($check.Url)"

    $response = Invoke-WebRequest -Uri $check.Url -UseBasicParsing -TimeoutSec 20
    if ($response.StatusCode -ne 200) {
        throw "Unexpected status code $($response.StatusCode) for $($check.Url)"
    }

    foreach ($fragment in $check.Expected) {
        if (-not $response.Content.Contains($fragment)) {
            throw "Response for $($check.Name) did not contain expected fragment: $fragment"
        }
    }

    Write-Host "[PASS] $($check.Name)"
}

Write-Host ''
Write-Host 'Local smoke check completed successfully.'