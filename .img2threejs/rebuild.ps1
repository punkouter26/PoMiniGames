#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Full regeneration chain for the PoGallery chair model.

    1. Patch the spec with chair-specific content (.img2threejs/patch_spec.py)
    2. Generate the TS factory (forge/stage3_build/generate_threejs_factory.py)
    3. Transpile TS -> JS (npx tsc)
    4. Rewrite absolute Windows texture paths to relative URLs served by the API host
    5. Copy placeholder PBR textures into wwwroot

    Steps 3 and 4 must always run in this order: tsc overwrites createObjectModel.js
    from the TS source, which still carries the absolute paths the spec was authored
    with. Forgetting step 4 is why the model rendered as a black silhouette (the
    browser refuses file:/// texture URLs, so every material sampled black).
#>
$ErrorActionPreference = "Stop"
$root = "C:\Users\punko\Downloads\pominigames"

Set-Location "$root\tools\img2threejs"

Write-Host "==> 1. patch spec"
py "$root\.img2threejs\patch_spec.py"
if ($LASTEXITCODE -ne 0) { throw "patch_spec failed" }

Write-Host "==> 2. generate TS factory (blockout)"
py forge\stage3_build\generate_threejs_factory.py `
    "$root\.img2threejs\object-sculpt-spec.json" `
    --out "$root\.img2threejs\createObjectModel.ts" `
    --pass-id blockout --force
if ($LASTEXITCODE -ne 0) { throw "generate_threejs_factory failed" }

Write-Host "==> 3. transpile TS -> JS"
Set-Location "$root\.img2threejs"
npx tsc -p tsconfig.json
if ($LASTEXITCODE -ne 0) { throw "tsc failed" }

Write-Host "==> 4. rewrite texture paths to absolute API URLs"
# The TS source embeds the Windows path, and tsc emits it as a JS string literal
# with ESCAPED backslashes (C:\\Users\\...). The replace must use the escaped form.
# The URL must be ABSOLUTE against the API origin (http://localhost:5080) because
# the render harness serves the workspace root, where /games/... does not exist.
$jsPath = "$root\src\PoMiniGames.Client\wwwroot\games\pogallery\models\chair\createObjectModel.js"
$content = Get-Content $jsPath -Raw
$content = $content.Replace(
    'C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted',
    'http://localhost:5080/games/pogallery/models/chair/pbr')
Set-Content $jsPath -Value $content -NoNewline -Encoding UTF8

Write-Host "==> 5. ensure placeholder PBR textures are in wwwroot"
$src = "$root\.img2threejs\pbr-extracted"
$dst = "$root\src\PoMiniGames.Client\wwwroot\games\pogallery\models\chair\pbr"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item "$src\*" $dst -Force

Write-Host "==> done"
