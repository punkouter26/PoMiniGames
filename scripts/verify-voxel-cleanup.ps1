$patterns = @(
    "staticwebassets*.json"
)
$found = $false
foreach ($pat in $patterns) {
    Get-ChildItem -Path "src" -Recurse -Filter $pat -ErrorAction SilentlyContinue | ForEach-Object {
        $content = Get-Content -Raw $_.FullName
        $voxel = ([regex]::Matches($content, 'voxel', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)).Count
        Write-Host "$($_.FullName)  size=$($_.Length)  voxel-refs=$voxel"
        if ($voxel -gt 0) { $found = $true }
    }
}
if (-not $found) { Write-Host "CLEAN: no voxel refs in any staticwebassets manifest" }