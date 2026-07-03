// waves.js — Wave-based survival mode + between-wave shop (Feature #2).
// Replaces (and extends) the original "survive 100 s" survival with a proper
// 10-wave campaign. Each wave spawns more enemies at a higher base speed;
// clearing a wave opens a shop where kills-as-currency buy permanent
// upgrades (HP, weapon damage) or instant buffs (rapid fire, shield, nuke).
//
// The shop UI is rendered into the existing full-screen overlay — no extra
// DOM, no new CSS, no Blazor round-trips. UI is keyboard-friendly (1–6 to
// buy, Space/Enter to start the next wave).

import * as THREE from 'three';
import { sfx } from './audio.js';

/**
 * Shop catalogue. `apply` runs against the player state the orchestrator
 * passes in via the `effects` argument — keeping this module free of any
 * reference to the player object.
 */
export const SHOP_ITEMS = [
  {
    id: 'health',  icon: '❤', cost: 25,
    label: 'Health +1',
    desc:  'Restore or expand your HP pool',
    apply: (effects) => { effects.heal = 1; },
    max: 5,
  },
  {
    id: 'damage',  icon: '🔫', cost: 40,
    label: 'Weapon Damage +1',
    desc:  'Each shot carves a bigger sphere',
    apply: (effects) => { effects.bonusDamage = (effects.bonusDamage || 0) + 1; },
    max: 4,
  },
  {
    id: 'rapid',   icon: '⚡', cost: 20,
    label: 'Rapid Fire 10s',
    desc:  'Tightens the shot cooldown dramatically',
    apply: (effects) => { effects.addBuff = 'rapid_fire'; },
    max: 1,
  },
  {
    id: 'shield',  icon: '🛡', cost: 30,
    label: 'Shield 15s',
    desc:  'Negates one enemy hit',
    apply: (effects) => { effects.addBuff = 'shield'; },
    max: 1,
  },
  {
    id: 'spread',  icon: '✦', cost: 25,
    label: 'Spread Shot 10s',
    desc:  'Three pellets per shot in a tight cone',
    apply: (effects) => { effects.addBuff = 'spread'; },
    max: 1,
  },
  {
    id: 'nuke',    icon: '☢', cost: 100,
    label: 'Nuke',
    desc:  'Annihilates every enemy on screen',
    apply: (effects) => { effects.nuke = true; },
    max: 1,
  },
];

const TOTAL_WAVES = 10;

/**
 * @param {number} wave 1-based
 * @returns {{ count:number, speed:number, intervalMs:number }}
 *   Wave N: count = 5 + 2N, speed = 10 + 0.6N, spawn cadence tightens with N.
 */
export function waveSpec(wave) {
  const count = Math.min(28, 5 + 2 * wave);
  const speed = 10 + 0.6 * wave;
  const intervalMs = Math.max(900, 2400 - 140 * wave);
  return { count, speed, intervalMs };
}

export class WaveSystem {
  /**
   * @param {HTMLElement} overlay the existing fullscreen overlay element
   * @param {{
   *   onEnemySpawn: () => void,
   *   onNuke: () => number, // returns # of enemies destroyed (used for score)
   *   onSetSpeedFloor: (min:number) => void,
   *   onEndGame: (win:boolean, kills:number) => void,
   * }} callbacks
   */
  constructor(overlay, callbacks) {
    this.overlay = overlay;
    this.callbacks = callbacks;
    this.wave = 0;                  // 0 = not started; 1..TOTAL_WAVES active
    this.maxWave = TOTAL_WAVES;
    this.currency = 0;
    this.enemiesAlive = 0;
    this.enemiesToSpawn = 0;
    this.spawnTimerMs = 0;
    this.shopOpen = false;
    this.gameActive = false;
    this.purchased = new Set();     // item ids bought this run (limits one-shots)
    this.persistentLevels = { damage: 0, health: 0 };  // for rendering "owned" badges
  }

  /** Start a fresh run from wave 1. */
  start() {
    this.gameActive = true;
    this.wave = 0;
    this.currency = 0;
    this.enemiesAlive = 0;
    this.enemiesToSpawn = 0;
    this.spawnTimerMs = 0;
    this.purchased.clear();
    this.persistentLevels = { damage: 0, health: 0 };
    this._beginNextWave();
  }

  /** Add a defeated-enemy payout and check wave completion. */
  notifyEnemyKilled() {
    this.currency += 10;
    if (this.enemiesAlive > 0) this.enemiesAlive--;
    this._checkWaveComplete();
  }

  /** Add a smaller payout when the player just carves terrain voxels. */
  notifyTerrainCarved(count) {
    this.currency += Math.max(0, Math.floor(count / 4));
  }

  /** Track spawn so per-enemy movement respects the wave's speed floor. */
  notifyEnemySpawned(speedFloor) {
    this.callbacks.onSetSpeedFloor(speedFloor);
  }

  /** Tick the spawn clock — called once per frame from the orchestrator. */
  tickSpawn(dt) {
    if (!this.gameActive || this.shopOpen) return;
    if (this.enemiesToSpawn <= 0) return;
    this.spawnTimerMs -= dt * 1000;
    if (this.spawnTimerMs <= 0) {
      this.callbacks.onEnemySpawn();
      this.enemiesToSpawn--;
      this.enemiesAlive++;
      const spec = waveSpec(this.wave);
      this.spawnTimerMs = spec.intervalMs;
    }
  }

  /** Nuke credit: convert visible enemies to kills + currency. */
  applyNuke() {
    const killed = this.callbacks.onNuke();
    // Treat nuke as instant currency; each killed enemy is 10 + a flat +25 bonus.
    this.currency += killed * 10 + 25;
    this.enemiesAlive = Math.max(0, this.enemiesAlive - killed);
    this._checkWaveComplete();
  }

  _checkWaveComplete() {
    if (!this.gameActive) return;
    if (this.shopOpen) return;
    if (this.enemiesAlive <= 0 && this.enemiesToSpawn <= 0) {
      // Small delay so the last enemy death animation finishes before UI flips.
      setTimeout(() => {
        if (!this.gameActive) return;
        if (this.wave >= this.maxWave) {
          this._win();
        } else {
          this._openShop();
        }
      }, 900);
    }
  }

  _beginNextWave() {
    this.wave++;
    const spec = waveSpec(this.wave);
    this.enemiesToSpawn = spec.count;
    this.enemiesAlive = 0;
    this.spawnTimerMs = 250;       // let the first enemy spawn ~immediately
    this.shopOpen = false;
    this.callbacks.onSetSpeedFloor(spec.speed);
    sfx.waveStart();
  }

  // ── Shop UI ────────────────────────────────────────────────────────────
  _openShop() {
    this.shopOpen = true;
    this.callbacks.onWaveComplete?.(this.wave, this.maxWave);
    this._renderShop();
  }

  _renderShop() {
    const owned = [...this.purchased];
    this.overlay.style.display = 'flex';
    this.overlay.innerHTML = `
      <div style="text-align:center;color:#00D9FF;max-width:520px;padding:24px;background:rgba(0,5,20,.95);border:1px solid #00D9FF;border-radius:8px">
        <h2 style="letter-spacing:4px;margin:0 0 8px">WAVE ${this.wave} CLEAR</h2>
        <p style="color:#aaa;margin:0 0 18px">${this.wave >= this.maxWave ? 'Final wave cleared!' : `Next: ${this.wave + 1} / ${this.maxWave}`}</p>
        <p style="margin:0 0 18px;font-size:1.05rem">💰 <strong style="color:#fbbf24">${this.currency}</strong> credits</p>
        <div id="_vsShop" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
          ${SHOP_ITEMS.map((it, i) => this._renderShopItem(it, i + 1, owned)).join('')}
        </div>
        <button id="_vsNextWave" style="background:#4ade80;color:#000;border:none;padding:12px 32px;font-size:1rem;cursor:pointer;letter-spacing:2px;font-weight:bold;font-family:monospace">
          ▶ START WAVE ${this.wave + 1}
        </button>
        <p style="color:#555;font-size:11px;margin:14px 0 0">Keys 1–${SHOP_ITEMS.length}: buy · Enter: next wave</p>
      </div>`;
    this.overlay.querySelectorAll('button[data-shop]').forEach(b => {
      b.onclick = () => this._buy(b.dataset.shop);
    });
    this.overlay.querySelector('#_vsNextWave').onclick = () => this._closeShopAndAdvance();
  }

  _renderShopItem(item, hotkey, owned) {
    const disabled = this.currency < item.cost || this.purchased.has(item.id) || (item.max && this.purchased.has(item.id));
    const used = this.purchased.has(item.id);
    const btnColor = disabled ? '#444' : item.cost >= 100 ? '#FF3366' : item.cost >= 30 ? '#fbbf24' : '#4ade80';
    return `
      <button data-shop="${item.id}"
              ${disabled ? 'disabled' : ''}
              style="text-align:left;padding:10px;cursor:${disabled ? 'not-allowed' : 'pointer'};
                     border:1px solid ${disabled ? '#333' : btnColor};background:${disabled ? '#111' : '#0a1a2a'};
                     color:#eee;font-family:monospace">
        <div style="font-size:1.1rem;color:${btnColor}">${item.icon} ${item.label}${used ? ' ✓' : ''}</div>
        <div style="color:#888;font-size:11px;margin:2px 0">${item.desc}</div>
        <div style="color:${btnColor};font-size:.85rem">💰 ${item.cost} · [${hotkey}]</div>
      </button>`;
  }

  _buy(itemId) {
    if (!this.shopOpen) return;
    const item = SHOP_ITEMS.find(i => i.id === itemId);
    if (!item) return;
    if (this.currency < item.cost) return;
    if (this.purchased.has(item.id)) return;
    this.currency -= item.cost;
    this.purchased.add(item.id);
    if (item.id === 'health')  this.persistentLevels.health++;
    if (item.id === 'damage')  this.persistentLevels.damage++;
    sfx.shopBuy();
    // Apply the effect against the orchestrator-owned player state.
    const effects = {};
    item.apply(effects);
    this.callbacks.onShopPurchase?.(effects);
    this._renderShop();
  }

  _closeShopAndAdvance() {
    this.shopOpen = false;
    this.overlay.style.display = 'none';
    this._beginNextWave();
  }

  /** Public hook for the menu's START button. */
  startNext() {
    if (!this.shopOpen) return;
    this._closeShopAndAdvance();
  }

  /** Trapdoor back to the menu. */
  abort() {
    this.gameActive = false;
    this.shopOpen = false;
    this.wave = 0;
  }

  _win() {
    this.gameActive = false;
    sfx.waveWin();
    this.callbacks.onEndGame(true, this.currency / 10);
  }

  /** Called from the main loop when player HP hits zero. */
  onPlayerDefeated() {
    if (!this.gameActive) return;
    this.gameActive = false;
    this.shopOpen = false;
    this.callbacks.onEndGame(false, this.currency / 10);
  }

  /** Keyboard hook for the shop screen. */
  handleKey(code) {
    if (!this.shopOpen) return false;
    if (code === 'Enter' || code === 'Space') { this._closeShopAndAdvance(); return true; }
    if (code.startsWith('Digit') || code.startsWith('Numpad')) {
      const n = parseInt(code.replace('Digit', '').replace('Numpad', ''), 10);
      if (!isNaN(n) && n >= 1 && n <= SHOP_ITEMS.length) {
        this._buy(SHOP_ITEMS[n - 1].id);
        return true;
      }
    }
    return false;
  }
}
