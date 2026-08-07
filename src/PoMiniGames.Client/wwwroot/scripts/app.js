// View Transitions API + global keyboard shortcuts.
// Smooth page transitions for Chromium-based browsers; graceful
// progressive enhancement for everyone else (no-op fall-through).
(function () {
  'use strict';

  // ----- 1. View Transitions for SPA navigations -----
  // Intercept any in-page link click and, when the browser supports the
  // View Transitions API, wrap the navigation in startViewTransition so
  // the page cross-fades instead of hard-cutting. Falls back to a normal
  // navigation in unsupported browsers.
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href^="/"]');
    if (!link) return;
    if (link.target && link.target !== '_self') return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!document.startViewTransition) return;
    e.preventDefault();
    var href = link.getAttribute('href');
    document.startViewTransition(function () {
      window.location.href = href;
    });
  });

  // ----- 2. (Removed) kiosk ESC handler -----
  // `window.kioskRegisterEscHandler` had exactly one caller, KioskControlBar,
  // which was dropped from MainLayout in the 2026-07-04 mobile-portrait cleanup
  // and has now been deleted. Nothing ever registered a callback, so the ESC key
  // already did nothing for kiosk mode — this only removes the dead scaffolding,
  // not a working shortcut. It also leaked: every registration added another
  // unremoved document keydown listener.
  //
  // If ESC-to-exit-demo is wanted again, it belongs on the page that starts the
  // kiosk (Pages/Index.razor owns KioskCoordinator.Start/Stop) rather than on a
  // floating bar, and can be a plain @onkeydown there with no JS interop at all.

  // ----- 3. WebGL2 + device capability probe (callable from Blazor) -----
  // §2: gates the home page ambient particle field. Skips WebGL entirely on
  // low-memory devices, when prefers-reduced-motion is set, or when WebGL2
  // is unavailable. Returns a boolean — caller falls back to the CSS gradient.
  window.probeWebGL2 = function () {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return false;
      }
      // §9 mobile-portrait battery guard: the ambient particle field is purely
      // decorative chrome behind the game list. On portrait phones it's GPU/battery
      // cost with little payoff, so fall back to the (already frozen <=768px) CSS
      // gradient there instead of waking the GPU render loop.
      if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) {
        return false;
      }
      var mem = navigator.deviceMemory || 4;
      if (mem < 4) return false;
      var c = document.createElement('canvas');
      return !!(c.getContext && c.getContext('webgl2'));
    } catch (_) {
      return false;
    }
  };

})();