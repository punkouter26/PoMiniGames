#!/usr/bin/env pwsh
<#
.SYNOPSIS
  One-time PoSports asset pipeline: shrink the raw spritesheet drop (~175 MB) into
  the committed runtime layout (~7 MB).
.DESCRIPTION
  The raw export under wwwroot/images/PoSports/ ships each animation three ways:
  a spritesheet.png, an atlas.json, and a frames/ directory holding every frame as
  its own PNG. The frames/ copies are 136 MB of pure redundancy, and the 512 px
  sheets are 2x the size the game ever renders (~150-200 px on screen).

  This script, per animation set:
    1. Deletes the frames/ directory (redundant with the sheet).
    2. Downscales 512 px sheets to 256 px (halves the PNG and every atlas x/y/w/h).
       Nick is already 256 px and is left untouched.
    3. Moves the set into the runtime layout the JS engine loads:
         images/PoSports/{dad|mom|kim|matt|nick|tong}/{idle|walk|run|jump|punch|kick|hitreact|dance}/
  It is idempotent: once a set is in the runtime layout at 256 px, re-running is a no-op.

  DESTRUCTIVE: the source files are untracked, so deletion is unrecoverable.
  Run with -DryRun first to see the plan; the real run requires -Force.
.PARAMETER DryRun
  Print what would happen; touch nothing.
.PARAMETER Force
  Required for the destructive run. (Named -Force because -Confirm is a PowerShell common parameter.)
#>

param(
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$root = Join-Path $repoRoot 'src/PoMiniGames.Client/wwwroot/images/PoSports'
if (-not (Test-Path $root)) { Write-Error "Asset root not found: $root" }

if (-not $DryRun -and -not $Force) {
    Write-Error 'Destructive run requires -Force (or use -DryRun to preview).'
}

# Raw-export dir name -> runtime key
$charMap = @{
    'Dad-spritesheet'  = 'dad'
    'Mom-spritesheet'  = 'mom'
    'Kim-spritesheet'  = 'kim'
    'Matt-spritesheet' = 'matt'
    'Nick-spritesheet' = 'nick'
    'Tong-spritesheet' = 'tong'
}
$animMap = @{
    'idle_right'  = 'idle'
    'walk_right'  = 'walk'
    'run_right'   = 'run'
    'jump_right'  = 'jump'
    'Punch'       = 'punch'
    'Kick'        = 'kick'
    'Hit React'   = 'hitreact'
    'Happy Dance' = 'dance'
}

function Get-DirSizeMB([string]$path) {
    if (-not (Test-Path $path)) { return 0 }
    $b = (Get-ChildItem $path -Recurse -File | Measure-Object Length -Sum).Sum
    [math]::Round($b / 1MB, 1)
}

$beforeMB = Get-DirSizeMB $root
Write-Host "PoSports assets: $beforeMB MB before" -ForegroundColor Cyan

$deletedFrames = 0; $downscaled = 0; $moved = 0; $skipped = 0

foreach ($rawChar in $charMap.Keys) {
    $srcChar = Join-Path $root $rawChar
    if (-not (Test-Path $srcChar)) { continue }
    $dstChar = Join-Path $root $charMap[$rawChar]

    foreach ($rawAnim in $animMap.Keys) {
        $srcAnim = Join-Path $srcChar $rawAnim
        if (-not (Test-Path $srcAnim)) { continue }
        $dstAnim = Join-Path $dstChar $animMap[$rawAnim]

        # 1. frames/ is redundant with the sheet — delete.
        $frames = Join-Path $srcAnim 'frames'
        if (Test-Path $frames) {
            if ($DryRun) { Write-Host "  [dry] delete $frames" }
            else { Remove-Item $frames -Recurse -Force }
            $deletedFrames++
        }

        $png  = Join-Path $srcAnim 'spritesheet.png'
        $json = Join-Path $srcAnim 'atlas.json'
        if (-not (Test-Path $png) -or -not (Test-Path $json)) {
            Write-Warning "incomplete set, skipping: $srcAnim"; $skipped++; continue
        }

        $atlas = Get-Content $json -Raw | ConvertFrom-Json
        $firstFrame = $atlas.frames.PSObject.Properties.Value | Select-Object -First 1

        # 2. 512 px frames -> halve sheet + atlas. 256 px sets pass through.
        if ($firstFrame.w -gt 256) {
            if ($DryRun) { Write-Host "  [dry] downscale $png ($($firstFrame.w)px -> $($firstFrame.w/2)px)" }
            else {
                $img = [System.Drawing.Image]::FromFile($png)
                try {
                    $nw = [int]($img.Width / 2); $nh = [int]($img.Height / 2)
                    $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
                    $g = [System.Drawing.Graphics]::FromImage($bmp)
                    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $g.DrawImage($img, 0, 0, $nw, $nh)
                    $g.Dispose()
                } finally { $img.Dispose() }
                $tmp = "$png.tmp"
                $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
                $bmp.Dispose()
                Move-Item $tmp $png -Force

                foreach ($p in $atlas.frames.PSObject.Properties) {
                    $f = $p.Value
                    $f.x = [int]($f.x / 2); $f.y = [int]($f.y / 2)
                    $f.w = [int]($f.w / 2); $f.h = [int]($f.h / 2)
                }
                if ($atlas.meta -and $atlas.meta.size) {
                    $atlas.meta.size.w = [int]($atlas.meta.size.w / 2)
                    $atlas.meta.size.h = [int]($atlas.meta.size.h / 2)
                }
                $atlas | ConvertTo-Json -Depth 10 | Set-Content $json -Encoding utf8
            }
            $downscaled++
        }

        # 3. Move into runtime layout.
        if ($DryRun) { Write-Host "  [dry] move  $srcAnim -> $dstAnim" }
        else {
            New-Item -ItemType Directory -Force (Split-Path $dstAnim) | Out-Null
            Move-Item $srcAnim $dstAnim -Force
        }
        $moved++
    }

    # Remove the emptied raw char dir.
    if (-not $DryRun -and (Test-Path $srcChar) -and -not (Get-ChildItem $srcChar)) {
        Remove-Item $srcChar -Force
    }
}

# 4. Palette-quantize every sheet (256 colors). GDI+ writes unoptimized 32bpp PNGs
#    (~2 MB per sheet even at 256 px); Pillow's FASTOCTREE quantize + optimize gets
#    ~11x smaller with no visible loss at the ~150-200 px render size. Idempotent:
#    mode-P sheets are skipped.
if (-not $DryRun) {
    $py = @'
from PIL import Image
import glob, os
tb = ta = 0
for p in glob.glob("*/*/spritesheet.png"):
    b = os.path.getsize(p)
    img = Image.open(p)
    if img.mode == "P":
        tb += b; ta += b; continue
    tmp = p + ".tmp.png"
    img.quantize(colors=256, method=Image.Quantize.FASTOCTREE).save(tmp, optimize=True)
    a = os.path.getsize(tmp)
    if a < b: os.replace(tmp, p)
    else: os.remove(tmp); a = b
    tb += b; ta += a
print(f"quantize: {tb//1048576} MB -> {ta//1048576} MB")
'@
    Push-Location $root
    try { $py | python - } finally { Pop-Location }
}

$afterMB = if ($DryRun) { '(dry run)' } else { "$(Get-DirSizeMB $root) MB" }
Write-Host ""
Write-Host "frames/ deleted: $deletedFrames · sheets downscaled: $downscaled · sets moved: $moved · skipped: $skipped" -ForegroundColor Cyan
Write-Host "After: $afterMB (was $beforeMB MB)" -ForegroundColor Green
if (-not $DryRun) {
    # Sanity ceiling — the whole point of this pipeline.
    $final = Get-DirSizeMB $root
    if ($final -gt 12) { Write-Error "Post-run size $final MB exceeds the 12 MB ceiling — investigate before committing." }
}
