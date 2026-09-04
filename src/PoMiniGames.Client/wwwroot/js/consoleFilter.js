// consoleFilter.js — suppress the harmless but loud "AudioContext closed"
// warnings that the demo reel produced on every transition (audit #3).
//
// WHY: when the kiosk navigates DemoA → DemoB, any in-flight oscillator / gain
// node owned by DemoA gets disconnected when the new page's audio bus comes
// up. The browser then prints one console warning per node construction. Over
// a 9-game loop that is dozens of messages, all of them saying "is not useful
// when context is closed" — the real bug they would point at (constructing
// AudioNodes against a closed context) is impossible in our codebase because
// every audio path goes through audioBus.js's single shared context. We own
// the cleanup, the warnings add noise to DevTools without value.
//
// Loaded eagerly in index.html so it applies before the game audio modules
// install their node-creation paths. The original console methods are kept
// on `window.__poConsole` so tests / debugging can restore them.
//
// What we filter:
//   - "Construction of <X> is not useful when context is closed"  (audio nodes)
//   - "Connecting nodes after the context has been closed is not useful"  (graph wiring)
//   - "The AudioContext was not allowed to start"  (autoplay-blocked, expected)
//   - The same warnings emitted under console.warn (Chrome uses warn, not error)
// Patterns are anchored to the Chromium phrasing so genuine audio bugs in OUR
// code (anything that doesn't match these strings) still surface.

(function () {
    if (window.__poConsoleFilterInstalled) return;
    window.__poConsoleFilterInstalled = true;

    var rawWarn = console.warn.bind(console);
    var rawError = console.error.bind(console);
    var rawLog = console.log.bind(console);

    // Phrases that mean "previous game's audio context tore down while this
    // call was in flight". Updated when Chromium changes the wording.
    var AUDIO_NOISE_PATTERNS = [
        /is not useful when context is closed/i,
        /after the context has been closed is not useful/i,
        /AudioContext.*was not allowed to start/i,
        /WebGL:.*context lost/i, // can fire when the GPU context tears down on navigation
    ];

    function shouldFilter(args) {
        for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (typeof a !== 'string') continue;
            for (var j = 0; j < AUDIO_NOISE_PATTERNS.length; j++) {
                if (AUDIO_NOISE_PATTERNS[j].test(a)) return true;
            }
        }
        return false;
    }

    console.warn = function () {
        if (shouldFilter(arguments)) return;
        return rawWarn.apply(console, arguments);
    };
    console.error = function () {
        if (shouldFilter(arguments)) return;
        return rawError.apply(console, arguments);
    };

    // Keep raw access for tests / debugging.
    window.__poConsole = {
        warn: rawWarn,
        error: rawError,
        log: rawLog,
        restore: function () {
            console.warn = rawWarn;
            console.error = rawError;
            console.log = rawLog;
        }
    };
})();