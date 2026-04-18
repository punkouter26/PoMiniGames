#Requires -Version 5.1
<#
.SYNOPSIS
  Local smoke test for PoMiniGames — verifies the client, API, and key endpoints
  are all responding before running E2E or integration tests.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ClientBase = 'http://localhost:5173'
$ApiBase    = 'http://localhost:5000'

$checks = @(
    @{ Label = 'Client root';          Url = "$ClientBase/";                      Expect = 200 },
    @{ Label = 'API /health';          Url = "$ApiBase/health";                   Expect = 200 },
    @{ Label = 'API /api/health/ping'; Url = "$ApiBase/api/health/ping";          Expect = 200 },
    @{ Label = 'API /diag';            Url = "$ApiBase/diag";                     Expect = 200 },
    @{ Label = 'API auth/config';      Url = "$ApiBase/api/auth/config";          Expect = 200 },
    @{ Label = 'Leaderboard endpoint'; Url = "$ApiBase/api/connectfive/statistics/leaderboard"; Expect = 200 }
)

$passed = 0
$failed = 0

foreach ($c in $checks) {
    try {
        $resp = Invoke-WebRequest -Uri $c.Url -UseBasicParsing -TimeoutSec 10
        if ($resp.StatusCode -eq $c.Expect) {
            Write-Host "  [PASS] $($c.Label) -> $($resp.StatusCode)" -ForegroundColor Green
            $passed++
        } else {
            Write-Host "  [FAIL] $($c.Label) -> got $($resp.StatusCode), expected $($c.Expect)" -ForegroundColor Red
            $failed++
        }
    } catch {
        Write-Host "  [FAIL] $($c.Label) -> ERROR: $($_.Exception.Message)" -ForegroundColor Red
        $failed++
    }
}

Write-Host ""
Write-Host "Smoke result: $passed passed, $failed failed" -ForegroundColor $(if ($failed -eq 0) { 'Cyan' } else { 'Yellow' })

if ($failed -gt 0) {
    exit 1
}
exit 0
