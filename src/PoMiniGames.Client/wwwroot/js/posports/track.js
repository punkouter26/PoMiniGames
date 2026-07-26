// track.js — Canvas 2D renderer for the PoSports meet: sky, crowd, the lanes,
// meter marks, hurdles, finish tape, and a leader-following camera. Pure drawing —
// it reads lane state, never mutates it.
import { CONSTANTS, HURDLE_POSITIONS } from './physics.js';

export const PX_PER_METER = 28;
/** Extra meters of track shown behind the start / past the finish. */
const APRON_METERS = 6;
/** Camera smoothing: fraction of the gap closed per second. */
const CAM_LERP = 4;

const LANE_COLORS = ['#b5533c', '#c05e43', '#b5533c', '#c05e43'];

export class TrackRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cameraX = -APRON_METERS; // meters at the left screen edge
    this.dpr = 1;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
  }

  resize() {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
  }

  /** Logical (CSS px) view size. */
  get viewW() { return this.canvas.width / this.dpr; }
  get viewH() { return this.canvas.height / this.dpr; }

  /** meters → screen x. */
  toX(m) { return (m - this.cameraX) * PX_PER_METER; }

  /** The y of a lane's ground line. Lanes stack from 26% down to the bottom apron. */
  laneY(lane, laneCount) {
    const top = this.viewH * 0.26;
    const bottom = this.viewH * 0.94;
    return top + ((lane + 1) / laneCount) * (bottom - top);
  }

  /** Sprite height for a lane row — nearer (lower) lanes draw slightly larger. */
  spriteHeight(lane, laneCount) {
    return this.viewH * (0.325 + 0.052 * (lane / Math.max(1, laneCount - 1)));
  }

  /** Follow the leading runner, keeping ~35% of the view behind the leader. */
  updateCamera(dt, lanes, legLength) {
    const leader = Math.max(0, ...lanes.map((l) => l.position));
    const target = Math.max(-APRON_METERS,
      Math.min(leader - (this.viewW * 0.35) / PX_PER_METER,
        legLength + APRON_METERS - this.viewW / PX_PER_METER));
    const k = 1 - Math.exp(-CAM_LERP * dt);
    this.cameraX += (target - this.cameraX) * k;
  }

  /**
   * Draw the full scene background + track for the current leg.
   * @param {'sprint'|'hurdles'} leg
   * @param {number} laneCount
   */
  drawScene(leg, laneCount) {
    const { ctx } = this;
    const w = this.viewW; const h = this.viewH;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Sky.
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.22);
    sky.addColorStop(0, '#7ec8f2');
    sky.addColorStop(1, '#cfeaf9');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h * 0.22);

    // Crowd strip: two rows of parallax dots.
    ctx.fillStyle = '#5d7a99';
    ctx.fillRect(0, h * 0.12, w, h * 0.10);
    for (let row = 0; row < 2; row++) {
      const y = h * (0.145 + row * 0.05);
      const size = 3 + row * 1.5;
      const speed = 0.35 + row * 0.3; // nearer row scrolls faster
      const offset = (this.cameraX * PX_PER_METER * speed) % 18;
      ctx.fillStyle = row === 0 ? '#8fa8c4' : '#a9bed6';
      for (let x = -offset; x < w; x += 18) {
        ctx.beginPath();
        ctx.arc(x, y + Math.sin((x + row * 7) * 0.7) * 2, size, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Track bed.
    ctx.fillStyle = '#a04a35';
    ctx.fillRect(0, h * 0.22, w, h * 0.78);

    const legLength = leg === 'hurdles' ? CONSTANTS.HURDLES_LENGTH : CONSTANTS.SPRINT_LENGTH;

    // Lane bands + lines.
    for (let i = 0; i < laneCount; i++) {
      const yTop = this.laneY(i - 1, laneCount);
      const yBot = this.laneY(i, laneCount);
      ctx.fillStyle = LANE_COLORS[i % LANE_COLORS.length];
      ctx.fillRect(0, yTop, w, yBot - yTop);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, yBot);
      ctx.lineTo(w, yBot);
      ctx.stroke();
    }

    // Meter marks every 10 m + start/finish.
    ctx.textAlign = 'center';
    ctx.font = `${Math.max(10, h * 0.02)}px system-ui, sans-serif`;
    for (let m = 0; m <= legLength; m += 10) {
      const x = this.toX(m);
      if (x < -40 || x > w + 40) continue;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = m === 0 || m === legLength ? 4 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, h * 0.22);
      ctx.lineTo(x, h * 0.94);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(`${m}`, x, h * 0.22 - 4);
    }

    // Finish tape.
    const fx = this.toX(legLength);
    if (fx > -20 && fx < w + 20) {
      ctx.fillStyle = '#fff';
      for (let y = h * 0.22; y < h * 0.94; y += 12) {
        ctx.fillRect(fx - 3, y, 6, 6);
        ctx.fillStyle = ctx.fillStyle === '#ffffff' ? '#222' : '#fff';
      }
    }

    // Hurdles.
    if (leg === 'hurdles') {
      for (const hm of HURDLE_POSITIONS) {
        const x = this.toX(hm);
        if (x < -20 || x > w + 20) continue;
        for (let i = 0; i < laneCount; i++) {
          const y = this.laneY(i, laneCount);
          const hh = this.spriteHeight(i, laneCount) * 0.42;
          ctx.strokeStyle = '#f5f5f5';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(x - 5, y);
          ctx.lineTo(x - 2, y - hh);
          ctx.lineTo(x + 6, y - hh);
          ctx.lineTo(x + 9, y);
          ctx.stroke();
          ctx.strokeStyle = '#d9d9d9';
          ctx.beginPath();
          ctx.moveTo(x - 2, y - hh);
          ctx.lineTo(x + 6, y - hh);
          ctx.stroke();
        }
      }
    }
  }

  /** Draw a name tag above a runner. */
  drawNameTag(name, x, y, isHuman) {
    const { ctx } = this;
    ctx.font = `600 ${Math.max(10, this.viewH * 0.022)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const w = ctx.measureText(name).width + 10;
    ctx.fillStyle = isHuman ? 'rgba(30,120,60,0.85)' : 'rgba(20,20,30,0.6)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 16, w, 16, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(name, x, y - 4);
  }
}
