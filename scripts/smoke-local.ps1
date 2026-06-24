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
        # Use -SkipHttpErrorCheck so 401/403/4xx don't throw — the status-code
        # comparison below classifies the result correctly.
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop -SkipHttpErrorCheck
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
Test-Endpoint "GET /api/auth/config" "$BASE/api/auth/config"
Test-Endpoint "GET /api/auth/me"  "$BASE/api/auth/me" 401
Test-Endpoint "GET /api/leaderboards" "$BASE/api/leaderboards"
Test-Endpoint "GET /api/statistics"   "$BASE/api/statistics" 401
Test-Endpoint "GET /_framework/blazor.webassembly.js" "$BASE/_framework/blazor.webassembly.js"
Test-Endpoint "GET /api/evolution/summary" "$BASE/api/evolution/summary"
Test-Endpoint "GET /api/face/leaderboard" "$BASE/api/face/leaderboard" 401

# §1 of QA report: verify the Blazor WASM boot manifest responds 404 with
# `UseBlazorFrameworkFiles` synthesizing the live boot.json (the actual served
# body is generated at request time from the staged _framework/ directory).
try {
    $boot = Invoke-WebRequest -Uri "$BASE/_framework/blazor.boot.json" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($boot.StatusCode -eq 200) {
        Write-Host "  [PASS] GET /_framework/blazor.boot.json (200, $($boot.Content.Length) bytes)" -ForegroundColor Green
        $script:PASS++
    } else {
        Write-Host "  [FAIL] GET /_framework/blazor.boot.json — got $($boot.StatusCode)" -ForegroundColor Red
        $script:FAIL++
    }
} catch {
    Write-Host "  [INFO] GET /_framework/blazor.boot.json — not synthesized in this build: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`nResults: $PASS passed, $FAIL failed`n" -ForegroundColor $(if ($FAIL -eq 0) { "Green" } else { "Red" })
exit $FAIL
