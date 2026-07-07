# Demo mode QA: hit each demo URL, verify HTTP 200, and check no JS errors logged
# This is a server-side smoke check; the browser-side visit is done by the agent.

$ErrorActionPreference = 'Stop'
$urls = @(
    'http://localhost:5000/poclick/1'
    'http://localhost:5000/tictactoe/1'
    'http://localhost:5000/connectfive/1'
    'http://localhost:5000/face/demo'
    'http://localhost:5000/poracer/demo'
    'http://localhost:5000/pomarblerace?demo=1'
    'http://localhost:5000/pojoker'
    'http://localhost:5000/pobrawl/1'
    'http://localhost:5000/posurvive?demo=1'
)

foreach ($u in $urls) {
    try {
        $r = Invoke-WebRequest -Uri $u -Method Get -UseBasicParsing -TimeoutSec 5
        Write-Host ("[OK]   {0}  ({1})" -f $u, $r.StatusCode)
    } catch {
        Write-Host ("[FAIL] {0}  -> {1}" -f $u, $_.Exception.Message)
    }
}