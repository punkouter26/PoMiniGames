// touch.js — on-screen sequence pad for touch devices (1P and online modes).
//
// Five buttons: the player's four sequence keys plus jump. Each tap dispatches a
// synthetic window keydown with the real key code, so the pad drives the exact
// same input paths a keyboard does — attachKeyboard (local) and the remote key
// forwarder (online) — with zero special-casing. Local 2P stays keyboard-only:
// two people can't share one phone.
import { LAYOUTS } from './input.js';

const KEY_LABELS = {
  KeyQ: 'Q', KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyE: 'JUMP',
  KeyI: 'I', KeyO: 'O', KeyK: 'K', KeyL: 'L', KeyP: 'JUMP',
};

/** True when the primary pointer is a finger. */
export function isTouchDevice() {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

export class TouchPad {
  /**
   * @param {HTMLElement} container the canvas host — the pad overlays its bottom edge
   * @param {1|2} layout which key layout to emit
   */
  constructor(container, layout = 1) {
    const map = LAYOUTS[layout] ?? LAYOUTS[1];
    this.root = document.createElement('div');
    this.root.className = 'ps-touchpad';
    this.root.setAttribute('aria-label', 'Sequence keys');

    for (const code of [...map.sequence, map.jump]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ps-touchpad-btn' + (code === map.jump ? ' ps-touchpad-btn--jump' : '');
      btn.textContent = KEY_LABELS[code] ?? code;
      // pointerdown, not click: a race is lost in the 300 ms a click can lag.
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
        btn.classList.add('ps-touchpad-btn--active');
      });
      // Release emits the matching keyup so the pad is a faithful keyboard stand-in.
      // PoSports itself only listens for keydown, but a synthetic press with no release
      // is a trap for any future listener that tracks held keys.
      const clear = () => {
        if (!btn.classList.contains('ps-touchpad-btn--active')) return;
        btn.classList.remove('ps-touchpad-btn--active');
        window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      };
      btn.addEventListener('pointerup', clear);
      btn.addEventListener('pointercancel', clear);
      btn.addEventListener('pointerleave', clear);
      this.root.appendChild(btn);
    }
    container.appendChild(this.root);
  }

  dispose() {
    this.root.remove();
  }
}
