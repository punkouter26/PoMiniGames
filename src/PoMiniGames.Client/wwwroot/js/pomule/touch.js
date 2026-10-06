// PoMule on-screen controls for touch devices: a stick on the left, Act and Dash on the
// right. Everything dispatches synthetic key events on window, so the keyboard path in
// index.js stays the only input path (same approach as js/posports/touch.js).

/** True when the primary pointer is a finger. */
export function isTouchDevice() {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

function key(type, code) {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
}

/** Builds the pad inside `container` and returns a function that removes it. */
export function buildTouchControls(container) {
  const root = document.createElement('div');
  root.className = 'pm-touch';

  const stick = document.createElement('div');
  stick.className = 'pm-stick';
  stick.setAttribute('aria-label', 'Move');
  const nub = document.createElement('div');
  nub.className = 'pm-stick-nub';
  stick.appendChild(nub);

  // The stick holds down whichever of W/A/S/D its angle covers, so diagonals work.
  const held = new Set();
  const press = (wanted) => {
    for (const code of [...held]) if (!wanted.has(code)) { held.delete(code); key('keyup', code); }
    for (const code of wanted) if (!held.has(code)) { held.add(code); key('keydown', code); }
  };
  const aim = (e) => {
    const r = stick.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const reach = r.width / 2, len = Math.hypot(dx, dy) || 1, clamp = Math.min(1, reach / len);
    nub.style.transform = `translate(${dx * clamp}px, ${dy * clamp}px)`;
    const wanted = new Set();
    if (len > reach * 0.25) {
      if (dx / len > 0.38) wanted.add('KeyD');
      if (dx / len < -0.38) wanted.add('KeyA');
      if (dy / len > 0.38) wanted.add('KeyS');
      if (dy / len < -0.38) wanted.add('KeyW');
    }
    press(wanted);
  };
  const release = () => { nub.style.transform = ''; press(new Set()); };
  stick.addEventListener('pointerdown', (e) => { e.preventDefault(); stick.setPointerCapture(e.pointerId); aim(e); });
  stick.addEventListener('pointermove', (e) => { if (stick.hasPointerCapture(e.pointerId)) aim(e); });
  stick.addEventListener('pointerup', release);
  stick.addEventListener('pointercancel', release);

  const button = (label, code, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pm-touch-btn ${cls}`;
    b.textContent = label;
    const up = () => { if (b.classList.contains('pm-touch-btn--down')) { b.classList.remove('pm-touch-btn--down'); key('keyup', code); } };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.classList.add('pm-touch-btn--down'); key('keydown', code); });
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up);
    return b;
  };

  root.append(stick, button('Dash', 'ShiftLeft', 'pm-touch-dash'), button('Act', 'Space', 'pm-touch-act'));
  container.appendChild(root);
  container.classList.add('pm-has-pad');
  return () => { release(); root.remove(); container.classList.remove('pm-has-pad'); };
}
