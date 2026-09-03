// input.js — keyboard + pointer-lock mouse (and a touch fallback) feeding the player
// controller. Keeps no three.js or sim state: it only produces the { forward, right, run,
// jump, up } intent and calls back for one-shot actions (inspect, fly, dashboard, speed).
export const KEY_HELP = Object.freeze([
  ['WASD', 'move'], ['Shift', 'run'], ['Space', 'jump'], ['F', 'fly'], ['E', 'inspect'], ['Tab', 'dashboard'],
]);

export function createInput(canvas, { onAction = () => {}, onLook = () => {} } = {}) {
  const keys = new Set();
  const intent = { forward: 0, right: 0, run: false, jump: false, up: 0 };
  const touch = { active: false, moveId: null, lookId: null, mx: 0, mz: 0, lastX: 0, lastY: 0 };
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

  const onKeyDown = (e) => {
    if (isTyping(e) || disposed) return;
    const c = code(e);
    if (c === 'Tab') { e.preventDefault(); onAction('dashboard'); return; }
    if (c === 'Escape') { onAction('escape'); return; }
    if (keys.has(c)) return;
    keys.add(c);
    if (c === 'Space') { e.preventDefault(); intent.jump = true; }
    if (c === 'KeyF') onAction('fly');
    if (c === 'KeyE') onAction('inspect');
    if (c === 'KeyT') onAction('follow');
    if (c === 'KeyM') onAction('map');
    if (c === 'Digit0') onAction('speed', 0);
    if (c === 'Digit1') onAction('speed', 1);
    if (c === 'Digit2') onAction('speed', 2);
    if (c === 'Digit3') onAction('speed', 4);
    refresh();
  };
  const onKeyUp = (e) => { keys.delete(code(e)); if (code(e) === 'Space') intent.jump = false; refresh(); };
  const onBlur = () => { keys.clear(); refresh(); };

  const onMouseMove = (e) => { if (locked) onLook(e.movementX ?? 0, e.movementY ?? 0); };
  const onClick = () => { if (!locked && canvas.requestPointerLock) canvas.requestPointerLock(); else onAction('inspect'); };
  const onLockChange = () => {
    locked = document.pointerLockElement === canvas;
    onAction('pointerLock', locked);
    if (!locked) { keys.clear(); refresh(); }
  };
  const onMouseDown = (e) => { if (locked && e.button === 0) onAction('inspect'); };

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
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('click', onClick);
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
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
      if (locked && document.exitPointerLock) document.exitPointerLock();
    },
  };
}
