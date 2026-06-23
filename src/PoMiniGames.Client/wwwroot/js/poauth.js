// Microsoft sign-in (MSAL.js) interop for the Blazor WASM client.
//
// The server exposes the SPA's ClientId / Authority / Scope / RedirectPath via
// /api/auth/config; AuthStateService passes them here. Sign-in uses a popup so
// no route-level redirect handling is required. acquireTokenSilent fetches an
// access token for the API scope, which the C# side attaches as the bearer for
// authenticated API calls.
//
// All functions degrade gracefully (return null / throw a clear error) when the
// msal-browser global failed to load, so the rest of the app is unaffected.
(function () {
    let app = null;
    let apiScope = null;

    function ensureLib() {
        if (typeof msal === "undefined" || !msal.PublicClientApplication) {
            throw new Error("MSAL library failed to load (network/CDN blocked).");
        }
    }

    function loginScopes(scope) {
        const base = ["openid", "profile", "email"];
        return scope ? base.concat([scope]) : base;
    }

    async function acquireToken(account, scope) {
        if (!scope || !account) return null;
        try {
            const res = await app.acquireTokenSilent({ account, scopes: [scope] });
            return res.accessToken;
        } catch (e) {
            try {
                const res = await app.acquireTokenPopup({ scopes: [scope] });
                return res.accessToken;
            } catch {
                return null;
            }
        }
    }

    function toResult(account, accessToken) {
        return {
            name: account.name || account.username,
            username: account.username,
            accessToken: accessToken || null
        };
    }

    window.poAuth = {
        init: function (clientId, authority, redirectPath) {
            ensureLib();
            apiScope = null;
            const origin = window.location.origin;
            const redirectUri = redirectPath
                ? origin + (redirectPath.startsWith("/") ? redirectPath : "/" + redirectPath)
                : origin;
            app = new msal.PublicClientApplication({
                auth: {
                    clientId: clientId,
                    authority: authority,
                    redirectUri: redirectUri,
                    postLogoutRedirectUri: origin
                },
                cache: { cacheLocation: "sessionStorage", storeAuthStateInCookie: false }
            });
        },

        // Silent restore: returns a result if MSAL already has a cached account.
        tryRestore: async function (scope) {
            if (!app) return null;
            apiScope = scope;
            const accounts = app.getAllAccounts();
            if (!accounts || accounts.length === 0) return null;
            const account = accounts[0];
            const token = await acquireToken(account, scope);
            return toResult(account, token);
        },

        // Interactive popup sign-in.
        signIn: async function (scope) {
            ensureLib();
            apiScope = scope;
            const res = await app.loginPopup({ scopes: loginScopes(scope) });
            const account = res.account || (app.getAllAccounts()[0]);
            if (!account) return null;
            app.setActiveAccount(account);
            const token = await acquireToken(account, scope);
            return toResult(account, token);
        },

        signOut: async function () {
            if (!app) return;
            const account = app.getActiveAccount() || (app.getAllAccounts()[0]);
            await app.logoutPopup({ account });
        }
    };
})();
