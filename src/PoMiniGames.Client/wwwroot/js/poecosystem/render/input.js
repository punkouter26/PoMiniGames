// input.js — keyboard + mouse (drag-look and pointer-lock free-look, with a touch
// fallback) feeding the player controller. Keeps no three.js or sim state: it only
// produces the { forward, right, run, jump, up } intent and calls back for one-shot
// actions (inspect, fly, dashboard, speed).
//
// Mouse look has TWO paths on purpose. Pointer lock is the good one (infinite travel, no
// cursor), but it only exists after a click the browser accepts as a gesture, and it is
// dropped by every Esc — closing the dashboard, dismissing the decree console — after
// which Chrome refuses to re-lock for about a second. Until 2026-09-16 that was the only
// path, so a player who simply moved the mouse, or clicked during the re-lock cooldown,
// saw a camera that ignored them entirely (reported as "the mouse is not moving the
// camera view"). Left-drag now looks as well: it needs no lock, no gesture budget and no
// permission, and a press that never travels past DRAG_SLOP still falls through to the
// lock request, so the old click-to-free-look gesture is unchanged.
export function createInput(canvas, { onAction = () => {}, onLook = () => {} } = {}) {
  const keys = new Set();
  const intent = { forward: 0, right: 0, run: false, jump: false, up: 0 };
  const touch = { active: false, moveId: null, lookId: null, mx: 0, mz: 0, lastX: 0, lastY: 0 };
  // Left-button drag-look. `moved` latches once the press travels past the slop, which is
  // what separates a look-drag from a click: a drag must NOT end by grabbing the pointer.
  const drag = { active: false, moved: false, originX: 0, originY: 0, lastX: 0, lastY: 0 };
  const DRAG_SLOP = 4;   // px of travel before a press is a look rather than a click
  let locked = false;
  let disposed = false;

  const code = (e) => e.code || e.key;
  const isTyping = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };

  function refresh() {
    intent.forward = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    intent.right = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    intent.run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    intent.up = (keys.has('Space') ? 1 : 0) - (keys.has('ControlLeft') || keys.has('ControlRight') ? 1 : 0);
    if (touch.active) { intent.forward = touch.mz; intent.right = touch.mx; }
  }

  // Digit keys map to the speed ladder; note 3 selects 4×.
  const SPEED_KEYS = { Digit0: 0, Digit1: 1, Digit2: 2, Digit3: 4 };

  const onKeyDown = (e) => {
    if (isTyping(e) || disposed) return;
    const c = code(e);
    if (c === 'Tab') { e.preventDefault(); onAction('dashboard'); return; }
    if (c === 'Escape') { onAction('escape'); return; }
    // Slash summons the Divine Decree console (and never types into it — the input's own
    // isTyping guard stops this handler while it is focused, so Slash only ever opens).
    if (c === 'Slash') { e.preventDefault(); onAction('decree'); return; }
    if (keys.has(c)) return;
    keys.add(c);
    if (c === 'Space') { e.preventDefault(); intent.jump = true; }
    if (c === 'KeyF') onAction('fly');
    if (c === 'KeyE') onAction('inspect');
    if (c === 'KeyT') onAction('follow');
    if (c === 'KeyM') onAction('map');
    if (c === 'KeyC') onAction('director');
    if (c === 'KeyP') onAction('pip');
    if (c in SPEED_KEYS) onAction('speed', SPEED_KEYS[c]);
    refresh();
  };
  const onKeyUp = (e) => { keys.delete(code(e)); if (code(e) === 'Space') intent.jump = false; refresh(); };
  const onBlur = () => { keys.clear(); drag.active = false; drag.moved = false; refresh(); };

  // Both mouse paths land here. While locked the browser hands us movementX/Y directly;
  // while dragging we difference the client position ourselves. Listening on `window`
  // rather than the canvas is what keeps a drag alive once it leaves the viewport edge.
  const onMouseMove = (e) => {
    if (locked) { onLook(e.movementX ?? 0, e.movementY ?? 0); return; }
    if (!drag.active) return;
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.originX) + Math.abs(e.clientY - drag.originY) < DRAG_SLOP) return;
      drag.moved = true;
    }
    onLook(dx, dy);
  };
  const requestLock = () => {
    // Rejects on the post-Esc cooldown and whenever the document has lost focus; an
    // unhandled rejection there would be the only sign anything happened, so swallow it.
    const p = canvas.requestPointerLock?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  };
  const onLockChange = () => {
    locked = document.pointerLockElement === canvas;
    onAction('pointerLock', locked);
    if (!locked) { keys.clear(); refresh(); }
    // A lock that begins mid-drag would double-count the motion (movementX *and* our own
    // difference), and one that ends leaves a stale origin behind.
    drag.active = false; drag.moved = false;
  };
  const onMouseDown = (e) => {
    if (disposed || e.button !== 0) return;
    if (locked) { onAction('inspect'); return; }
    drag.active = true; drag.moved = false;
    drag.originX = e.clientX; drag.originY = e.clientY;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    e.preventDefault();   // a mouse drag over a canvas otherwise starts a text selection
  };
  const onMouseUp = (e) => {
    if (!drag.active || e.button !== 0) return;
    const wasClick = !drag.moved;
    drag.active = false; drag.moved = false;
    // A press that never travelled is still the click-to-free-look gesture.
    if (wasClick && !locked) requestLock();
  };

  // Touch: left half drags the move pad, right half looks.
  const onTouchStart = (e) => {
    for (const t of e.changedTouches) {
      if (t.clientX < canvas.clientWidth / 2 && touch.moveId === null) { touch.moveId = t.identifier; touch.originX = t.clientX; touch.originY = t.clientY; touch.active = true; }
      else if (touch.lookId === null) { touch.lookId = t.identifier; touch.lastX = t.clientX; touch.lastY = t.clientY; }
    }
  };
  const onTouchMove = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === touch.moveId) {
        const dx = t.clientX - touch.originX; const dy = t.clientY - touch.originY;
        const len = Math.max(1, Math.hypot(dx, dy));
        const s = Math.min(1, len / 60);
        touch.mx = (dx / len) * s; touch.mz = (-dy / len) * s;
        refresh();
      } else if (t.identifier === touch.lookId) {
        onLook((t.clientX - touch.lastX) * 2, (t.clientY - touch.lastY) * 2);
        touch.lastX = t.clientX; touch.lastY = t.clientY;
      }
    }
    e.preventDefault();
  };
  const onTouchEnd = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === touch.moveId) { touch.moveId = null; touch.active = false; touch.mx = 0; touch.mz = 0; refresh(); }
      if (t.identifier === touch.lookId) touch.lookId = null;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('pointerlockchange', onLockChange);
  // move/up on window, down on the canvas: the press must start on the world, but the
  // drag has to survive leaving it (and a release over the HUD must still end the drag).
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: true });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return {
    intent,
    get locked() { return locked; },
    /** Jump is edge-triggered: the controller consumes it once. */
    consume() { const snapshot = { ...intent }; intent.jump = false; return snapshot; },
    setTouchVector(x, z) { touch.active = true; touch.mx = x; touch.mz = z; refresh(); },
    releaseTouch() { touch.active = false; touch.mx = 0; touch.mz = 0; refresh(); },
    dispose() {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onLockChange);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
      if (locked && document.exitPointerLock) document.exitPointerLock();
    },
  };
}
