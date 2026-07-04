# Auth — current model & BFF migration plan

Canonical runtime behavior lives in **AGENT.MD → "Auth"**. This doc covers the
Entra setup and the planned move to a Backing-for-Frontend (BFF) cookie proxy.

## Environment → sign-in surface (implemented)

| Environment | Options | Enforcement |
|---|---|---|
| Development | Microsoft OAuth **+** Continue as Guest | `devLoginEnabled = IsDevelopment()` |
| Test | Guest / dev-bypass only | `IsEnvironment("Test")`, `X-Fake-User` header, `?autoGuest=1` |
| Production | Microsoft OAuth **only** | Guest hidden; `StartupSecretValidator` throws if `FakeAuth` scheme or `Auth:AutoGuestLogin` present, or if `MicrosoftAuth:ClientId`/`ApiClientId` missing |

Sources: `Infrastructure/AuthExtensions.cs`, `Features/Auth/AuthEndpoints.cs`,
`Infrastructure/StartupSecretValidator.cs`, `Components/LoginScreen.razor`.

## Entra app registration
- Sign-in audience: `AzureADandPersonalMicrosoftAccount` (`/common` authority,
  `https://login.microsoftonline.com/common/v2.0`).
- Issuer validation: `ValidateIssuer = true` + `MicrosoftAuthIssuerValidator`
  allow-listing `common`/`organizations`/`consumers` plus configured tenant IDs.

---

## Planned: BFF cookie-proxy migration (§4.2) — NOT yet implemented

**Why:** today the real (prod) sign-in is client-side MSAL.js. `poauth.js` caches
tokens in `sessionStorage` and `AuthStateService.AccessToken` is attached as a
Bearer header. Rule §4.2 requires the opposite: the WASM client must never hold
tokens; sessions ride a server-managed HttpOnly, SameSite=Strict, encrypted cookie
and the host proxies downstream calls.

**Target design**
1. Host adds `AddOpenIdConnect` (authorization-code + PKCE) alongside the cookie
   scheme; the **host** completes the OAuth handshake, not the browser.
2. Tokens are stored server-side (auth-cookie ticket or a `ITicketStore` backed by
   the existing DataProtection + Table Storage), never sent to WASM.
3. `/auth/login/microsoft` issues an OIDC challenge; the callback sets the encrypted
   cookie and redirects to a validated local `returnUrl`.
4. Client deletes `poauth.js`, MSAL.js, and all `AccessToken` plumbing
   (`AuthStateService`, `ApiService`). API calls rely on the same-origin cookie.
5. SignalR hubs authenticate via the cookie — removes the `?access_token=` query
   string in `AuthExtensions.cs` (resolves the token-in-URL finding).

**Azure prerequisites (outside this repo — required before merge)**
- Change the app registration **platform** from SPA → **Web**; register the BFF
  callback (`/signin-oidc`) in the Web redirect list.
- Add a **client secret** (or federated credential) to Key Vault
  (`PoMiniGames--AzureAd--ClientSecret`); confidential clients need it.

**Verification gate (why this is a branch, not a hotfix):** the flow can only be
validated with a live browser OAuth round-trip against a real Entra tenant plus the
Azure-side platform/secret changes above. It must ship on a branch with an E2E-UI
sign-in test, not blind-merged to `master` — a wrong redirect URI or missing secret
breaks production sign-in and only surfaces on a real login.

**Interim hardening already applied:** the dev/guest cookie is `SameSite=Strict`
(`AuthExtensions.cs`).
