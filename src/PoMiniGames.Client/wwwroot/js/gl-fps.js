// gl-fps.js — global requestAnimationFrame-driven FPS sampler.
// Drives the top-nav <FpsCounter /> on every page. Self-stops on `beforeunload`
// so navigating away doesn't leak a callback. Single-instance: if `glFps.start`
// is called twice (e.g. multiple <FpsCounter /> re-mounts), we no-op.

(function () {
  let raf = 0;
  let last = 0;
  let dotnetRef = null;

  function tick(now) {
    if (!dotnetRef) return;
    if (last) {
      const delta = now - last;
      // Ignore giant gaps (tab was hidden) so the counter doesn't drop to 0.
      if (delta < 1000) {
        try { dotnetRef.invokeMethodAsync('OnTick', delta); } catch { /* component gone */ }
      }
    }
    last = now;
    raf = requestAnimationFrame(tick);
  }

  window.glFps = {
    start(ref) {
      if (dotnetRef) return; // already running
      dotnetRef = ref;
      last = 0;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      dotnetRef = null;
      last = 0;
    },
  };

  window.addEventListener('beforeunload', () => window.glFps.stop());
})();