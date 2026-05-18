#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Smoke-tests the locally running PoMiniGames API.
  Verifies the health, diagnostics, and OpenAPI endpoints respond correctly.
  Requires the app to be running on http://localhost:5000.
#>

$BASE = "http://localhost:5000"
$PASS = 0
$FAIL = 0

function Test-Endpoint {
    param([string]$Label, [string]$Url, [int]$ExpectedStatus = 200)
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        if ($resp.StatusCode -eq $ExpectedStatus) {
            Write-Host "  [PASS] $Label ($($resp.StatusCode))" -ForegroundColor Green
            $script:PASS++
        } else {
            Write-Host "  [FAIL] $Label — expected $ExpectedStatus, got $($resp.StatusCode)" -ForegroundColor Red
            $script:FAIL++
        }
    } catch {
        Write-Host "  [FAIL] $Label — $($_.Exception.Message)" -ForegroundColor Red
        $script:FAIL++
    }
}

Write-Host "`nPoMiniGames smoke test against $BASE`n" -ForegroundColor Cyan

Test-Endpoint "GET /health"        "$BASE/health"
Test-Endpoint "GET /api/health"    "$BASE/api/health"
Test-Endpoint "GET /api/health/ping" "$BASE/api/health/ping"
Test-Endpoint "GET /diag"          "$BASE/diag"
Test-Endpoint "GET /openapi/v1.json" "$BASE/openapi/v1.json"

Write-Host "`nResults: $PASS passed, $FAIL failed`n" -ForegroundColor $(if ($FAIL -eq 0) { "Green" } else { "Red" })
exit $FAIL
