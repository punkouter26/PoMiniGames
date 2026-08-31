#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Run one img2threejs build pass end-to-end: generate -> transpile -> fix texture
    paths -> render (shaded + map-stripped) -> comparison sheet.

.PARAMETER PassId
    One of: blockout, structural-pass, form-refinement, material-pass,
    surface-pass, lighting-pass, interaction-pass, optimization-pass.

.PARAMETER Port
    Local HTTP port for the render harness (use a fresh port if a stale server
    is suspected).
#>
param(
    [Parameter(Mandatory = $true)][string]$PassId,
    [int]$Port = 4731
)
$ErrorActionPreference = "Stop"
$root = "C:\Users\punko\Downloads\pominigames"

Set-Location "$root\tools\img2threejs"

Write-Host "==> 1. patch spec"
py "$root\.img2threejs\patch_spec.py"
if ($LASTEXITCODE -ne 0) { throw "patch_spec failed" }

Write-Host "==> 2. generate TS factory ($PassId)"
py forge\stage3_build\generate_threejs_factory.py `
    "$root\.img2threejs\object-sculpt-spec.json" `
    --out "$root\.img2threejs\createObjectModel.ts" `
    --pass-id $PassId --force
if ($LASTEXITCODE -ne 0) { throw "generate_threejs_factory failed" }

Write-Host "==> 3. transpile TS -> JS"
Set-Location "$root\.img2threejs"
npx tsc -p tsconfig.json
if ($LASTEXITCODE -ne 0) { throw "tsc failed" }

Write-Host "==> 4. rewrite texture paths to absolute API URLs"
# tsc emits the embedded Windows path with ESCAPED backslashes; replace that form.
$jsPath = "$root\src\PoMiniGames.Client\wwwroot\games\pogallery\models\chair\createObjectModel.js"
$content = Get-Content $jsPath -Raw
$content = $content.Replace(
    'C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted',
    'http://localhost:5080/games/pogallery/models/chair/pbr')
Set-Content $jsPath -Value $content -NoNewline -Encoding UTF8

Write-Host "==> 5. render shaded"
Set-Location $root
py tools\img2threejs-render\render.py `
    src\PoMiniGames.Client\wwwroot\games\pogallery\models\chair\index.js `
    .img2threejs\render-$PassId.png `
    "distance=3.2&azimuth=35&elevation=-12&bg=%23ffffff" --port $Port
if ($LASTEXITCODE -ne 0) { throw "shaded render failed" }

Write-Host "==> 6. render map-stripped"
# map-stripped.js imports ./createObjectModel.js, so it must live beside the factory
# and is regenerated implicitly by step 3. It flattens all materials to unlit grey.
py tools\img2threejs-render\render.py `
    src\PoMiniGames.Client\wwwroot\games\pogallery\models\chair\map-stripped.js `
    .img2threejs\mapstripped-$PassId.png `
    "distance=3.2&azimuth=35&elevation=-12&bg=%23ffffff" --port ($Port + 1)
if ($LASTEXITCODE -ne 0) { throw "map-stripped render failed" }

Write-Host "==> 7. comparison sheet"
Set-Location "$root\tools\img2threejs"
py forge\stage4_review\make_comparison_sheet.py `
    --reference "$root\src\PoMiniGames.Client\wwwroot\games\pogallery\refs\chair.png" `
    --render "$root\.img2threejs\render-$PassId.png" `
    --out "$root\.img2threejs\comparison-$PassId.png" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "comparison sheet failed" }

Write-Host "==> pass $PassId artifacts ready:"
Write-Host "    .img2threejs\render-$PassId.png"
Write-Host "    .img2threejs\mapstripped-$PassId.png"
Write-Host "    .img2threejs\comparison-$PassId.png"
