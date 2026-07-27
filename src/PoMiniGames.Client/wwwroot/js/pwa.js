// Service worker registration + the two browser signals Blazor cannot read on its
// own: connectivity changes and "a new build is waiting to take over".
//
// Both are pushed into .NET via DotNetObjectReference callbacks rather than polled,
// so the UI reacts the moment the browser fires the event.
window.poPwa = (() => {
    let registration = null;
    let updateListener = null;   // DotNetObjectReference -> OnUpdateAvailable()
    let onlineListener = null;   // DotNetObjectReference -> OnConnectivityChanged(bool)

    function notifyUpdate() {
        if (updateListener) {
            updateListener.invokeMethodAsync('OnUpdateAvailable').catch(() => { });
        }
    }

    return {
        // Called once from MainLayout. Registration failure is never fatal: the app
        // works fine without offline support, so a blocked/unsupported worker must
        // not break startup.
        async register() {
            if (!('serviceWorker' in navigator)) return false;
            try {
                registration = await navigator.serviceWorker.register('service-worker.js');
            } catch {
                return false;
            }

            // A worker already parked in `waiting` means an update downloaded during
            // a previous visit and never activated.
            if (registration.waiting && navigator.serviceWorker.controller) notifyUpdate();

            registration.addEventListener('updatefound', () => {
                const installing = registration.installing;
                if (!installing) return;
                installing.addEventListener('statechange', () => {
                    // `controller` distinguishes an update from the very first install
                    // — on a first visit there is nothing to tell the user to reload for.
                    if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                        notifyUpdate();
                    }
                });
            });
            return true;
        },

        setUpdateListener(dotNetRef) { updateListener = dotNetRef; },

        // Tell the waiting worker to activate, then reload onto it. Without the
        // controllerchange wait, the reload can race the activation and land back on
        // the old build, which reads to the user as "the update button did nothing".
        applyUpdate() {
            if (!registration || !registration.waiting) { location.reload(); return; }
            let reloaded = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (reloaded) return;
                reloaded = true;
                location.reload();
            });
            registration.waiting.postMessage('skipWaiting');
        },

        // ── Connectivity ──────────────────────────────────────────────────────
        // navigator.onLine is a coarse signal (it reports link state, not whether
        // our server is actually reachable), but it is the only one that fires
        // instantly and without a request. Good enough to drive a banner.
        isOnline() { return navigator.onLine; },

        setOnlineListener(dotNetRef) {
            onlineListener = dotNetRef;
            const push = () => {
                if (onlineListener) {
                    onlineListener.invokeMethodAsync('OnConnectivityChanged', navigator.onLine)
                        .catch(() => { });
                }
            };
            window.addEventListener('online', push);
            window.addEventListener('offline', push);
            return navigator.onLine;
        },
    };
})();
