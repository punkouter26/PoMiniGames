// PoReflex reaction-timing module. Owns the per-bar arm delay + input capture so
// the reaction clock uses one monotonic source (performance.now) and never picks up
// Blazor render-loop jitter. Both a keydown (Space/Enter) and a pointerdown on the
// game area count as a STOP. An `autoMs` > 0 makes the bar auto-press after go-live
// (demo bot); a real player leaves it 0.
let s = null;

export function start(dotNet, areaEl, minMs, maxMs, autoMs) {
  stop();
  s = { dotNet, areaEl, live: false, done: false, goLive: 0, armTimer: 0, autoTimer: 0, onKey: null, onPointer: null };

  const press = () => {
    if (!s || s.done) return;
    if (!s.live) {
      // Jumped the gun — the bar had not gone live yet. Run over.
      s.done = true;
      cleanup();
      s.dotNet.invokeMethodAsync('OnFalseStart');
      return;
    }
    const rt = performance.now() - s.goLive;
    s.done = true;
    cleanup();
    s.dotNet.invokeMethodAsync('OnReaction', rt);
  };

  s.onKey = (e) => {
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); press(); }
  };
  s.onPointer = (e) => { e.preventDefault(); press(); };

  document.addEventListener('keydown', s.onKey);
  if (areaEl) areaEl.addEventListener('pointerdown', s.onPointer);

  const delay = minMs + Math.random() * Math.max(0, maxMs - minMs);
  s.armTimer = setTimeout(() => {
    if (!s || s.done) return;
    s.live = true;
    s.goLive = performance.now();
    s.dotNet.invokeMethodAsync('OnGoLive');
    if (autoMs > 0) {
      s.autoTimer = setTimeout(press, autoMs);
    }
  }, delay);
}

function cleanup() {
  if (!s) return;
  if (s.armTimer) { clearTimeout(s.armTimer); s.armTimer = 0; }
  if (s.autoTimer) { clearTimeout(s.autoTimer); s.autoTimer = 0; }
  if (s.onKey) document.removeEventListener('keydown', s.onKey);
  if (s.onPointer && s.areaEl) s.areaEl.removeEventListener('pointerdown', s.onPointer);
}

export function stop() {
  if (s) { s.done = true; cleanup(); s = null; }
}
