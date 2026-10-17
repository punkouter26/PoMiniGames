// PoDialogInterop — minimal <dialog> helpers for Blazor interop (Option #9).
//
// Loaded as a classic module from index.html before Blazor boots. Both
// functions are no-ops if the referenced element is not a <dialog>, which
// keeps the call sites safe in prerender / disconnected states.
//
// Why a shim instead of calling dialog.showModal() / dialog.close() directly
// from C#? Blazor's ElementReference interop only binds a fixed set of
// methods (focus, click, etc.) — showModal and close are HTMLDialogElement
// instance methods, not on the standard element surface. Going through JS is
// the supported path.
window.PoDialogInterop = (function () {
    function showModal(el) {
        if (!el || el.tagName !== 'DIALOG' || el.open) return;
        try { el.showModal(); } catch (_) { /* already open or detached */ }
    }

    function close(el) {
        if (!el || el.tagName !== 'DIALOG' || !el.open) return;
        try { el.close(); } catch (_) { /* already closed */ }
    }

    // One modal layer at a time. A sheet opened from inside another modal (PoCabinet's
    // pause dialog, PoEcosystem's dashboard) would otherwise stack a second backdrop on
    // the first. The layers under it are put away while it is up and come back when it
    // closes: a <dialog> is closed and re-opened modal (its own backdrop goes with it),
    // an aria-modal overlay is hidden in place.
    function isModalLayer(other) {
        if (other.tagName === 'DIALOG') {
            try { return other.matches(':modal'); } catch (_) { return other.open; }
        }
        return other.getClientRects().length > 0 && getComputedStyle(other).visibility !== 'hidden';
    }

    function showModalAlone(el) {
        if (!el || el.tagName !== 'DIALOG' || el.open) return;
        var opener = document.activeElement;
        var stashed = [];
        document.querySelectorAll('dialog[open], [aria-modal="true"]').forEach(function (other) {
            if (other === el || el.contains(other) || other.contains(el) || !isModalLayer(other)) return;
            if (other.tagName === 'DIALOG') {
                close(other);
                stashed.push({ el: other, dialog: true });
            } else {
                stashed.push({ el: other, dialog: false, visibility: other.style.visibility });
                other.style.visibility = 'hidden';
            }
        });
        if (stashed.length) {
            el.addEventListener('close', function () {
                stashed.forEach(function (s) {
                    if (!s.el.isConnected) return;
                    if (s.dialog) showModal(s.el);
                    else s.el.style.visibility = s.visibility;
                });
                // The browser hands focus back before this runs, while the opener's layer
                // was still put away, so it usually lands on <body>. Hand it over again.
                var a = document.activeElement;
                if (opener && opener.isConnected && (!a || a === document.body)) {
                    try { opener.focus({ preventScroll: true }); } catch (_) { /* gone */ }
                }
            }, { once: true });
        }
        showModal(el);
    }

    return { showModal: showModal, showModalAlone: showModalAlone, close: close };
})();
