# Auth

Microsoft OAuth + dev/test guest-bypass configuration.

| File | Purpose |
|---|---|
| [`ms-oauth-localhost.md`](ms-oauth-localhost.md) | App registration, user-secrets wiring, recreation steps |

## Authority & tenant model (2026-06-26)

PoMiniGames uses the **`common`** authority endpoint so the same AAD app
registration accepts **all Microsoft account types**:

| Tenant model | Authority | Use case |
|---|---|---|
| `common` | `https://login.microsoftonline.com/common/v2.0` | Multitenant + personal accounts — **default for PoMiniGames** |
| `organizations` | `https://login.microsoftonline.com/organizations/v2.0` | Work/school only (any org) |
| `consumers` | `https://login.microsoftonline.com/consumers/v2.0` | Personal only |

### App registration requirements

When creating / updating the AAD app registration (`az ad app create ...`):

```bash
az ad app create \
  --display-name "PoMiniGames" \
  --sign-in-audience AzureADandPersonalMicrosoftAccount \
  --web-redirect-uris "https://<app-service>.azurewebsites.net/auth/callback"
```

The `--sign-in-audience AzureADandPersonalMicrosoftAccount` flag is the
**multitenant + personal** option. It maps to `common` in the JWT issuer
claim and lets any user with a Microsoft account (work, school, or
personal/outlook) sign in.

### Token validation

`MicrosoftAuthIssuerValidator` allow-lists the well-known public authorities
(`common`, `organizations`, `consumers`) and any explicit tenant IDs added
to `PoMiniGames:MicrosoftAuth:AllowedTenantIds`. Single-tenant deployments
can swap to `AzureADMyOrg` and pin the home tenant ID via the same list.

## Routes

The explicit auth routes documented in §2.3 are:

| Route | Purpose |
|---|---|
| `/auth/login/microsoft` | Initiates the MSAL.js interactive sign-in (returns to SPA via `/auth/callback`). |
| `/auth/login/fake` | **Dev/Test only**. Mints a guest identity via the DevCookie scheme. 404 in Production. Loopback-only. |
| `/auth/logout` | Clears the DevCookie (and the server-side session). |
| `/auth/me` | Returns current server auth state + `oauthConfigured` flag. `[AllowAnonymous]`. |

## Environment matrix

| Environment | Auth options shown on `/` | Cookie scheme | Bearer scheme |
|---|---|---|---|
| **Local dev** | Microsoft OAuth **and** Continue as Guest | `PoMiniGames.DevAuth` (HttpOnly, SameSite=Lax) | `JwtBearer` (MSAL.js token, optional) |
| **Azure Prod** | Microsoft OAuth only (MSAL.js popup) | `PoMiniGames.DevAuth` is NOT issued | `JwtBearer` (MSAL.js token required) |
| **Test env** (`ASPNETCORE_ENVIRONMENT=Test`) | Auto-guest via `?autoGuest=1` (dev bypass), else cookie sign-in | `PoMiniGames.DevAuth` issued by `/auth/login/fake` | not used in test harness |

`FakeAuthHandler` (header-driven, `X-Fake-User` / `X-Fake-Roles`) is
**Dev-only**, requires the explicit `Auth:EnableFakeAuth=true` flag, and
triggers a startup exception in Production (`Program.cs` guard).
