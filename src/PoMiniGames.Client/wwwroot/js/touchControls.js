// touchControls.js — shared virtual-button overlay for keyboard-driven games.
// Renders clusters of round touch buttons (the same visual pattern PoBrawl's
// in-engine pb-touch overlay established) that press/release synthetic
// KeyboardEvents on `window`, so any game that reads `keydown`/`keyup` by
// `e.code` gains mobile controls without touching its input code.
//
// Buttons appear only on coarse-pointer devices or narrow portrait windows —
// desktop players never see them.

function touchEligible() {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches
    || window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches;
}

function sendKey(type, code, key) {
  window.dispatchEvent(new KeyboardEvent(type, { code, key: key || code, bubbles: true }));
}

/**
 * Create the overlay.
 * @param {Array<Array<{label: string, code: string, key?: string, small?: boolean}>>} groups
 *   Button clusters: first group pins bottom-left, last pins bottom-right.
 * @returns {{destroy: () => void} | null} null when not a touch layout.
 */
export function createTouchControls(groups) {
  if (!touchEligible()) return null;

  const root = document.createElement('div');
  root.className = 'ptc-root';

  for (const group of groups) {
    const cluster = document.createElement('div');
    cluster.className = 'ptc-cluster';
    for (const spec of group) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ptc-btn' + (spec.small ? ' ptc-btn--small' : '');
      btn.textContent = spec.label;
      btn.setAttribute('aria-label', spec.label);

      const press = (e) => {
        e.preventDefault();
        btn.classList.add('ptc-btn--held');
        sendKey('keydown', spec.code, spec.key);
      };
      const release = () => {
        if (!btn.classList.contains('ptc-btn--held')) return;
        btn.classList.remove('ptc-btn--held');
        sendKey('keyup', spec.code, spec.key);
      };
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', release);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      cluster.appendChild(btn);
    }
    root.appendChild(cluster);
  }

  document.body.appendChild(root);
  return {
    destroy() { root.remove(); },
  };
}

// Convenience presets for arrow/WASD-driven games (PoRacer et al).
export function createArrowTouchControls() {
  return createTouchControls([
    [
      { label: '◀', code: 'ArrowLeft', key: 'ArrowLeft' },
      { label: '▶', code: 'ArrowRight', key: 'ArrowRight' },
    ],
    [
      { label: '▼', code: 'ArrowDown', key: 'ArrowDown', small: true },
      { label: '▲', code: 'ArrowUp', key: 'ArrowUp' },
    ],
  ]);
}
