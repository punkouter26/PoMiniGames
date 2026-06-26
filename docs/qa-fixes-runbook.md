# PoMiniGames QA Fixes — Runbook for External-Service Items

This document captures the four fixes that require external Azure resources or
CI plumbing. Each section is a complete, copy-pasteable runbook. Run them in
the order listed; they are sequenced by blast radius.

> **Status of the six fixes that landed in this PR**
>
> | # | Fix | File(s) | Status |
> |---|---|---|---|
> | 1 | `POST /api/statistics` handler | `Features/Leaderboard/PlayerStatsEndpoints.cs` | ✅ shipped |
> | 2 | `GET /api/pocouplequiz/teams/{name}/stats` + leaderboard | `Features/PoCoupleQuiz/CoupleQuizEndpoints.cs` | ✅ shipped |
> | 6 | `Auth:AutoGuestLogin: true` in dev | `appsettings.Development.json` | ✅ shipped |
> | 7 | Demo button is a toggle (Start ↔ Stop) | `Pages/Index.razor` | ✅ shipped |
> | 8 | `/diag` secret masking | `Pages/DiagPage.razor` | ✅ shipped |
> | 9 | SVG favicon, OG image, PWA manifest | `wwwroot/{favicon,og-image,manifest}.{svg,webmanifest}` + `index.html` | ✅ shipped |
> | (bonus) | `TeamsRepository.SaveTeamAsync` UTC stamp | `Features/PoCoupleQuiz/Storage/TeamsRepository.cs` | ✅ shipped |
>
> The four remaining items (3, 4, 5, 10) need Azure access / CI plumbing and
> are documented below.

---

## #3 — Microsoft OAuth wired to Key Vault

**Goal:** make `/api/auth/config` return `microsoftEnabled: true` in Production
and read the real `ClientId` / `ApiClientId` from the `PoShared` Key Vault.

**Pre-reqs**
- `az login` and Contributor on the `PoShared` resource group.
- App registration in Entra ID (multi-tenant `common` or `consumers`).
- Redirect URI: `https://<app-service>.azurewebsites.net/auth/callback`.

**Steps**

1. Create the app registration:
   ```bash
   az ad app create --display-name "PoMiniGames" \
     --sign-in-audience AzureADandPersonalMicrosoftAccount \
     --web-redirect-uris "https://<app-service>.azurewebsites.net/auth/callback"
   ```
   Capture `APP_ID` (the Application / Client ID) and `TENANT_ID` (the
   "common" authority maps to `https://login.microsoftonline.com/common/v2.0`).

2. Generate a client secret (24 months) and store it in Key Vault:
   ```bash
   az ad app credential reset --id "$APP_ID" --display-name pominigames
   SECRET=$(az ad app credential list --id "$APP_ID" --query "[0].secretText" -o tsv)
   az keyvault secret set --vault-name kv-poshared --name "PoMiniGames--MicrosoftAuth--ApiClientSecret" --value "$SECRET"
   ```

3. Store the client id in Key Vault as well:
   ```bash
   az keyvault secret set --vault-name kv-poshared --name "PoMiniGames--MicrosoftAuth--ClientId" --value "$APP_ID"
   az keyvault secret set --vault-name kv-poshared --name "PoMiniGames--MicrosoftAuth--ApiClientId" --value "$APP_ID"
   ```

4. Add an explicit production guard in `Program.cs` next to the existing
   `FakeAuth` guard:
   ```csharp
   if (app.Environment.IsProduction() && !microsoftAuth.Enabled)
   {
       throw new InvalidOperationException(
           "Microsoft OAuth is not configured in Production. " +
           "Set PoMiniGames:MicrosoftAuth:ClientId/ApiClientId in Key Vault.");
   }
   ```

5. Verify:
   ```bash
   curl -s https://<app-service>.azurewebsites.net/api/auth/config
   # → "microsoftEnabled": true, "clientId": "<APP_ID>"
   ```

---

## #4 — Application Insights + Key Vault integration in dev

**Goal:** `UseAzureMonitor()` activates when the connection string is present
(in dev too, not only Production), and `KeyVault:Uri` reads from
`appsettings.Development.json` when the user has access.

**Pre-reqs**
- App Insights resource in the `PoShared` RG.
- `az login` and Reader on the resource.

**Steps**

1. Get the connection string:
   ```bash
   AI_CONN=$(az monitor app-insights component show \
     --app pominigames-insights --resource-group PoShared \
     --query connectionString -o tsv)
   ```

2. Store it in Key Vault (preferred) or in `appsettings.Development.json`:
   ```bash
   az keyvault secret set --vault-name kv-poshared \
     --name "PoMiniGames--ApplicationInsights--ConnectionString" --value "$AI_CONN"
   ```

3. Verify `infra/main.bicep` exposes both the connection string and the
   Key Vault URI to the App Service via environment variables:
   ```bicep
   env: [
     { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'; secretRef: 'appInsightsConn' }
     { name: 'KeyVault__Uri'; value: 'https://kv-poshared.vault.azure.net/' }
   ]
   ```

4. In `Program.cs`, ensure the connection string is wired even when running
   locally with `IsDevelopment()`:
   ```csharp
   if (!string.IsNullOrEmpty(builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"]))
   {
       builder.Services.AddAzureMonitor();
   }
   ```

5. Confirm telemetry is flowing:
   ```bash
   az monitor app-insights component show --app pominigames-insights \
     --resource-group PoShared --query "instrumentationKey"
   # Then in the portal: Live Metrics should show the local process within 5s.
   ```

---

## #5 — `/profile` long-scroll: sticky filter + persistence + back-to-top

**Goal:** the 2988-pixel `/profile` page becomes navigable on mobile: sticky
filter bar, sessionStorage-persisted filter, "back to top" FAB.

**Files**
- `src/PoMiniGames.Client/Pages/ProfilePage.razor`
- `src/PoMiniGames.Client/wwwroot/css/profile.css` (or `app.css`)

**Steps**

1. Wrap the filter row in a `position: sticky; top: 0` container so it stays
   in view while the user scrolls:
   ```razor
   <section class="profile-filters" style="position:sticky;top:0;z-index:5;backdrop-filter:blur(12px)">
     <!-- existing filter buttons -->
   </section>
   ```

2. Persist the active filter to `sessionStorage`:
   ```razor
   @inject IJSRuntime JS
   private string _activeFilter = "all";
   protected override async Task OnAfterRenderAsync(bool firstRender) {
     if (firstRender) {
       _activeFilter = await JS.InvokeAsync<string>("sessionStorage.getItem", "profile.filter") ?? "all";
       StateHasChanged();
     }
   }
   private async Task SetFilter(string f) {
     _activeFilter = f;
     await JS.InvokeVoidAsync("sessionStorage.setItem", "profile.filter", f);
   }
   ```

3. Add a back-to-top FAB fixed to the bottom-right that only appears when
   the user has scrolled past 600px:
   ```razor
   <button class="profile-fab" @onclick="ScrollTop" hidden="@(!_showFab)">↑</button>
   ```
   ```css
   .profile-fab { position: fixed; right: 1rem; bottom: 1rem; width: 44px; height: 44px; border-radius: 50%; background: var(--accent); color: white; }
   ```

4. Verify at 375px width:
   - Filter bar stays visible during scroll.
   - Reload preserves the filter.
   - FAB appears after scrolling 600px and dismisses back to top.

---

## #10 — E2E-UI gate in CI

**Goal:** `tests/E2EUI` runs on every PR and fails the build on
any client-side console error, any 4xx/5xx, or any DOM overflow.

**Pre-reqs**
- A working `dotnet run` (or `dotnet publish` + run) of the API project.
- The Playwright `chromium` browser installed (`npx playwright install`).

**Steps**

1. Add a `pwsh` smoke step that the existing `tests/E2EUI` project
   can call:
   ```yaml
   # azure-pipelines.yml
   - task: PowerShell@2
     displayName: "E2E UI smoke"
     inputs:
       targetType: filePath
       filePath: $(Build.SourcesDirectory)/scripts/smoke-local.ps1
   - task: DotNetCoreCLI@2
     displayName: "E2E UI tests"
     inputs:
       command: test
       projects: tests/E2EUI/E2EUI.csproj
       arguments: --logger "console;verbosity=detailed"
   ```

2. Add a "no console errors" assertion to the test fixture. Use Playwright's
   `page.on('pageerror', …)` and `page.on('console', …)` to collect errors and
   fail the test if the count is non-zero after navigating the home page, a
   single-player game, and the `/profile` page.

3. Optional: add a screenshot-on-failure step so PR reviews show what the
   browser saw:
   ```csharp
   await page.ScreenshotAsync(new PageScreenshotOptions { Path = $"artifacts/{TestContext.CurrentContext.Test.Name}.png", FullPage = true });
   ```

4. Verify locally:
   ```bash
   dotnet test tests/E2EUI/E2EUI.csproj
   ```

> **E2E tests are NOT run in CI** (per repo UPDATES). This gate is for a
> future PR-flow integration only; the current `.github/workflows/deploy.yml`
> stays build-only.
