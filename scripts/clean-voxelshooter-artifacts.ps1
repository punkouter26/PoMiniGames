$paths = @(
    "src\PoMiniGames.Client\obj\Debug\net10.0\staticwebassets.publish.json",
    "src\PoMiniGames.Client\obj\Debug\net10.0\staticwebassets.publish.endpoints.json",
    "src\PoMiniGames.Client\obj\Debug\net10.0\staticwebassets.build.json",
    "src\PoMiniGames.Client\obj\Debug\net10.0\staticwebassets.build.endpoints.json",
    "src\PoMiniGames.Client\obj\Debug\net10.0\staticwebassets.development.json",
    "src\PoMiniGames.Client\obj\Debug\net10.0\rbcswa.dswa.cache.json",
    "src\PoMiniGames.Client\obj\Debug\net10.0\rjimswa.dswa.cache.json",
    "src\PoMiniGames.Client\obj\Debug\net10.0\rjsmcshtml.dswa.cache.json",
    "src\PoMiniGames.Client\obj\Debug\net10.0\rjsmrazor.dswa.cache.json",
    "src\PoMiniGames.Client\obj\Debug\net10.0\rpswa.dswa.cache.json",
    "src\PoMiniGames.Client\obj\Debug\net10.0\swae.build.ex.cache",
    "src\PoMiniGames.Client\obj\Debug\net10.0\swae.publish.ex.cache",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\staticwebassets.publish.json",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\staticwebassets.publish.endpoints.json",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\staticwebassets.build.json",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\staticwebassets.build.endpoints.json",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\rbcswa.dswa.cache.json",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\rjimswa.dswa.cache.json",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\rjsmcshtml.dswa.cache.json",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\rjsmrazor.dswa.cache.json",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\rpswa.dswa.cache.json",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\swae.build.ex.cache",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\swae.publish.ex.cache"
)
foreach ($p in $paths) {
    if (Test-Path $p) {
        Remove-Item -Path $p -Force
        Write-Host "DELETED $p"
    } else {
        Write-Host "absent: $p"
    }
}

# Also remove compressed/publish subtree that may contain .br files for voxelshooter
$compressedDirs = @(
    "src\PoMiniGames.Client\obj\Debug\net10.0\compressed",
    "src\PoMiniGames\PoMiniGames\obj\Debug\net10.0\compressed"
)
foreach ($d in $compressedDirs) {
    if (Test-Path $d) {
        Get-ChildItem -Path $d -Recurse -Filter "*voxel*" -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item -Path $_.FullName -Force
            Write-Host "DELETED compressed voxel: $($_.FullName)"
        }
    }
}
Write-Host "DONE"