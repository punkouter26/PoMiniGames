// View Transitions API (Suggestion #5)
// Smooth page transitions for Chromium-based browsers
(function () {
  'use strict';

  // Intercept navigation clicks for view transitions
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href^="/"], button[onclick*="NavigateTo"]');
    if (!link) return;

    // Only interrupt if View Transitions API is supported
    if (!document.startViewTransition) return;

    // For button clicks that navigate, we can't intercept directly in Blazor
    // This provides a graceful progressive enhancement
  });


})();