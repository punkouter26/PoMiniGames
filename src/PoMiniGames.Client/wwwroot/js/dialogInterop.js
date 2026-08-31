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

    return { showModal: showModal, close: close };
})();
