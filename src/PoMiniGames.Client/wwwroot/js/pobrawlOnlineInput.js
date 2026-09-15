// PoBrawl online key bridge.
//
// Mirrors the PoFunQuiz split-screen pattern: a window-level keydown
// listener that ignores inputs / textareas / modified chords and forwards
// each relevant press into a [JSInvokable] method on the fight page.
//
// Keys → PoBrawlMatchAction (the shared enum on the server too):
//   a / A → MoveBack     d / D → MoveForward
//   s / S → Block        f / F → Punch      g / G → Kick       h / H → Special
//
// Up-key releases don't send — the server keeps the last action per side
// for the rest of the tick, so a "missing up-key" reads as "still doing
// that" until the next press lands. A release would just waste a round
// trip. poFunQuizSplitHotkeys.js makes the same trade and is the closest
// precedent in the app.

(function () {
    let dotnetRef = null;
    let active = false;

    function shouldIgnore(target) {
        if (!target) return false;
        const tag = (target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return true;
        if (target.isContentEditable) return true;
        return false;
    }

    function onKeyDown(ev) {
        if (!active || !dotnetRef) return;
        if (shouldIgnore(ev.target)) return;
        // Plain keys only — leave browser shortcuts alone (Ctrl+R reload etc.).
        if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
        if (ev.repeat) return;

        const key = ev.key;
        if (key !== "a" && key !== "A"
         && key !== "d" && key !== "D"
         && key !== "s" && key !== "S"
         && key !== "f" && key !== "F"
         && key !== "g" && key !== "G"
         && key !== "h" && key !== "H") return;

        // Don't let the key scroll the page or land in any focused control.
        ev.preventDefault();
        try {
            dotnetRef.invokeMethodAsync("OnOnlineInputAsync", key.toLowerCase());
        } catch {
            // .NET ref disposed mid-navigation — silence.
        }
    }

    window.pobrawlOnlineInput = {
        register: function (ref) {
            // Always take the new ref — DisposeAsync on the previous page may not
            // have fired yet when a fresh page mounts under Nav.NavigateTo, so a
            // guard against double-register would leave us bound to a disposed
            // DotNetObjectReference whose invokeMethodAsync silently throws.
            dotnetRef = ref;
            active = true;
            window.addEventListener("keydown", onKeyDown, true);
        },
        unregister: function () {
            if (!active) return;
            active = false;
            window.removeEventListener("keydown", onKeyDown, true);
            dotnetRef = null;
        },
    };
})();
