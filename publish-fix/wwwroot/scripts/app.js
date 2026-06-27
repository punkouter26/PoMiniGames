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

  // ----- 2. Global keyboard shortcuts (2026 kiosk UX) -----
  // ESC: exit the demo kiosk if active. The KioskControlBar component
  // registers a .NET callback via kioskRegisterEscHandler; we just
  // forward the ESC keypress to whatever .NET instance was last
  // registered.
  var _escDotNetRef = null;
  window.kioskRegisterEscHandler = function (dotNetRef) {
    _escDotNetRef = dotNetRef;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _escDotNetRef) {
        _escDotNetRef.invokeMethodAsync('ExitKioskFromJs');
      }
    });
  };

})();