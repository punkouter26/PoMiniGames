$h = @{
    "X-Fake-User"  = "qa-demo"
    "X-Fake-Roles" = "authenticated"
}
foreach ($g in "tictactoe","connectfive","couplequiz","poracer","pomarblerace","pojoker","pobrawl","posurvive") {
    $e = "/api/leaderboards/$g"
    $code = 'N/A'
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:5000$e" -UseBasicParsing -Headers $h -TimeoutSec 5
        $code = $r.StatusCode
    } catch {
        $code = "ERR: $($_.Exception.Message)"
    }
    "{0,-15} -> {1}" -f $g, $code
}
"--- health"
try {
    (Invoke-WebRequest -Uri "http://localhost:5000/api/health/ping" -UseBasicParsing -Headers $h -TimeoutSec 5).StatusCode
} catch {
    "ERR: $($_.Exception.Message)"
}