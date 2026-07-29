#requires -Version 5
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$root = (Get-Location).Path

$tiers = @('PoMiniGames.Unit','PoMiniGames.Integration','E2EAPI','E2EUI')
foreach ($t in $tiers) {
    $p = Join-Path 'tests' $t
    if (-not (Test-Path $p)) { continue }
    $files = Get-ChildItem -Path $p -Filter '*.cs' -Recurse -ErrorAction SilentlyContinue
    $count = 0
    foreach ($f in $files) {
        $lines = Get-Content -LiteralPath $f.FullName -ErrorAction SilentlyContinue
        foreach ($ln in $lines) {
            if ($ln -match '^\s*\[(Fact|Theory)(\(|\])') { $count++ }
        }
    }
    Write-Output ("{0} : {1}" -f $t, $count)
}

Write-Output '---'
Get-ChildItem -Path tests -Filter '*TestCountCeilingTests.cs' -Recurse | ForEach-Object {
    $name = $_.Directory.Name
    $content = Get-Content -LiteralPath $_.FullName -Raw
    $rx = [regex]'Ceiling\s*=\s*(\d+)'
    $m = $rx.Match($content)
    if ($m.Success) {
        Write-Output ("Ceiling {0}: {1}" -f $name, $m.Groups[1].Value)
    } else {
        Write-Output ("Ceiling {0}: not-parsed" -f $name)
    }
}