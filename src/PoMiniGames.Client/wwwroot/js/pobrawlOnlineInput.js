// PoBrawl online key bridge.
//
// Mirrors the PoFunQuiz split-screen pattern: a window-level key listener that
// ignores inputs / textareas / modified chords and forwards into [JSInvokable]
// methods on the fight page.
//
// Two kinds of key, matching the server's two kinds of input (2026-09-23):
//   • HELD — a / d walk left / right, s guards. Sent as the resulting held state
//     ('left' | 'right' | 'block' | 'idle') on every key-down AND key-up, because
//     the server now keeps walking or guarding until told otherwise. This used to
//     send key-downs only, which was fine while the server ignored distance — and
//     is exactly why one tap of punch used to repeat forever: the server kept the
//     last action live every tick.
//   • PRESS — f punch, g kick, h special. Sent once per key-down; the server
//     buffers one and fires it when that corner's cooldown allows.
//
// Screen direction is resolved on the .NET side, which knows which corner this
// client is: 'right' walks P1 in and P2 out.

(function () {
    let dotnetRef = null;
    let active = false;
    const held = new Set();      // 'a' | 'd' | 's' currently down
    let lastWalk = null;         // most recently pressed of a / d, so both-down resolves sanely
    let lastSent = 'idle';

    function shouldIgnore(target) {
        if (!target) return false;
        const tag = (target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return true;
        if (target.isContentEditable) return true;
        return false;
    }

    function heldState() {
        if (held.has('s')) return 'block';
        const left = held.has('a'), right = held.has('d');
        if (left && right) return lastWalk === 'a' ? 'left' : 'right';
        if (left) return 'left';
        if (right) return 'right';
        return 'idle';
    }

    function sendHeld() {
        const state = heldState();
        if (state === lastSent) return;
        lastSent = state;
        try { dotnetRef.invokeMethodAsync("OnOnlineHeldAsync", state); } catch { /* ref disposed mid-navigation */ }
    }

    function onKeyDown(ev) {
        if (!active || !dotnetRef) return;
        if (shouldIgnore(ev.target)) return;
        // Plain keys only — leave browser shortcuts alone (Ctrl+R reload etc.).
        if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
        const key = (ev.key || "").toLowerCase();
        if (key === 'a' || key === 'd' || key === 's') {
            ev.preventDefault();
            if (ev.repeat) return;
            held.add(key);
            if (key !== 's') lastWalk = key;
            sendHeld();
            return;
        }
        if (key !== 'f' && key !== 'g' && key !== 'h') return;
        // Don't let the key scroll the page or land in any focused control.
        ev.preventDefault();
        if (ev.repeat) return;
        try { dotnetRef.invokeMethodAsync("OnOnlineInputAsync", key); } catch { /* disposed */ }
    }

    function onKeyUp(ev) {
        if (!active || !dotnetRef) return;
        const key = (ev.key || "").toLowerCase();
        if (!held.delete(key)) return;
        sendHeld();
    }

    // A window that loses focus never sees the key-ups, so release everything —
    // otherwise alt-tabbing mid-walk leaves the fighter marching into the ropes.
    function onBlur() {
        if (!active || !dotnetRef || held.size === 0) return;
        held.clear();
        sendHeld();
    }

    window.pobrawlOnlineInput = {
        register: function (ref) {
            // Always take the new ref — DisposeAsync on the previous page may not
            // have fired yet when a fresh page mounts under Nav.NavigateTo, so a
            // guard against double-register would leave us bound to a disposed
            // DotNetObjectReference whose invokeMethodAsync silently throws.
            dotnetRef = ref;
            held.clear();
            lastSent = 'idle';
            if (active) return;
            active = true;
            window.addEventListener("keydown", onKeyDown, true);
            window.addEventListener("keyup", onKeyUp, true);
            window.addEventListener("blur", onBlur);
        },
        unregister: function () {
            if (!active) return;
            active = false;
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("keyup", onKeyUp, true);
            window.removeEventListener("blur", onBlur);
            held.clear();
            dotnetRef = null;
        },
    };
})();
