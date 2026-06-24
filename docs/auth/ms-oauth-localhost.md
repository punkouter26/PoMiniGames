# Microsoft OAuth (Localhost Dev) — Setup Reference

Single-tenant Entra app registration wired to `http://localhost:5000` so the
PoMiniGames client + API can complete a real sign-in round-trip during
development.

> **Status (2026-06-23):** Created via `az ad app create`, all 3 redirect URIs
> registered, `access_as_user` scope exposed, 2-year client secret rotated,
> user-secrets wired into the API project.

---

## App registration

| Field | Value |
|---|---|
| Display name | `PoMiniGames-Localhost` |
| App ID (Client ID) | `195ac6ba-cd1a-48bf-900d-df7715cc921a` |
| Object ID | `90e5af97-86aa-4f8a-aa40-1bc52637678c` |
| Sign-in audience | `AzureADandPersonalMicrosoftAccount` (multitenant + personal) |
| Web redirect URIs | `http://localhost:5000/auth/callback`, `http://localhost:5000`, `http://localhost:5000/signin-oidc` |
| ID token issuance | enabled |
| Scope | `access_as_user` (user-consent, enabled) |

> **No client secret is used by this app.** The Blazor WASM client signs in via
> MSAL as a *public client* (PKCE), and the API validates the resulting JWT. There
> is no confidential-client / authorization-code-with-secret flow, so
> `MicrosoftAuthOptions` has no `ClientSecret` property. **Never put a client secret
> in this repo, appsettings, or this doc** — secret scanning will (correctly) block
> the push. If a future feature needs one, store it per the
> [Secrets & configuration](#secrets--configuration) section below, never inline.

---

## `dotnet user-secrets` (already wired)

These are non-secret public identifiers (a Client ID is not a secret), kept in
user-secrets purely so they don't ship in the committed `appsettings.json`:

```text
PoMiniGames:MicrosoftAuth:Authority     = https://login.microsoftonline.com/common/v2.0
PoMiniGames:MicrosoftAuth:RedirectPath  = /auth/callback
PoMiniGames:MicrosoftAuth:Scope         = api://195ac6ba-cd1a-48bf-900d-df7715cc921a/access_as_user
PoMiniGames:MicrosoftAuth:ClientId      = 195ac6ba-cd1a-48bf-900d-df7715cc921a
PoMiniGames:MicrosoftAuth:ApiClientId   = 195ac6ba-cd1a-48bf-900d-df7715cc921a
```

> Inspect with:
> ```bash
> dotnet user-secrets list --project src/PoMiniGames/PoMiniGames/PoMiniGames.csproj
> ```

---

## Secrets & configuration

The app reads every real secret from configuration providers, **never from
committed files**. Resolution order (last wins): `appsettings.json` →
`appsettings.{Env}.json` → user-secrets (dev) / Azure Key Vault (cloud) →
environment variables / App Service application settings.

**Actual secrets consumed by the app** (these are the only values that must be
protected — the Microsoft IDs above are public):

| Config key | What it is |
|---|---|
| `PoMiniGames:Storage:TableService:ConnectionString` / `PoSurvive-TableStorageConnectionString` | Azure Table Storage connection string |
| `PoFunQuiz:AzureOpenAI:ApiKey` | Azure OpenAI key (PoFunQuiz) |
| `PoCoupleQuiz:AzureOpenAI:ApiKey` | Azure OpenAI key (PoCoupleQuiz) |
| `PoFace:AzureOpenAI:ApiKey` | Azure OpenAI / Face key (PoFace) |
| `Inference:ApiKey` | Azure OpenAI key (PoSurvive relay) |
| `PoMiniGames:ApplicationInsights:ConnectionString` / `AppInsights-ConnectionString` | App Insights connection string |

### Dev environment

Local secrets go in **user-secrets** (never in `appsettings.Development.json`):

```bash
P=src/PoMiniGames/PoMiniGames/PoMiniGames.csproj
dotnet user-secrets set "PoFunQuiz:AzureOpenAI:ApiKey"   "<key>"   --project $P
dotnet user-secrets set "PoCoupleQuiz:AzureOpenAI:ApiKey" "<key>"  --project $P
dotnet user-secrets set "PoFace:AzureOpenAI:ApiKey"      "<key>"   --project $P
dotnet user-secrets set "Inference:ApiKey"               "<key>"   --project $P
```

A shared **dev Key Vault** can be used instead by setting `PoMiniGames:KeyVault:Uri`
(or `KeyVault:Uri`) — secrets named `PoMiniGames--<Section>--<Key>` are loaded and
`--` is mapped to `:` (see `PrefixKeyVaultSecretManager` in `Program.cs`).

### Prod environment

Store every secret in **Key Vault** and let the App Service reach it via its
**managed identity** + the `PoMiniGames:KeyVault:Uri` application setting:

```bash
VAULT=<your-keyvault-name>
# '--' in the secret name becomes ':' in config (PrefixKeyVaultSecretManager)
az keyvault secret set --vault-name $VAULT --name "PoMiniGames--PoFunQuiz--AzureOpenAI--ApiKey"    --value "<key>"
az keyvault secret set --vault-name $VAULT --name "PoMiniGames--PoCoupleQuiz--AzureOpenAI--ApiKey" --value "<key>"
az keyvault secret set --vault-name $VAULT --name "PoMiniGames--PoFace--AzureOpenAI--ApiKey"       --value "<key>"
az keyvault secret set --vault-name $VAULT --name "PoMiniGames--Inference--ApiKey"                 --value "<key>"
az keyvault secret set --vault-name $VAULT --name "PoMiniGames--Storage--TableService--ConnectionString" --value "<conn>"

# App Service: point the app at the vault (identity already granted 'get/list' on secrets)
az webapp config appsettings set -g <rg> -n <app> --settings \
  "PoMiniGames__KeyVault__Uri=https://$VAULT.vault.azure.net/"
```

> The `__` (double underscore) form is the env-var/App-Service spelling of the
> `:` config delimiter. Prefer Key Vault for the values above; reserve plain App
> Service application settings for non-secret config.

---

## How to recreate (if the app is ever deleted)

```bash
# 1. Create the app registration
APP=$(az ad app create \
  --display-name "PoMiniGames-Localhost" \
  --sign-in-audience AzureADandPersonalMicrosoftAccount \
  --web-redirect-uris "http://localhost:5000/auth/callback" \
                    "http://localhost:5000" \
                    "http://localhost:5000/signin-oidc" \
  --enable-id-token-issuance true \
  -o json | jq -r '.appId')

# 2. Generate a 2-year client secret
az ad app credential reset --id "$APP" --display-name pominigames-localhost

# 3. Expose the access_as_user scope
#    (use the manifest update shown in the "scope wiring" section below)

# 4. Wire into user-secrets
dotnet user-secrets set PoMiniGames:MicrosoftAuth:ClientId     "$APP" --project src/PoMiniGames/PoMiniGames/PoMiniGames.csproj
dotnet user-secrets set PoMiniGames:MicrosoftAuth:ApiClientId  "$APP" --project src/PoMiniGames/PoMiniGames/PoMiniGames.csproj
dotnet user-secrets set PoMiniGames:MicrosoftAuth:ClientSecret  "<paste secret>" --project src/PoMiniGames/PoMiniGames/PoMiniGames.csproj
dotnet user-secrets set PoMiniGames:MicrosoftAuth:Scope        "api://$APP/access_as_user" --project src/PoMiniGames/PoMiniGames/PoMiniGames.csproj
dotnet user-secrets set PoMiniGames:MicrosoftAuth:Authority    "https://login.microsoftonline.com/common/v2.0" --project src/PoMiniGames/PoMiniGames/PoMiniGames.csproj
dotnet user-secrets set PoMiniGames:MicrosoftAuth:RedirectPath "/auth/callback" --project src/PoMiniGames/PoMiniGames/PoMiniGames.csproj
```

---

## Scope wiring (manifest patch)

`az ad app update` does not have a flag for `oauth2PermissionScopes`, so use
`--set api=...`. Save the current api block, add the scope, and re-apply:

```bash
APP_OBJ_ID="90e5af97-86aa-4f8a-aa40-1bc52637678c"  # application object id, not appId
az ad app show --id "$APP_OBJ_ID" --query api -o json > api.json
# Edit api.json so oauth2PermissionScopes contains a single entry:
#   { "adminConsentDescription":"Allow the app to access PoMiniGames on behalf of the signed-in user",
#     "adminConsentDisplayName":"Access PoMiniGames",
#     "id":"<new-guid>",
#     "isEnabled":true,
#     "type":"User",
#     "userConsentDescription":"Allow the app to access PoMiniGames on your behalf",
#     "userConsentDisplayName":"Access PoMiniGames",
#     "value":"access_as_user" }
az ad app update --id "$APP_OBJ_ID" --set api=@api.json
```

---

## What the user sees at runtime

1. Open `http://localhost:5000/` → LoginScreen shows **two** buttons:
   - **Sign in with Microsoft** (active — real MSAL.js sign-in flow)
   - **Continue as Guest** (always available in dev)
2. Clicking Microsoft opens a popup at `https://login.microsoftonline.com/...`
   with the user completing OAuth against their personal / work account.
3. The MSAL response hits the SPA, which POSTs the bearer token to the API.
4. The API validates the JWT against `login.microsoftonline.com/common/v2.0`
   using the `ApiClientId` audience.

---

## Caveats

- **2-year secret expiry**: the client secret above expires 2028-06-23.
  Rotate via `az ad app credential reset --id <APP_OBJ_ID>` and re-set
  the `PoMiniGames:MicrosoftAuth:ClientSecret` user-secret.
- **No production deploy** — the redirect URIs are `http://localhost:5000`
  only. For a deployed environment, add the App Service URL as an additional
  redirect and store its client IDs in Key Vault (see
  [`docs/qa-fixes-runbook.md`](../qa-fixes-runbook.md) for the prod runbook).
- **Multitenant**: anyone with a Microsoft account (personal or work) can sign
  in. For single-tenant only, change `signInAudience` to
  `AzureADMyOrg` and add the tenant's homeTenantId to
  `PoMiniGames:MicrosoftAuth:AllowedTenantIds`.
- **MSAL authority normalization** (2026-06-23): the `/api/auth/config` handler
  strips a trailing `/v2.0` from the authority before handing it to the SPA,
  because MSAL.js appends `/v2.0/.well-known/openid-configuration` itself.
  Without the strip, MSAL doubles the segment and throws
  `endpoints_resolution_error`. `poauth.js` also strips the suffix as a
  defense-in-depth, so any future config drift won't break the flow.
- **Required-resource-access wiring** (2026-06-23): for the SPA to request
  `offline_access` (refresh tokens), the app registration must declare it
  under `requiredResourceAccess` on the Microsoft Graph service principal
  (`00000003-0000-0000-c000-000000000000`). Without this, Entra returns
  `invalid_scope: … scope 'offline_access' does not exist`. The current app
  declares `openid`, `profile`, and `offline_access`. To re-apply after
  recreating the app, see the PATCH snippet below.

---

## Re-applying required-resource-access after app recreation

```powershell
$body = @'
{"requiredResourceAccess":[{"resourceAppId":"00000003-0000-0000-c000-000000000000","resourceAccess":[{"id":"7427e0e9-2fba-42fe-b0c0-848c9e6a8182","type":"Scope"},{"id":"37f7f235-527c-4136-accd-4a02d197296e","type":"Scope"},{"id":"14dad69e-099b-42c9-810b-d002981feec1","type":"Scope"}]}]}
'@
Set-Content -Path "$env:TEMP\ms-rra.json" -Value $body
az rest --method PATCH `
  --uri "https://graph.microsoft.com/v1.0/applications/<APP_OBJ_ID>" `
  --headers "Content-Type=application/json" `
  --body "@$env:TEMP\ms-rra.json"
```

Scope GUIDs (Microsoft Graph service principal):

| Scope | GUID |
|---|---|
| `offline_access` | `7427e0e9-2fba-42fe-b0c0-848c9e6a8182` |
| `openid` | `37f7f235-527c-4136-accd-4a02d197296e` |
| `profile` | `14dad69e-099b-42c9-810b-d002981feec1` |
| `User.Read` | `e1fe6dd8-ba31-4d61-89e7-88639da4683d` (optional) |
