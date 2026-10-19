// pocabinet/surfaces.js
//
// Procedural textures for the track's new surfaces (no image assets, so the service-worker
// precache stays small): gravel and beach sand for the traps, painted track-limit stripes for
// tarmac run-off, the road's patches (dust, repairs, dirt, standing water), the yellow and
// black chevrons on a divider's nose, and a soft-edged board atlas for trackside signs.
// Generated once per page from a fixed hash (never Math.random), cached per module.

import * as THREE from 'three';

function hash(x, y, seed) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Periodic value-noise fbm, size × size in [0, 1]. */
function fbm(size, base, octaves, seed) {
    const out = new Float32Array(size * size);
    let amp = 0.5, total = 0;
    for (let o = 0; o < octaves; o++) {
        const cells = base << o;
        for (let y = 0; y < size; y++) {
            const fy = y / size * cells, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
            for (let x = 0; x < size; x++) {
                const fx = x / size * cells, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
                const a = hash(x0 % cells, y0 % cells, seed + o), b = hash((x0 + 1) % cells, y0 % cells, seed + o);
                const c = hash(x0 % cells, (y0 + 1) % cells, seed + o), d = hash((x0 + 1) % cells, (y0 + 1) % cells, seed + o);
                out[y * size + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
            }
        }
        total += amp;
        amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
}

function dataTex(data, size, srgb) {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
}

function normalFrom(h, size, strength) {
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const l = h[y * size + (x - 1 + size) % size], r = h[y * size + (x + 1) % size];
            const u = h[((y - 1 + size) % size) * size + x], d = h[((y + 1) % size) * size + x];
            let nx = (l - r) * strength, ny = (u - d) * strength;
            const len = Math.hypot(nx, ny, 1);
            const i = (y * size + x) * 4;
            out[i] = (nx / len * 0.5 + 0.5) * 255;
            out[i + 1] = (ny / len * 0.5 + 0.5) * 255;
            out[i + 2] = (1 / len * 0.5 + 0.5) * 255;
            out[i + 3] = 255;
        }
    }
    return out;
}

const cache = new Map();
function once(key, make) {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key);
}

/** Gravel trap: rounded stones in a sandy bed. { map, normalMap } (tint with the material colour). */
export function gravel() {
    return once('gravel', () => {
        const S = 256;
        const bed = fbm(S, 8, 3, 301);
        const col = new Uint8Array(S * S * 4), height = new Float32Array(S * S);
        for (let i = 0; i < S * S; i++) {
            const v = 0.62 + (bed[i] - 0.5) * 0.3;
            col[i * 4] = v * 255; col[i * 4 + 1] = v * 240; col[i * 4 + 2] = v * 215; col[i * 4 + 3] = 255;
            height[i] = bed[i] * 0.2;
        }
        // Stones: discs of their own shade, stamped on a jittered grid (periodic, so it tiles).
        const G = 40;
        for (let gy = 0; gy < G; gy++) {
            for (let gx = 0; gx < G; gx++) {
                for (let k = 0; k < 2; k++) {
                    const cx = (gx + hash(gx, gy, 311 + k)) * S / G, cy = (gy + hash(gx, gy, 313 + k)) * S / G;
                    const r = 1.4 + hash(gx, gy, 317 + k) * 2.4;
                    const shade = 0.45 + hash(gx, gy, 319 + k) * 0.55;
                    const warm = hash(gx, gy, 323 + k);
                    for (let dy = -4; dy <= 4; dy++) {
                        for (let dx = -4; dx <= 4; dx++) {
                            const d = Math.hypot(dx, dy) / r;
                            if (d > 1) continue;
                            const x = ((Math.round(cx) + dx) % S + S) % S, y = ((Math.round(cy) + dy) % S + S) % S;
                            const i = y * S + x;
                            const lit = shade * (1.05 - d * 0.35 - dy / r * 0.12);
                            col[i * 4] = Math.min(255, lit * (225 + warm * 30));
                            col[i * 4 + 1] = Math.min(255, lit * (215 + warm * 10));
                            col[i * 4 + 2] = Math.min(255, lit * (200 - warm * 30));
                            height[i] = Math.max(height[i], Math.sqrt(1 - d * d) * r * 0.35);
                        }
                    }
                }
            }
        }
        return { map: dataTex(col, S, true), normalMap: dataTex(normalFrom(height, S, 2.2), S, false) };
    });
}

/** Beach sand: fine grain and wind ripples. { map, normalMap } */
export function sand() {
    return once('sand', () => {
        const S = 256;
        const grain = fbm(S, 64, 2, 331), low = fbm(S, 4, 3, 337);
        const col = new Uint8Array(S * S * 4), height = new Float32Array(S * S);
        for (let y = 0; y < S; y++) {
            for (let x = 0; x < S; x++) {
                const i = y * S + x;
                const ripple = Math.sin((y / S) * Math.PI * 2 * 9 + low[i] * 6) * 0.5 + 0.5;
                const v = 0.86 + (grain[i] - 0.5) * 0.16 + (low[i] - 0.5) * 0.1 - ripple * 0.04;
                col[i * 4] = Math.min(255, v * 255); col[i * 4 + 1] = Math.min(255, v * 236); col[i * 4 + 2] = Math.min(255, v * 196);
                col[i * 4 + 3] = 255;
                height[i] = ripple * 0.6 + grain[i] * 0.4;
            }
        }
        return { map: dataTex(col, S, true), normalMap: dataTex(normalFrom(height, S, 1.6), S, false) };
    });
}

/** A canvas texture (sRGB, repeating along v). */
function canvasTex(w, h, draw, repeat = true) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
}

/** Track-limit stripes painted on tarmac run-off: blocks of `a` and `b` along v. */
export function limitStripes(a, b) {
    return once(`stripes:${a}:${b}`, () => canvasTex(16, 64, (g) => {
        g.fillStyle = a; g.fillRect(0, 0, 16, 32);
        g.fillStyle = b; g.fillRect(0, 32, 16, 32);
    }));
}

/** Yellow and black chevrons (a divider's nose), repeating along u. */
export function chevrons() {
    return once('chevrons', () => canvasTex(128, 64, (g, w, h) => {
        g.fillStyle = '#f2c21b';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#141414';
        for (let k = -2; k < 4; k++) {
            g.beginPath();
            g.moveTo(k * 64, 0); g.lineTo(k * 64 + 32, 0); g.lineTo(k * 64 + 64, h); g.lineTo(k * 64 + 32, h);
            g.closePath();
            g.fill();
        }
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(0, h - 6, w, 6);
    }));
}

/**
 * Alpha masks (white = opaque) for the patches, tiling: `dust` drifts, `repairs` (patched
 * squares and cracks: colour + alpha), `puddle` (blobs of standing water).
 */
export function patchMask(kind) {
    return once(`mask:${kind}`, () => {
        const S = 256;
        const data = new Uint8Array(S * S * 4);
        if (kind === 'dust') {
            const a = fbm(S, 4, 4, 401), b = fbm(S, 32, 2, 409);
            for (let i = 0; i < S * S; i++) {
                const v = Math.min(1, Math.max(0, (a[i] - 0.38) * 2.6)) * (0.6 + b[i] * 0.6);
                data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v * 255;
                data[i * 4 + 3] = 255;
            }
        } else if (kind === 'puddle') {
            const a = fbm(S, 3, 4, 421);
            for (let i = 0; i < S * S; i++) {
                const v = Math.min(1, Math.max(0, (a[i] - 0.48) * 5));
                data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v * 255;
                data[i * 4 + 3] = 255;
            }
        } else {
            // dirt: mostly covered, thinning at the gaps
            const a = fbm(S, 6, 4, 431), b = fbm(S, 48, 2, 433);
            for (let i = 0; i < S * S; i++) {
                const v = Math.min(1, Math.max(0, (a[i] - 0.25) * 3)) * (0.75 + b[i] * 0.25);
                data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v * 255;
                data[i * 4 + 3] = 255;
            }
        }
        const t = dataTex(data, S, false);
        return t;
    });
}

/** Patched repairs: darker squares of new tarmac and tar-sealed cracks. map (sRGB, with alpha). */
export function repairs() {
    return once('repairs', () => canvasTex(256, 256, (g, w, h) => {
        g.clearRect(0, 0, w, h);
        let k = 0;
        const r = () => hash(k++, 7, 451);
        for (let i = 0; i < 9; i++) {
            const pw = 30 + r() * 70, ph = 24 + r() * 60, x = r() * (w - pw), y = r() * (h - ph);
            const s = Math.round(28 + r() * 22);
            g.fillStyle = `rgba(${s},${s},${s + 2},0.85)`;
            g.fillRect(x, y, pw, ph);
            g.strokeStyle = 'rgba(12,12,12,0.7)';
            g.lineWidth = 1.5;
            g.strokeRect(x, y, pw, ph);
        }
        g.strokeStyle = 'rgba(8,8,8,0.8)';
        for (let i = 0; i < 14; i++) {
            let x = r() * w, y = r() * h;
            g.lineWidth = 1 + r() * 1.6;
            g.beginPath();
            g.moveTo(x, y);
            for (let s = 0; s < 6; s++) {
                x += (r() - 0.5) * 40; y += (r() - 0.3) * 30;
                g.lineTo(x, y);
            }
            g.stroke();
        }
    }));
}

/**
 * One atlas for every trackside board: `labels` drawn into cells of `cell` px, returned with
 * the uv rect of each. style(label) → { bg, fg, border }.
 */
export function boardAtlas(labels, style, cell = 128) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(labels.length)));
    const rows = Math.max(1, Math.ceil(labels.length / cols));
    const W = cols * cell, H = rows * cell;
    const rects = [];
    const tex = canvasTex(W, H, (g) => {
        labels.forEach((label, i) => {
            const cx = (i % cols) * cell, cy = Math.floor(i / cols) * cell;
            const st = style(label);
            g.fillStyle = st.border || '#202226';
            g.fillRect(cx, cy, cell, cell);
            g.fillStyle = st.bg;
            g.fillRect(cx + 6, cy + 6, cell - 12, cell - 12);
            g.fillStyle = st.fg;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            let size = Math.floor(cell * (label.length > 2 ? 0.42 : 0.62));
            g.font = `900 ${size}px system-ui, sans-serif`;
            while (size > 10 && g.measureText(label).width > cell - 20) {
                size -= 2;
                g.font = `900 ${size}px system-ui, sans-serif`;
            }
            g.fillText(label, cx + cell / 2, cy + cell / 2 + 3);
            // uv: canvas y runs down, texture v up (flipY).
            rects.push({ u0: cx / W, u1: (cx + cell) / W, v0: 1 - (cy + cell) / H, v1: 1 - cy / H });
        });
    }, false);
    return { tex, rects };
}

/** A wide sign: `text` with an arrow pointing left (-1) or right (+1). */
export function arrowSign(text, dir, bg = '#f2c21b', fg = '#141414') {
    return once(`arrow:${text}:${dir}:${bg}`, () => canvasTex(512, 160, (g, w, h) => {
        g.fillStyle = '#141414';
        g.fillRect(0, 0, w, h);
        g.fillStyle = bg;
        g.fillRect(8, 8, w - 16, h - 16);
        g.fillStyle = fg;
        g.font = '900 78px system-ui, sans-serif';
        g.textBaseline = 'middle';
        const arrowW = 120;
        const tx = dir > 0 ? 36 : 36 + arrowW;
        g.textAlign = 'left';
        g.fillText(text, tx, h / 2 + 4);
        const ax = dir > 0 ? w - 36 - arrowW : 36, ay = h / 2;
        g.beginPath();
        if (dir > 0) {
            g.moveTo(ax, ay - 16); g.lineTo(ax + 64, ay - 16); g.lineTo(ax + 64, ay - 44); g.lineTo(ax + arrowW, ay);
            g.lineTo(ax + 64, ay + 44); g.lineTo(ax + 64, ay + 16); g.lineTo(ax, ay + 16);
        } else {
            g.moveTo(ax + arrowW, ay - 16); g.lineTo(ax + 56, ay - 16); g.lineTo(ax + 56, ay - 44); g.lineTo(ax, ay);
            g.lineTo(ax + 56, ay + 44); g.lineTo(ax + 56, ay + 16); g.lineTo(ax + arrowW, ay + 16);
        }
        g.closePath();
        g.fill();
    }, false));
}

/** The divider's nose sign: JOKER over a big arrow at the short lane (dir -1 left, +1 right). */
export function jokerPanel(dir) {
    return once(`joker:${dir}`, () => canvasTex(256, 200, (g, w, h) => {
        g.fillStyle = '#141414';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#f2c21b';
        g.fillRect(6, 6, w - 12, h - 12);
        g.fillStyle = '#141414';
        g.font = '900 64px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('JOKER', w / 2, 52);
        const cx = w / 2, cy = 138, s = dir > 0 ? 1 : -1;
        g.beginPath();
        g.moveTo(cx - s * 86, cy - 18); g.lineTo(cx + s * 16, cy - 18); g.lineTo(cx + s * 16, cy - 46);
        g.lineTo(cx + s * 86, cy); g.lineTo(cx + s * 16, cy + 46); g.lineTo(cx + s * 16, cy + 18); g.lineTo(cx - s * 86, cy + 18);
        g.closePath();
        g.fill();
    }, false));
}
