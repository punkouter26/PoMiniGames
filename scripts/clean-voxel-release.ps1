$patterns = @(
    "staticwebassets*.json"
)
$totalDeleted = 0
foreach ($pat in $patterns) {
    Get-ChildItem -Path "src" -Recurse -Filter $pat -ErrorAction SilentlyContinue | ForEach-Object {
        $content = Get-Content -Raw $_.FullName
        $voxel = ([regex]::Matches($content, 'voxel', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)).Count
        if ($voxel -gt 0) {
            Remove-Item -Path $_.FullName -Force
            Write-Host "DELETED: $($_.FullName)  ($voxel voxel refs)"
            $totalDeleted++
        }
    }
}
Write-Host "Total deleted: $totalDeleted"