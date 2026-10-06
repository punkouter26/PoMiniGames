// PoMule renderer and frame loop.
//
// The rules live in C# (PoMiniGames.Shared/Games/PoMule). This module is the match's only
// clock: every tenth of a second of game time it calls OnTick on the page and gets back one
// flat snapshot array (layout: PoMuleMatch.Snapshot). During development it also runs the
// avatars (movement, collisions, the M.U.L.E. tether) and reports what they reached; the
// engine decides what that means. Nothing here changes cash, land or goods.
import * as W from './world.js';
import * as P from './physics.js';
import { drawWorld, drawMarket, drawPanorama, STRIP_H } from './render.js';
import { buildTouchControls, isTouchDevice } from './touch.js';

const TICK = 0.1;
const HEADER = 10, PER = 15;
const LAND = 0, AUCTION = 1, DEVELOP = 2, MARKET = 5, STANDINGS = 6, FINISHED = 7;
const GOAL_OUTFITTER = 1, GOAL_INSTALL = 2, GOAL_ASSAY = 3, GOAL_SURVEY = 4, GOAL_PUB = 5, GOAL_CHASE = 6;
const RADZEN_CSS_ID = 'pomule-radzen-css';
const MOVE_KEYS = { KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };

let g = null;

/**
 * Radzen's theme is global CSS, and until the rest of the app moves to Radzen it must only
 * be present while PoMule is. Resolves once the stylesheet and Radzen's script are in.
 */
function ensureRadzen() {
  const base = document.baseURI;
  const css = document.getElementById(RADZEN_CSS_ID) ? Promise.resolve() : new Promise((done) => {
    const link = document.createElement('link');
    link.id = RADZEN_CSS_ID;
    link.rel = 'stylesheet';
    link.href = new URL('_content/Radzen.Blazor/css/material-dark-base.css', base).href;
    link.onload = link.onerror = () => done();
    document.head.appendChild(link);
  });
  const js = window.Radzen ? Promise.resolve() : new Promise((done) => {
    const script = document.createElement('script');
    script.src = new URL('_content/Radzen.Blazor/Radzen.Blazor.js', base).href;
    script.onload = script.onerror = () => done();
    document.head.appendChild(script);
  });
  return Promise.all([css, js]).then(() => true);
}

function removeRadzen() {
  document.getElementById(RADZEN_CSS_ID)?.remove();
}

function call(method, ...args) {
  return g?.ref.invokeMethodAsync(method, ...args).catch(() => {});
}

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = g.host.clientWidth, h = g.host.clientHeight;
  g.canvas.width = Math.max(1, Math.round(w * dpr));
  g.canvas.height = Math.max(1, Math.round(h * dpr));
  g.view = { w, h, dpr, zoom: Math.max(0.2, (h - STRIP_H) / W.WORLD_H) };
}

/** Puts everyone outside a town door at the start of a development phase. */
function placeAvatars() {
  for (const a of g.avatars) {
    const door = W.TOWN_COLS[a.seat % 4] * W.TILE + W.TILE / 2;
    a.x = W.wrapX(door + (a.seat < 4 ? -22 : 22));
    a.y = (W.TOWN_ROW + 1) * W.TILE + 22;
    a.stamina = P.DASH_SECONDS;
    a.winded = false;
    a.dashing = false;
    a.mule = null;
    a.cooldown = 0;
    a.bumped = 0;
  }
  g.runaways = [];
  g.where = '';
}

function humanInput() {
  let dx = 0, dy = 0;
  for (const code of g.keys) {
    const m = MOVE_KEYS[code];
    if (m) { dx += m[0]; dy += m[1]; }
  }
  return { dx: Math.sign(dx), dy: Math.sign(dy), dash: g.keys.has('ShiftLeft') || g.keys.has('ShiftRight') };
}

function aiInput(a) {
  const kind = g.seat(a.seat, 11), target = g.seat(a.seat, 12);
  let tx, ty, dash = false;
  if (kind === GOAL_INSTALL || kind === GOAL_SURVEY) ({ x: tx, y: ty } = W.tileCenter(target));
  else if (kind === GOAL_OUTFITTER) ({ x: tx, y: ty } = W.nearestBuilding(a.x, W.OUTFITTER));
  else if (kind === GOAL_ASSAY) ({ x: tx, y: ty } = W.nearestBuilding(a.x, W.ASSAY));
  else if (kind === GOAL_PUB) ({ x: tx, y: ty } = W.nearestBuilding(a.x, W.PUB));
  else if (kind === GOAL_CHASE && target >= 0 && !g.avatars[target].out) {
    ({ x: tx, y: ty } = g.avatars[target]);
    dash = Math.hypot(W.wrapDelta(a.x, tx), ty - a.y) < 160;
  } else if (kind === GOAL_CHASE) {
    // Nobody to hit: stand in a town doorway and be in the way.
    ({ x: tx, y: ty } = W.nearestBuilding(a.x, W.OUTFITTER));
    ty += W.TILE / 2;
  } else return { dx: 0, dy: 0, dash: false };

  const s = P.steerToward(a, tx, ty, W.WORLD_W, 8);
  if (s.arrived && kind !== GOAL_CHASE && a.cooldown <= 0) {
    a.cooldown = 0.5; // one report per arrival; the next snapshot brings the next goal
    call('OnArrive', a.seat);
  }
  return { dx: s.dx, dy: s.dy, dash };
}

/** One slice of the development phase: move, collide, drag M.U.L.E.s, tell the engine. */
function simulate(dt) {
  for (const a of g.avatars) {
    const speed = g.seat(a.seat, 5);
    a.out = g.seat(a.seat, 8) === 1 || speed === 0;
    a.hasMule = g.seat(a.seat, 6) === 1;
    a.outfit = g.seat(a.seat, 7);
    a.cooldown -= dt;
    a.bumped -= dt;
    if (a.out) { a.mule = null; continue; }
    const input = a.seat === 0 && g.human ? humanInput() : aiInput(a);
    const terrain = g.terrain[W.tileAt(a.x, a.y).index];
    P.stepAvatar(a, input, dt, W.WORLD_W, W.WORLD_H, (speed / 100) * P.terrainFactor(terrain, a.species));
  }

  const reportBump = (a) => {
    if (!a.hasMule || a.bumped > 0) return;
    a.bumped = 1;
    call('OnBump', a.seat);
  };
  for (const b of P.resolveCollisions(g.avatars, W.WORLD_W)) {
    if (!b.dashA && !b.dashB) continue;
    reportBump(g.avatars[b.a]);
    reportBump(g.avatars[b.b]);
  }

  for (const a of g.avatars) {
    if (a.out || !a.hasMule) { a.mule = null; continue; }
    a.mule ??= { x: W.wrapX(a.x - a.facing * P.TETHER), y: a.y };
    if (P.stepTether(a.mule, a, dt, W.WORLD_W)) reportBump(a);
  }
  for (const r of g.runaways) { r.x = W.wrapX(r.x + r.vx * dt); r.life -= dt; }
  g.runaways = g.runaways.filter((r) => r.life > 0);

  if (g.human) {
    const me = g.avatars[0];
    const b = me.out ? null : W.buildingAt(me.x, me.y);
    const where = me.out ? '-1:0' : b ? `${b.kind}:0` : `3:${W.tileAt(me.x, me.y).index}`;
    if (where !== g.where) {
      g.where = where;
      const [kind, plot] = where.split(':').map(Number);
      call('OnWhere', kind, plot);
    }
  }
}

function followCamera(dt) {
  let target = g.cam.x;
  if (g.phase === DEVELOP) {
    // A demo follows whoever is still out on the map.
    const lead = g.human ? g.avatars[0] : g.avatars.find((a) => !a.out) ?? g.avatars[0];
    target = lead.x;
  } else if (g.phase === AUCTION && g.snap[4] >= 0) target = W.tileCenter(g.snap[4]).x;
  else if (g.phase === LAND && g.human) target = g.cursor.col * W.TILE + W.TILE / 2;
  else if (g.phase === LAND) target = g.cam.x + 60 * dt;
  g.cam.x = W.wrapX(g.cam.x + W.wrapDelta(g.cam.x, target) * Math.min(1, dt * 6));
}

function onSnapshot(snap) {
  const before = g.phase;
  g.snap = snap;
  g.phase = snap[1];
  if (g.phase === before) return;
  if (g.phase === DEVELOP) placeAvatars();
  if (g.phase === LAND && g.human) {
    const t = W.tileAt(g.cam.x, W.WORLD_H / 2);
    g.cursor = { col: t.col, row: t.row };
  }
  g.marketDir = 0;
  g.trades = [];
}

function frame(now) {
  if (!g?.running) return;
  g.raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - g.last) / 1000);
  g.last = now;
  // A phone held upright shows the rotate prompt; the match waits.
  g.paused = g.touch && window.matchMedia('(orientation: portrait)').matches;
  if (!g.paused) {
    const gameDt = dt * g.speed;
    g.time += dt;
    if (g.phase === DEVELOP) for (let left = gameDt; left > 0; left -= 0.05) simulate(Math.min(0.05, left));
    // Holding a direction (or the touch stick) walks the land cursor; key repeat is ignored.
    if (g.phase === LAND && g.human && (g.cursorWait -= dt) <= 0) { g.cursorWait = 0.12; moveCursor(); }
    followCamera(dt);
    for (const t of g.trades) t.life -= dt;
    g.trades = g.trades.filter((t) => t.life > 0);

    g.acc += gameDt;
    while (g.acc >= TICK) { g.acc -= TICK; g.pending++; }
    if (g.pending > 0 && !g.busy && g.phase !== FINISHED) {
      const n = Math.min(g.pending, 20);
      g.pending -= n;
      g.busy = true;
      g.ref.invokeMethodAsync('OnTick', n)
        .then((snap) => { if (g) { g.busy = false; onSnapshot(snap); } })
        .catch((e) => { console.error('[PoMule] tick failed', e); window.PoMule.stop(); });
    }
  }

  const ctx = g.ctx;
  ctx.setTransform(g.view.dpr, 0, 0, g.view.dpr, 0, 0);
  if (g.phase === MARKET) drawMarket(ctx, g, g.view);
  else drawWorld(ctx, g, g.view);
  drawPanorama(ctx, g, g.view);
}

function onKeyDown(e) {
  if (!g || e.target?.closest?.('input, textarea, select')) return;
  const move = MOVE_KEYS[e.code];
  if (move || e.code === 'Space') e.preventDefault();
  if (g.paused || !g.human) return;

  if (!e.repeat) {
    g.keys.add(e.code);
    if (move && g.phase === LAND) { moveCursor(); g.cursorWait = 0.3; }
    const digit = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
    if (e.code === 'Space' || e.code === 'Enter') {
      if (g.phase === LAND) call('OnLandPick', g.cursor.row * W.COLS + g.cursor.col);
      else if (g.phase === AUCTION) call('OnBid');
      else if (g.phase === DEVELOP) call('OnAction', 0);
      else if (g.phase === STANDINGS) call('OnSkip');
    } else if (digit >= 0 && g.phase === DEVELOP) call('OnAction', digit + 1);
  }
  sendMarketDir();
}

/** Steps the land cursor one tile in the held direction and tells the engine where it points. */
function moveCursor() {
  const { dx, dy } = humanInput();
  if (!dx && !dy) return;
  g.cursor.col = (g.cursor.col + dx + W.COLS) % W.COLS;
  g.cursor.row = Math.min(W.ROWS - 1, Math.max(0, g.cursor.row + dy));
  call('OnLandPick', g.cursor.row * W.COLS + g.cursor.col);
}

function onKeyUp(e) {
  if (!g) return;
  g.keys.delete(e.code);
  sendMarketDir();
}

function sendMarketDir() {
  if (g.phase !== MARKET || !g.human) return;
  const dir = -humanInput().dy; // up the screen is up in price
  if (dir !== g.marketDir) { g.marketDir = dir; call('OnMarketInput', dir); }
}

window.PoMule = {
  ensureRadzen,
  removeRadzen,

  /**
   * @param opts { terrain, peaks, species, colors: arrays; human: bool; speed: number;
   *               snapshot: the match's first snapshot }
   */
  start(containerId, dotnetRef, opts) {
    this.stop();
    const host = document.getElementById(containerId);
    if (!host) return false;
    const canvas = document.createElement('canvas');
    canvas.className = 'pm-canvas';
    host.appendChild(canvas);
    const plots = W.COLS * W.ROWS;
    g = {
      host, canvas, ctx: canvas.getContext('2d'), ref: dotnetRef,
      terrain: opts.terrain, peaks: opts.peaks, species: opts.species, colors: opts.colors,
      owner: new Array(plots).fill(-1), installed: new Array(plots).fill(-1), crystite: new Array(plots).fill(0),
      human: !!opts.human, speed: opts.speed || 1, seats: opts.species.length,
      snap: opts.snapshot, phase: -1, time: 0, acc: 0, pending: 0, busy: false, running: true, paused: false,
      keys: new Set(), cam: { x: W.TOWN_COLS[0] * W.TILE }, cursor: { col: W.TOWN_COLS[0], row: 2 },
      avatars: opts.species.map((species, seat) => ({ seat, species, mass: P.massOf(species), x: 0, y: 0, facing: 1, out: false })),
      runaways: [], trades: [], where: '', marketDir: 0, cursorWait: 0, touch: false, removeTouch: null,
      seat(seat, field) { return this.snap[HEADER + seat * PER + field]; },
    };
    placeAvatars();
    onSnapshot(opts.snapshot);
    resize();
    g.onResize = () => g && resize();
    window.addEventListener('resize', g.onResize);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    if (g.human && isTouchDevice()) {
      g.touch = true;
      g.removeTouch = buildTouchControls(host);
    }
    g.last = performance.now();
    g.raf = requestAnimationFrame(frame);
    return true;
  },

  /** Who owns what, what is installed where, and the Crystite the viewer is allowed to see. */
  setPlots(owner, installed, crystite) {
    if (!g) return;
    g.owner = owner;
    g.installed = installed;
    g.crystite = crystite;
  },

  /** A M.U.L.E. bolts from this seat's avatar and runs off. */
  runaway(seat) {
    const a = g?.avatars[seat];
    if (!a) return;
    g.runaways.push({ x: a.mule?.x ?? a.x, y: a.mule?.y ?? a.y, vx: -a.facing * 260, life: 2 });
    a.mule = null;
  },

  /** Flash a trade on the floor. A seat of -1 is the Store. */
  trade(seller, buyer, price) {
    g?.trades.push({ seller, buyer, price, life: 0.33 });
  },

  stop() {
    if (!g) return;
    g.running = false;
    cancelAnimationFrame(g.raf);
    window.removeEventListener('resize', g.onResize);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    g.removeTouch?.();
    g.canvas.remove();
    g = null;
  },
};

// Debug handle for the Playwright tests.
window.__pomule = () => g;
