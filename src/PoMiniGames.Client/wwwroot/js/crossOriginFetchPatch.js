// §Cross-origin credentials patch.
//
// The Blazor WASM HttpClient uses the browser's `fetch` underneath, and
// defaults to `credentials: 'omit'`. On the standalone-client dev setup
// (Blazor served from :5261, API on :5000) every cross-origin request
// therefore drops the DevCookie set by `/api/auth/dev-login`, and every
// subsequent protected endpoint returns 401 "Requires an authenticated
// user".
//
// This module patches the global `fetch` once, on first import, so that:
//   • Same-origin requests are untouched (no behaviour change on :5000).
//   • Cross-origin requests get `credentials: 'include'` so the cookie
//     round-trips.
//
// Idempotent — multiple imports only install the patch once.

let installed = false;

(function installCrossOriginCredentialsPatch() {
    if (installed) return;
    installed = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = function patchedFetch(input, init) {
        // Determine the request URL.
        let url;
        try {
            url = typeof input === 'string'
                ? new URL(input, window.location.href)
                : (input instanceof URL
                    ? input
                    : new URL(input.url, window.location.href));
        } catch {
            // Unparseable URL — fall back to the original fetch.
            return originalFetch(input, init);
        }

        // Same-origin: no change needed (browser default of same-origin
        // already keeps cookies).
        if (url.origin === window.location.origin) {
            return originalFetch(input, init);
        }

        // Cross-origin: ensure credentials: 'include'. Don't clobber a
        // caller that explicitly set 'omit' (intentional opt-out).
        const nextInit = init ? { ...init } : {};
        if (!('credentials' in nextInit)) {
            nextInit.credentials = 'include';
        }
        return originalFetch(input, nextInit);
    };
})();