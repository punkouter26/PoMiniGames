#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Dry-run scan of PoShared candidate orphan resources.
  Outputs a go/no-go matrix and, for GO resources, safe deletion commands.
  Does NOT delete anything.
#>

$SUB = "bbb8dfbe-9169-432f-9b7a-fbf861b51037"
$RG  = "PoShared"
$DAYS = 90
$since = (Get-Date).AddDays(-$DAYS).ToString("yyyy-MM-ddTHH:mm:ssZ")

# ── Candidate resources ───────────────────────────────────────────────────────
$candidates = @(
  [pscustomobject]@{
    Name     = "pofoundrytest-resource"
    Type     = "CognitiveServices/accounts"
    Provider = "Microsoft.CognitiveServices"
    ResType  = "accounts"
    DeleteCmd = "az cognitiveservices account delete -g $RG -n pofoundrytest-resource --yes"
  }
  [pscustomobject]@{
    Name     = "mi-poshared-containerapps"
    Type     = "ManagedIdentity"
    Provider = "Microsoft.ManagedIdentity"
    ResType  = "userAssignedIdentities"
    DeleteCmd = "az identity delete -g $RG -n mi-poshared-containerapps"
  }
  [pscustomobject]@{
    Name     = "mi-pohappytrump-github"
    Type     = "ManagedIdentity"
    Provider = "Microsoft.ManagedIdentity"
    ResType  = "userAssignedIdentities"
    DeleteCmd = "az identity delete -g $RG -n mi-pohappytrump-github"
  }
  [pscustomobject]@{
    Name     = "maps-potraffic"
    Type     = "Maps/accounts"
    Provider = "Microsoft.Maps"
    ResType  = "accounts"
    DeleteCmd = "az maps account delete -g $RG -n maps-potraffic --yes"
  }
  [pscustomobject]@{
    Name     = "cv-poshared-eastus"
    Type     = "CognitiveServices/accounts"
    Provider = "Microsoft.CognitiveServices"
    ResType  = "accounts"
    DeleteCmd = "az cognitiveservices account delete -g $RG -n cv-poshared-eastus --yes"
  }
  [pscustomobject]@{
    Name     = "speech-poshared-eastus"
    Type     = "CognitiveServices/accounts"
    Provider = "Microsoft.CognitiveServices"
    ResType  = "accounts"
    DeleteCmd = "az cognitiveservices account delete -g $RG -n speech-poshared-eastus --yes"
  }
  [pscustomobject]@{
    Name     = "language-poshared-eastus"
    Type     = "CognitiveServices/accounts"
    Provider = "Microsoft.CognitiveServices"
    ResType  = "accounts"
    DeleteCmd = "az cognitiveservices account delete -g $RG -n language-poshared-eastus --yes"
  }
  [pscustomobject]@{
    Name     = "openai-poshared-eastus"
    Type     = "CognitiveServices/accounts"
    Provider = "Microsoft.CognitiveServices"
    ResType  = "accounts"
    DeleteCmd = "az cognitiveservices account delete -g $RG -n openai-poshared-eastus --yes"
  }
  [pscustomobject]@{
    Name     = "pofaceapi"
    Type     = "CognitiveServices/accounts"
    Provider = "Microsoft.CognitiveServices"
    ResType  = "accounts"
    DeleteCmd = "az cognitiveservices account delete -g $RG -n pofaceapi --yes"
  }
)

# ── Pre-load all web app settings once ───────────────────────────────────────
Write-Host "`n[1/4] Loading all web app settings..." -ForegroundColor Cyan
$allApps = az webapp list --subscription $SUB --query "[].{name:name,rg:resourceGroup}" -o json 2>$null | ConvertFrom-Json
$appSettings = @{}
foreach ($app in $allApps) {
  $settings = az webapp config appsettings list --subscription $SUB -g $app.rg -n $app.name `
    --query "[].value" -o json 2>$null | ConvertFrom-Json
  if ($settings) {
    $appSettings[$app.name] = $settings -join " "
  }
}
Write-Host "  Loaded settings for $($appSettings.Count) apps." -ForegroundColor Gray

# ── Pre-load managed identity assignments ─────────────────────────────────────
Write-Host "[2/4] Loading managed identity assignments for all web apps..." -ForegroundColor Cyan
$miAssignments = @{}
foreach ($app in $allApps) {
  $identity = az webapp identity show --subscription $SUB -g $app.rg -n $app.name `
    --query "userAssignedIdentities" -o json 2>$null | ConvertFrom-Json
  if ($identity) {
    $miAssignments[$app.name] = ($identity | ConvertTo-Json -Compress)
  }
}
Write-Host "  Loaded MI assignments for $($miAssignments.Count) apps." -ForegroundColor Gray

# ── Activity log helper ────────────────────────────────────────────────────────
function Get-ActivityCount($resourceId) {
  $raw = az monitor activity-log list --subscription $SUB `
    --resource-id $resourceId `
    --start-time $since `
    -o json 2>$null
  if ([string]::IsNullOrWhiteSpace($raw)) { return 0 }
  $parsed = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
  if ($null -eq $parsed) { return 0 }
  return ($parsed | Measure-Object).Count
}

# ── RBAC helper ───────────────────────────────────────────────────────────────
function Get-RoleAssignmentCount($resourceId) {
  $raw = az role assignment list --subscription $SUB --scope $resourceId `
    --include-inherited false -o json 2>$null
  if ([string]::IsNullOrWhiteSpace($raw)) { return 0 }
  $parsed = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
  if ($null -eq $parsed) { return 0 }
  return ($parsed | Measure-Object).Count
}

# ── App-settings reference check ─────────────────────────────────────────────
function Get-AppSettingHits($resourceName) {
  $hits = @()
  foreach ($appName in $appSettings.Keys) {
    if ($appSettings[$appName] -like "*$resourceName*") {
      $hits += $appName
    }
  }
  return $hits
}

# ── MI assignment check ───────────────────────────────────────────────────────
function Get-MiAssignmentHits($resourceId) {
  $hits = @()
  foreach ($appName in $miAssignments.Keys) {
    if ($miAssignments[$appName] -like "*$resourceId*") {
      $hits += $appName
    }
  }
  return $hits
}

# ── Main scan loop ────────────────────────────────────────────────────────────
Write-Host "[3/4] Scanning each candidate resource..." -ForegroundColor Cyan
$matrix = @()

foreach ($c in $candidates) {
  $resId = "/subscriptions/$SUB/resourceGroups/$RG/providers/$($c.Provider)/$($c.ResType)/$($c.Name)"
  Write-Host "  -> $($c.Name)" -ForegroundColor Gray -NoNewline

  $activityCount = Get-ActivityCount $resId
  $roleCount     = Get-RoleAssignmentCount $resId
  $appHits       = Get-AppSettingHits $c.Name
  $miHits        = @()
  if ($c.Type -eq "ManagedIdentity") {
    $miHits = Get-MiAssignmentHits $resId
  }

  $referenceHits = ($appHits + $miHits) | Select-Object -Unique
  $refCount      = ($referenceHits | Measure-Object).Count

  # ── Decision logic ─────────────────────────────────────────────────────────
  $blockers = @()
  if ($activityCount -gt 0) { $blockers += "Activity($activityCount ops in ${DAYS}d)" }
  if ($roleCount -gt 0)      { $blockers += "RBAC($roleCount assignments)" }
  if ($refCount -gt 0)       { $blockers += "AppRef($($referenceHits -join ','))" }

  $decision = if ($blockers.Count -eq 0) { "GO" } else { "NO-GO" }
  $color = if ($decision -eq "GO") { "Green" } else { "Yellow" }
  Write-Host "  [$decision]" -ForegroundColor $color

  $matrix += [pscustomobject]@{
    Resource    = $c.Name
    Type        = $c.Type
    Decision    = $decision
    Activity90d = $activityCount
    RBACRoles   = $roleCount
    AppRefs     = ($referenceHits -join ", ")
    Blockers    = ($blockers -join " | ")
    DeleteCmd   = if ($decision -eq "GO") { $c.DeleteCmd } else { "-- BLOCKED --" }
  }
}

# ── Report ─────────────────────────────────────────────────────────────────────
Write-Host "`n[4/4] GO/NO-GO MATRIX" -ForegroundColor Cyan
Write-Host ("=" * 100)
$matrix | Format-Table Resource, Type, Decision, Activity90d, RBACRoles, AppRefs, Blockers -AutoSize -Wrap

$goItems = $matrix | Where-Object { $_.Decision -eq "GO" }
$nogoItems = $matrix | Where-Object { $_.Decision -eq "NO-GO" }

Write-Host "`nSUMMARY" -ForegroundColor Cyan
Write-Host "  GO    : $($goItems.Count) resource(s) safe to delete"
Write-Host "  NO-GO : $($nogoItems.Count) resource(s) blocked"

if ($goItems.Count -gt 0) {
  Write-Host "`n── SAFE DELETION COMMANDS (review before running) ──" -ForegroundColor Green
  foreach ($item in $goItems) {
    Write-Host "  $($item.DeleteCmd)" -ForegroundColor White
  }
  Write-Host "`nTo run all GO deletions at once, pipe through Invoke-Expression (at your own risk)."
}

if ($nogoItems.Count -gt 0) {
  Write-Host "`n── BLOCKED RESOURCES ──" -ForegroundColor Yellow
  foreach ($item in $nogoItems) {
    Write-Host "  $($item.Resource) :: $($item.Blockers)" -ForegroundColor Yellow
  }
}

Write-Host "`nDone. No resources were modified." -ForegroundColor Cyan
