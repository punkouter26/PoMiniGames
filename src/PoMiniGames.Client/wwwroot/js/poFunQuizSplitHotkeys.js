// Split-screen PoFunQuiz hotkey bridge.
//
// Razor can't subscribe to global keyboard events directly, so we register
// a window keydown handler here and forward each press to the .NET handler
// exposed by the page (OnSplitHotkeyAsync). The listener is registered once
// per page lifetime and torn down on dispose.
//
// Layout:
//   - Left side (Player 1): keys 1 / 2 / 3 / 4 → option indices 0-3
//   - Right side (Player 2): keys 6 / 7 / 8 / 9 → option indices 0-3
//   - 5 is intentionally ignored (USB number row gap) so cross-side hits
//     are statistically less likely.
//
// We deliberately ignore keypresses when the user is typing in an input or
// contenteditable (e.g. the player name field on the landing card). That
// way the keys only fire during the in-game screen, not while the user is
// entering their names.

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
        // Only react to plain key presses (no Ctrl/Alt/Meta); let the browser
        // handle its own shortcuts unmodified.
        if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

        let side = null;
        let optionIndex = null;
        switch (ev.key) {
            case "1": side = "L"; optionIndex = 0; break;
            case "2": side = "L"; optionIndex = 1; break;
            case "3": side = "L"; optionIndex = 2; break;
            case "4": side = "L"; optionIndex = 3; break;
            case "6": side = "R"; optionIndex = 0; break;
            case "7": side = "R"; optionIndex = 1; break;
            case "8": side = "R"; optionIndex = 2; break;
            case "9": side = "R"; optionIndex = 3; break;
            default: return;
        }

        // Prevent the digit from leaking into any focused field (we already
        // bail out for inputs, but this also blocks arrow-key scrolling,
        // tab focus changes, etc.).
        ev.preventDefault();
        try {
            dotnetRef.invokeMethodAsync("OnSplitHotkeyAsync", side, optionIndex);
        } catch (e) {
            // .NET ref disposed during navigation — silence.
        }
    }

    window.poFunQuizSplitHotkeys = {
        register: function (ref) {
            dotnetRef = ref;
            active = true;
            window.addEventListener("keydown", onKeyDown, true);
        },
        unregister: function () {
            active = false;
            window.removeEventListener("keydown", onKeyDown, true);
            dotnetRef = null;
        }
    };
})();