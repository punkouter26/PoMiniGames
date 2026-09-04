// ===========================================================================
// Sand2 (Project Sub-Surface lineage) — native JS engine
//  - WebGL2 ping-pong cellular automata (support/stress pass + Margolus move
//    pass, 2..4 sub-steps per frame) for sand / water / shockwaves
//  - CPU-side rigid-body solver for connected concrete bars & inert bombs
//  - CPU-side slingshot ordnance integrator (TNT, water balloons)
// All high-frequency input is handled here; Blazor only pushes tool state.
// ===========================================================================

import * as SFX from './sand2-audio.js';
import { source as physicsSource } from './sand2-physics.glsl.js';
import { source as renderSource } from './sand2-render.glsl.js';

const W = 800, H = 600;
const AIR = 0, SAND = 1, CONCRETE = 2, WATER = 3, BEDROCK = 4;
const MATBYTE = [0, 60, 120, 180, 240];
const SAT_BYTE = 85;              // sand R byte for "pores hold one cell of water"
const BEDROCK_TOP = 8;            // texture rows 0..7 are bedrock baseline
const GRAVITY = 0.35;             // px/frame^2 for rigid projectiles
const SLING_K = 0.085;            // drag distance -> launch speed
const SLING_MAX = 13.5;           // px/frame launch speed cap
const TNT_FUSE_MS = 5000;
const TNT_BLAST_R = 63;     // 10x yield: energy scales with crater area (20 * sqrt(10))
const TNT_SHATTER_R = 100;  // measured to the bar's nearest surface
// Line-of-sight budget for a blast ray (see detonate). Loose ground is
// blown through almost freely; concrete and bedrock shield hard, so ~12 px
// of wall stops a ray outright while 100 px of sand does not.
const BLAST_SOLID_BUDGET = 120;
const BALLOON_R = 13;

let gl = null, canvas = null, overlay = null, octx = null;
let progSupport, progMove, progFall, progSurge, progRender;
let progLight, progBright, progBlur, progComposite, progParticle;
let tex = [null, null], fbo = [null, null], front = 0;
let mirror = new Uint8Array(W * H * 4);

// Post pipeline: scene FBO -> dynamic light field + bloom chain -> composite.
const LW = 400, LH = 300;          // light/bloom working resolution
let sceneTex, sceneFbo;
let lightTex = [null, null], lightFbo = [null, null], lightFront = 0;
let blurTex = [null, null], blurFbo = [null, null];
let heightTex;
let heightBytes = new Uint8Array(W * 4); // RGBA rows (RED uploads trip driver bugs)
let colH = new Float32Array(W).fill(300);
let vaoTri, vaoParticle, particleBuf;
const MAXP = 1400;
let particles = [];                // juice particles (sparks/dust/mist/bubbles)
let particleData = new Float32Array(MAXP * 7);
let rings = [];                    // shock-refraction rings {x,y,r,amp}
let flash = 0;                     // full-screen blast flash 0..1
let shakeEnergy = 0, shakeX = 0, shakeY = 0;
let frameNo = 0;
let uploadSwapsGB = false;         // driver quirk, probed once at init

let running = true, stepRequest = false;
let demo = false, demoTimer = 0;
let tool = 'dig', brush = 8;
let bodies = [];        // oriented rigid boxes {cx,cy,len,thick,angle,omega,vx,vy,kind,stamped}
let projectiles = [];   // {type,x,y,vx,vy,r,fuse,lit,rest}
let grains = [];        // ballistic ejecta {x,y,vx,vy,mat} — mass in flight
let counts = { sand: 0, water: 0 };
let countTimer = 999;
// Conservation audit: every particle that leaves the world does so through
// one of these counters (grains flying past an edge, cells draining out of
// the boundary columns), so totals are provable to the cell.
const audit = {
    stampWater: 0,
    grainDrainSand: 0, grainDrainWater: 0,
    cellDrainSand: 0, cellDrainWater: 0,
    depositFailSand: 0, depositFailWater: 0,
    splashSpawned: 0, discDisplaced: 0,
};
let parity = 0;
let surgeDir = 1;      // horizontal surge pass alternates direction each sub-step
let disableFall = false, disableSurge = false, moveDisable = 0; // diagnostic toggles
let quakes = [];       // expanding seismic tremor rings from big blasts
let rafId = 0, disposed = false;
let lastT = 0, avgDelta = 16.6, fps = 60, fpsFrames = 0, fpsTime = 0;

const mouse = { x: 0, y: 0, down: false, painting: false, lastX: 0, lastY: 0 };
let aimOrigin = null;    // {x,y} slingshot anchor (texture coords)
let barStart = null;     // {x,y} concrete-bar drag anchor

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function init(canvasEl, overlayEl) {
    canvas = canvasEl;
    overlay = overlayEl;
    octx = overlay.getContext('2d');
    octx.imageSmoothingEnabled = false;

    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, preserveDrawingBuffer: false });
    if (!gl) {
        octx.fillStyle = '#fff';
        octx.fillText('WebGL 2.0 is required.', 20, 20);
        return;
    }

    // Shader sources arrive as ES modules (see sand2-*.glsl.js) rather than a
    // runtime fetch: this page is routed at /sand2, so a relative 'js/…' fetch
    // would resolve against the route and 404.
    const phys = parseSections(physicsSource);
    const rend = parseSections(renderSource);
    [progSupport, progMove, progFall, progSurge, progRender,
        progLight, progBright, progBlur, progComposite, progParticle] = await buildPrograms([
        [phys.VERTEX, phys.SUPPORT], [phys.VERTEX, phys.MOVE],
        [phys.VERTEX, phys.FALL], [phys.VERTEX, phys.SURGE],
        [rend.VERTEX, rend.RENDER], [rend.VERTEX, rend.LIGHT],
        [rend.VERTEX, rend.BRIGHT], [rend.VERTEX, rend.BLUR],
        [rend.VERTEX, rend.COMPOSITE], [rend.PVERTEX, rend.PFRAG],
    ]);
    // buildPrograms yields to the event loop, so the component may have been
    // disposed (navigated away) while the driver was linking.
    if (disposed) return;

    // Full-screen quad.
    vaoTri = gl.createVertexArray();
    gl.bindVertexArray(vaoTri);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Additive point-sprite particles (interleaved x, y, size, r, g, b, a).
    vaoParticle = gl.createVertexArray();
    gl.bindVertexArray(vaoParticle);
    particleBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, particleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, particleData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 28, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(vaoTri);

    for (let i = 0; i < 2; i++) {
        tex[i] = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex[i]);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        fbo[i] = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[i]);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[i], 0);
    }

    // Post-processing render targets (linear-filtered for smooth sampling).
    const mkTarget = (w, h) => {
        const tx = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tx);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx, 0);
        return [tx, fb];
    };
    [sceneTex, sceneFbo] = mkTarget(W, H);
    for (let i = 0; i < 2; i++) {
        [lightTex[i], lightFbo[i]] = mkTarget(LW, LH);
        [blurTex[i], blurFbo[i]] = mkTarget(LW, LH);
    }
    // 800x1 column-surface-height strip driving the depth-ambient shading.
    heightTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, heightTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    reset();
    // Probe the texSubImage2D round trip: some drivers (SwiftShader) swap
    // the G and B bytes of sub-rect uploads into an RGBA8 render-target
    // texture. Compensate in every stampRegion upload when detected.
    {
        const probe = new Uint8Array([240, 11, 13, 255]); // bedrock cell (3,3)
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex[front]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 3, 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
        const back = new Uint8Array(4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[front]);
        gl.readPixels(3, 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, back);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        uploadSwapsGB = back[1] === 13 && back[2] === 11;
        if (uploadSwapsGB) console.warn('[subsurface] driver swaps G/B on uploads; compensating');
        // Restore the probed bedrock cell (G=B=0, swap-invariant).
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 3, 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE,
            new Uint8Array([240, 0, 0, 255]));
    }
    computeColumnHeights();
    attachInput();
    // Debug/verification hook: lets automated tests sample the simulation
    // grid (material ids, texture coords y-up) without touching the pipeline.
    window.__subsurface = {
        region: debugRegion,
        counts: debugCounts,
        projectiles: () => projectiles.map(p => ({ type: p.type, x: p.x, y: p.y, vx: p.vx, vy: p.vy })),
        bodies: () => bodies.map(b => ({
            cx: b.cx, cy: b.cy, len: b.len, thick: b.thick, angle: b.angle, kind: b.kind,
            vx: b.vx, vy: b.vy, omega: b.omega, fatigue: b.fatigue || 0,
        })),
        grains: () => grains.map(g => ({ x: g.x, y: g.y, vx: g.vx, vy: g.vy, mat: g.mat, delay: g.delay || 0 })),
        // Fire a shot at an exact cell, which the slingshot cannot do — the
        // depth-of-burial behaviour is only testable if the burst point can
        // be placed underground on purpose.
        detonate: (x, y) => detonate(Math.round(x), Math.round(y)),
        addBar: (x, y, w, h) => { const b = makeBarBody(x, y, w, h); stampBody(b); bodies.push(b); return bodies.length; },
        clearBodies: () => { for (const b of bodies) clearBody(b); bodies.length = 0; },
        paint: (x0, y0, w, h, mat, a) => stampRegion(x0, y0, w, h, () => [mat, a]),
        toggles: o => { disableFall = !!o.fall; disableSurge = !!o.surge; moveDisable = o.move | 0; },
        raw: (x0, y0, w, h) => {
            const out = new Array(w * h * 4);
            let i = 0;
            for (let y = y0; y < y0 + h; y++)
                for (let x = x0; x < x0 + w; x++) {
                    const mi = (Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 4;
                    out[i++] = mirror[mi]; out[i++] = mirror[mi + 1];
                    out[i++] = mirror[mi + 2]; out[i++] = mirror[mi + 3];
                }
            return out;
        },
    };
    lastT = performance.now();
    rafId = requestAnimationFrame(frame);
}

function debugRegion(x0, y0, w, h) {
    const out = new Array(w * h);
    let i = 0;
    for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++) out[i++] = matAt(x, y);
    return out;
}

// A grain is saturated when its R byte is the pore-water marker: the grain
// itself still counts as sand, and the cell of water sitting in its pore
// space still counts as water, so both totals stay exact as water soaks in
// and drains back out.
function isSaturatedByte(r) { return r >= SAT_BYTE && r <= 89; }

function recount() {
    let s = 0, w = 0;
    for (let i = 0; i < W * H * 4; i += 4) {
        const m = (mirror[i] + 30) / 60 | 0; // sand carries wetness in R
        if (m === SAND) { s++; if (isSaturatedByte(mirror[i])) w++; }
        else if (m === WATER) w++;
        // Steam carries water mass; it is double-signed (G >= 136 plus the
        // A=222 marker) so corrupted bytes can't forge phantom steam.
        else if (m === AIR && mirror[i + 1] >= 136 && Math.abs(mirror[i + 3] - 222) < 2) w++;
    }
    counts.sand = s;
    counts.water = w;
}

function debugCounts() {
    recount();
    let gs = 0, gw = 0;
    for (const g of grains) (g.mat === WATER ? gw++ : gs++);
    return { sand: counts.sand, water: counts.water, grainSand: gs, grainWater: gw, ...audit };
}

export function setTool(t) { tool = t; aimOrigin = null; barStart = null; }
export function setBrush(b) { brush = Math.max(1, Math.min(32, b | 0)); }
export function setPaused(p) { running = !p; }
export function setDemo(on) { demo = !!on; demoTimer = 0; }
export function stepOnce() { stepRequest = true; }
export function setAudio(on, vol) {
    SFX.setVolume(vol / 100);
    SFX.setMuted(!on);
    if (on) SFX.unlock();
}
export function dispose() { disposed = true; cancelAnimationFrame(rafId); SFX.dispose(); }

export function reset() {
    projectiles = [];
    grains = [];
    bodies = [];
    particles = [];
    rings = [];
    flash = 0;
    shakeEnergy = 0;
    aimOrigin = null;
    barStart = null;
    const data = buildScene();
    mirror.set(data);
    gl.bindTexture(gl.TEXTURE_2D, tex[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindTexture(gl.TEXTURE_2D, tex[1]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, data);
    front = 0;
    for (const b of bodies) stampBody(b); // embed the concrete bars
}

// ---------------------------------------------------------------------------
// Shader plumbing
// ---------------------------------------------------------------------------

function parseSections(src) {
    const sections = {};
    const parts = src.split(/\/\/======\s*([A-Z]+)\s*======/g);
    for (let i = 1; i < parts.length; i += 2) sections[parts[i]] = parts[i + 1].trim() + '\n';
    return sections;
}

const UNIFORM_NAMES = ['u_state', 'u_seed', 'u_parity', 'u_time', 'u_wind', 'u_disable', 'u_surgeDir',
    'u_light', 'u_heights', 'u_prev', 'u_lights', 'u_nlights',
    'u_scene', 'u_bloom', 'u_dir', 'u_texel', 'u_rings', 'u_nrings',
    'u_shake', 'u_flash'];

// Kick off compile + link for one program and query NOTHING: any status query
// forces the driver to finish that program on the spot, which is precisely the
// stall we are avoiding. Returns a handle for finishProgram().
function startProgram(vsSrc, fsSrc) {
    const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return sh;
    };
    const prog = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    return { prog, vs, fs };
}

// Resolve a started program: check status, drop the shaders, look up uniforms.
function finishProgram(h) {
    if (!gl.getShaderParameter(h.vs, gl.COMPILE_STATUS))
        throw new Error('Shader compile: ' + gl.getShaderInfoLog(h.vs));
    if (!gl.getShaderParameter(h.fs, gl.COMPILE_STATUS))
        throw new Error('Shader compile: ' + gl.getShaderInfoLog(h.fs));
    if (!gl.getProgramParameter(h.prog, gl.LINK_STATUS))
        throw new Error('Program link: ' + gl.getProgramInfoLog(h.prog));
    gl.deleteShader(h.vs);
    gl.deleteShader(h.fs);
    const out = { prog: h.prog };
    for (const n of UNIFORM_NAMES) out[n] = gl.getUniformLocation(h.prog, n);
    return out;
}

// Compile all ten programs at once and let the driver work in parallel, rather
// than blocking on each in turn (ported from Sand, which uses the same
// extension to chase its realism tiers in the background). Ten sequential
// link-and-query round trips is what pins the ANGLE/D3D11 shader compiler for
// a minute-plus on Snapdragon-class GPUs, with the tab frozen throughout;
// KHR_parallel_shader_compile lets the driver link them on its own threads
// while we yield the main thread between polls.
async function buildPrograms(specs) {
    const handles = specs.map(([vsSrc, fsSrc]) => startProgram(vsSrc, fsSrc));
    const par = gl.getExtension('KHR_parallel_shader_compile');
    if (par) {
        const done = h => gl.getProgramParameter(h.prog, par.COMPLETION_STATUS_KHR);
        // Bounded wait: a driver that never reports completion must not hang
        // the game forever — fall through and let finishProgram() block once.
        for (let i = 0; i < 600 && !handles.every(done); i++) {
            await new Promise(requestAnimationFrame);
        }
    }
    return handles.map(finishProgram);
}

function drawPass(pr, setUniforms) {
    gl.useProgram(pr.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex[front]);
    gl.uniform1i(pr.u_state, 0);
    if (setUniforms) setUniforms(pr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function runSubstep() {
    gl.viewport(0, 0, W, H);
    // Support / shockwave pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - front]);
    drawPass(progSupport, pr => gl.uniform1f(pr.u_seed, Math.random() * 97.0));
    front = 1 - front;
    // Margolus movement pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - front]);
    drawPass(progMove, pr => {
        gl.uniform1i(pr.u_parity, parity);
        gl.uniform1f(pr.u_seed, Math.random() * 97.0);
        gl.uniform1f(pr.u_wind, Math.sin(performance.now() * 0.00013) * 0.7);
        gl.uniform1i(pr.u_disable, moveDisable);
    });
    front = 1 - front;
    // Inertial fast-fall pass (sand with a built-up fall speed drops an
    // extra cell per sub-step).
    if (!disableFall) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - front]);
        drawPass(progFall, null);
        front = 1 - front;
    }
    // Horizontal surge pass: water carrying real momentum runs two extra
    // cells, so fronts out-pace the automaton and the fluid gets waves
    // instead of diffusion. One direction per sub-step keeps the gather
    // unambiguous; alternating keeps it even-handed.
    if (!disableSurge) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - front]);
        drawPass(progSurge, pr => gl.uniform1i(pr.u_surgeDir, surgeDir));
        front = 1 - front;
        surgeDir = -surgeDir;
    }
    parity = 1 - parity;
}

function readback() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[front]);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, mirror);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ---------------------------------------------------------------------------
// Mirror helpers (texture coords: x right, y UP, y=0 at bedrock)
// ---------------------------------------------------------------------------

// Steam carries real water mass (double-signed: G >= 136 plus the A = 222
// marker). Anything landing in a steam cell would therefore delete water, so
// every deposit path treats a steam cell as occupied rather than as free air.
function isSteamCell(x, y) {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    const i = (y * W + x) * 4;
    return mirror[i] === 0 && mirror[i + 1] >= 136 && Math.abs(mirror[i + 3] - 222) < 2;
}

// Air a grain may actually settle into: empty, and not full of steam.
function isFreeAir(x, y) { return matAt(x, y) === AIR && !isSteamCell(x, y); }

// Does the grain at this cell hold pore water?
function isWetCell(x, y) {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return isSaturatedByte(mirror[(y * W + x) * 4]);
}

function matAt(x, y) {
    if (y < 0) return BEDROCK;
    if (x < 0 || x >= W || y >= H) return AIR;
    return (mirror[(y * W + x) * 4] + 30) / 60 | 0;
}

function isSolid(m) { return m === SAND || m === CONCRETE || m === BEDROCK; }

// Rewrites a rectangular region of the front texture *and* the CPU mirror.
// fn(mat, a, x, y) returns:
//   null                     keep the cell
//   'loosen'                 keep material/velocity, strip cohesion (A=0)
//   [mat, a255, b?, g?]      rewrite; B/G default to the material's rest
//                            value (128/128 for water = zero velocity)
function stampRegion(x0, y0, w, h, fn) {
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
    const x1 = Math.min(W, (x0 + w) | 0), y1 = Math.min(H, (y0 + h) | 0);
    w = x1 - x0; h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    let changed = false;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const mi = ((y0 + y) * W + (x0 + x)) * 4;
            const m = (mirror[mi] + 30) / 60 | 0;
            const res = fn(m, mirror[mi + 3], x0 + x, y0 + y);
            if (res === 'loosen') {
                changed = true;
                mirror[mi + 3] = 0;
            } else if (res) {
                changed = true;
                if (m === WATER && res[0] !== WATER) audit.stampWater--;
                else if (m !== WATER && res[0] === WATER) audit.stampWater++;
                const rest = res[0] === WATER ? 128 : 0;
                // res[0] <= 4: material id; larger values are raw R bytes
                // (sand variants such as vitrified glass).
                mirror[mi] = res[0] > 10 ? res[0] : MATBYTE[res[0]];
                mirror[mi + 1] = res[3] !== undefined ? res[3] : rest;
                mirror[mi + 2] = res[2] !== undefined ? res[2] : rest;
                mirror[mi + 3] = res[1];
            }
        }
    }
    if (!changed) return; // no-op stamp: skip the GPU upload entirely
    // Upload the exact dirty rect, pinned to texture unit 0, compensating
    // the driver's upload byte order if the init-time probe detected that
    // texSubImage2D swaps G and B (seen on SwiftShader: fall speed bled
    // into the scorch channel, phantom-scorching sand that flash-boiled
    // passing water; blast shock bytes became phantom steam).
    const buf = new Uint8Array(w * h * 4);
    const gi = uploadSwapsGB ? 2 : 1, bi2 = uploadSwapsGB ? 1 : 2;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const mi = ((y0 + y) * W + (x0 + x)) * 4;
            const bo = (y * w + x) * 4;
            buf[bo] = mirror[mi];
            buf[bo + gi] = mirror[mi + 1];
            buf[bo + bi2] = mirror[mi + 2];
            buf[bo + 3] = mirror[mi + 3];
        }
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex[front]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
}

// ---------------------------------------------------------------------------
// Initial scene
// ---------------------------------------------------------------------------

function surfaceHeight(x) {
    // Terrain top in texture rows (bigger = higher). Base world row 300 -> y 299.
    let h = 299 + Math.round(4 * Math.sin(x * 0.021) + 3 * Math.sin(x * 0.0537 + 1.7));
    const d = Math.abs(x - 360);
    if (d < 130) h -= Math.round(90 * Math.pow(Math.cos((d / 130) * Math.PI / 2), 2)); // deep central basin
    return h;
}

function buildScene() {
    const data = new Uint8Array(W * H * 4);

    const set = (x, y, m, a) => {
        const i = (y * W + x) * 4;
        const rest = m === WATER ? 128 : 0; // zero velocity for water
        data[i] = MATBYTE[m];
        data[i + 1] = rest;
        data[i + 2] = rest;
        data[i + 3] = a;
    };

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (y < BEDROCK_TOP) set(x, y, BEDROCK, 255);
            else if (y <= surfaceHeight(x)) set(x, y, SAND, 255);
            else set(x, y, AIR, 0);
        }
    }

    // Big central reservoir: fills the deep basin up to a fixed water table.
    // Its bed sits only a dozen pixels above the tunnel maze below — breach
    // it and the lake floods the bottom galleries.
    const LAKE_LEVEL = 284;
    for (let x = 232; x <= 488; x++) {
        const h = surfaceHeight(x);
        for (let y = h + 1; y <= LAKE_LEVEL; y++) if (y < H) set(x, y, WATER, 0);
    }

    // Sealed sub-surface water pockets at varying depths. Roofs are authored
    // as ~45-degree peaks so every roof cell sits inside the Mohr-Coulomb
    // arching limit and the caverns are self-supporting from frame one.
    // Layout is randomized on every Reset so successive runs (or page
    // reloads) hand the player a different puzzle: a different count of
    // pockets, different sizes, different depths and lateral positions,
    // all chosen to avoid the reservoir bed, the sealed right-side lake,
    // and the support columns under each concrete bar.
    const barsEarly = [
        [500, 250, 140, 10], [100, 216, 110, 9], [430, 80, 9, 120], [560, 158, 140, 9],
    ];
    const pockets = [];
    const pocketCount = 3 + (Math.random() * 3 | 0); // 3..5
    let pGuard = 0;
    while (pockets.length < pocketCount && pGuard++ < 400) {
        const rx = 14 + (Math.random() * 12 | 0);
        const ry = 8 + (Math.random() * 6 | 0);
        // Pick a lateral band that is neither over the deep central basin
        // (the reservoir lives there) nor over the right-side sealed lake.
        let cx;
        for (let g = 0; g < 50; g++) {
            cx = 110 + Math.random() * 540;
            if (Math.abs(cx - 360) < 140) continue;           // reservoir band
            if (cx > 556 && cx < 704) continue;                // sealed lake band
            break;
        }
        // Vertical: anywhere in the stratum below the surface and above the
        // maze ceiling. Skip if too close to any bar's support column.
        const surfAtCx = surfaceHeight(cx);
        const cyTop = Math.max(BEDROCK_TOP + ry + 4, 30);
        const cyBot = Math.min(surfAtCx - ry - 8, 260);
        if (cyBot <= cyTop + 4) continue;
        const cy = cyTop + Math.random() * (cyBot - cyTop);
        // Reject if the pocket footprint crosses a bar's protected column.
        let blocked = false;
        for (const [bx, by, bw, bh] of barsEarly) {
            if (cx + rx + 16 > bx && cx - rx - 16 < bx + bw
                && cy + ry + 6 > by && cy - ry - 6 < by + bh + 80) { blocked = true; break; }
        }
        if (blocked) continue;
        // Reject if any other pocket is already too close (no overlap).
        let tooClose = false;
        for (const [px, py, prx, pry] of pockets) {
            if (Math.hypot((cx - px) / (prx + rx + 18), (cy - py) / (pry + ry + 14)) < 1) {
                tooClose = true; break;
            }
        }
        if (tooClose) continue;
        pockets.push([cx, cy, rx, ry]);
    }
    // Fallback: if rejection thinned the pocket set below the visual floor,
        // seed at least two well-known safe spots so the scene is never
        // completely empty of sub-surface water.
    if (pockets.length < 2) {
        if (!pockets.length) pockets.push([180, 150, 22, 12]);
        if (pockets.length < 2) pockets.push([600, 80, 22, 12]);
    }
    for (const [cx, cy, rx, ry] of pockets) {
        for (let dx = -rx; dx <= rx; dx++) {
            const x = cx + dx;
            const topH = Math.min(rx - Math.abs(dx), Math.round(ry * 1.4)); // 45° arch, small cap
            const botH = Math.round(ry * Math.sqrt(Math.max(0, 1 - (dx / rx) * (dx / rx))));
            for (let y = cy - botH; y <= cy + topH; y++)
                if (y >= BEDROCK_TOP && y < surfaceHeight(x) - 6) set(x, y, WATER, 0);
        }
    }

    // Embedded reinforced-concrete bars (registered as oriented rigid
    // bodies; stamped into the grid by reset() after the texture upload).
    const bars = [
        [500, 250, 140, 10], // near-surface horizontal, right side
        [100, 216, 110, 9],  // roof bar above the left water pocket
        [430, 80, 9, 120],   // vertical column, center
        [560, 158, 140, 9],  // deep horizontal, above the right water lake
    ];
    for (const [bx, by, bw, bh] of bars) bodies.push(makeBarBody(bx, by, bw, bh));

    // Wide right-side sub-surface water lake, sealed by the deep concrete bar
    // directly above it (its span exceeds the natural sand arching limit).
    for (let y = 108; y < 158; y++) {
        for (let x = 580; x <= 680; x++) {
            if (x > 622 && x < 638) continue; // central sand pillar: keeps the
            // roof bar's unsupported span under its bending limit
            const dx = (x - 630) / 50;
            const inRect = y >= 140;
            const inEll = !inRect && dx * dx + Math.pow((y - 140) / 32, 2) <= 1;
            if (inRect || inEll) set(x, y, WATER, 0);
        }
    }

    // ---- Ant-nest tunnel maze -------------------------------------------
    // Wandering, branching galleries with small chambers, carved through the
    // stratum. Passages stay 8-12px wide (well inside the Mohr-Coulomb
    // arching limit, so they are self-supporting) and steer clear of the
    // water pockets, the sealed lake, and the concrete bars.
    const avoid = (x, y) => {
        // Stay well clear of the open drain edges: collapse debris near them
        // feeds the edge sink and back-erodes whole corners of the map.
        if (x < 95 || x > 665 || y < 16) return true;
        // Lateral-aware clearance: on the basin's steep slopes the nearest
        // exposed face may be diagonal, so check neighbouring columns too.
        // The reservoir gets a much thicker bed (wet banks are weak).
        const minH = Math.min(surfaceHeight(x - 10), surfaceHeight(x), surfaceHeight(x + 10));
        if (y > minH - (Math.abs(x - 360) < 150 ? 26 : 14)) return true;
        for (const [px, py, prx, pry] of pockets)
            if (Math.pow((x - px) / (prx + 12), 2) + Math.pow((y - py) / (pry + 14), 2) <= 1) return true;
        if (x > 556 && x < 704 && y > 86 && y < 182) return true; // sealed lake
        // Keep the bars' full support columns intact, all the way down —
        // a tunnel anywhere beneath an end support eventually snaps the bar.
        for (const [bx, by, bw, bh] of bars)
            if (x > bx - 20 && x < bx + bw + 20 && y < by + bh + 10) return true;
        return false;
    };
    const carve = (cx2, cy2, r) => {
        for (let y = Math.round(cy2 - r); y <= Math.round(cy2 + r); y++)
            for (let x = Math.round(cx2 - r); x <= Math.round(cx2 + r); x++) {
                if (x < 0 || x >= W || y < BEDROCK_TOP || y >= H) continue;
                if ((x - cx2) * (x - cx2) + (y - cy2) * (y - cy2) > r * r) continue;
                if (avoid(x, y)) continue;
                const i = (y * W + x) * 4;
                if (data[i] === MATBYTE[SAND]) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; }
            }
    };
    const walkers = [];
    for (let k = 0; k < 6; k++) {
        walkers.push({
            x: 110 + Math.random() * 540,
            y: 50 + Math.random() * 190,
            ang: (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.8,
            left: 90 + Math.random() * 110,
        });
    }
    // Guarantee galleries running just beneath the reservoir bed, ready to
    // be breached, plus deep runs along the bottom of the map for flooding.
    walkers.push({ x: 310 + Math.random() * 60, y: 165 + Math.random() * 20, ang: (Math.random() - 0.5) * 0.5, left: 170 });
    walkers.push({ x: 350 + Math.random() * 60, y: 130 + Math.random() * 20, ang: Math.PI + (Math.random() - 0.5) * 0.5, left: 170 });
    walkers.push({ x: 250 + Math.random() * 200, y: 28 + Math.random() * 14, ang: (Math.random() < 0.5 ? 0 : Math.PI), left: 200 });
    let guard = 0;
    while (walkers.length && guard++ < 4000) {
        const wk = walkers[Math.random() * walkers.length | 0];
        carve(wk.x, wk.y, 4.5);
        wk.x += Math.cos(wk.ang) * 2;
        wk.y += Math.sin(wk.ang) * 2;
        wk.ang += (Math.random() - 0.5) * 0.45;
        wk.ang = Math.max(-1.1, Math.min(1.1, Math.abs(wk.ang) > Math.PI / 2 ? wk.ang : wk.ang)); // wobble freely
        wk.left -= 2;
        if (Math.random() < 0.015) carve(wk.x, wk.y, 7 + Math.random() * 2); // chamber
        if (Math.random() < 0.02 && walkers.length < 12)
            walkers.push({ x: wk.x, y: wk.y, ang: wk.ang + (Math.random() < 0.5 ? 1 : -1) * (0.8 + Math.random() * 0.7), left: 50 + Math.random() * 90 });
        if (wk.left <= 0 || wk.x < 100 || wk.x > 660 || wk.y < 20 || wk.y > 270)
            walkers.splice(walkers.indexOf(wk), 1);
    }
    // Vertical arteries tie the gallery levels together (ant nests run deep),
    // placed clear of the bars' protected support columns. Number and x
    // positions are randomized each Reset (clamped to 2..4 arteries, none
    // under a bar).
    const arteryCount = 2 + (Math.random() * 3 | 0); // 2..4
    const arteries = [];
    let aGuard = 0;
    while (arteries.length < arteryCount && aGuard++ < 80) {
        const ax = 130 + Math.random() * 520;
        let underBar = false;
        for (const [bx, by, bw, bh] of bars) {
            if (ax > bx - 28 && ax < bx + bw + 28
                && 200 > by - 20 && 200 < by + bh + 80) { underBar = true; break; }
        }
        if (underBar) continue;
        let dup = false;
        for (const px of arteries) if (Math.abs(px - ax) < 28) { dup = true; break; }
        if (dup) continue;
        arteries.push(ax);
    }
    for (const ax of arteries) {
        const jx = ax + (Math.random() - 0.5) * 14;
        const phase = Math.random() * 6.28;
        for (let y = 200; y > 26; y -= 2) carve(jx + Math.sin(y * 0.09 + phase) * 4, y, 4);
    }

    // Worm-holes: many thin, wiggly, mostly-vertical passages riddling the
    // stratum (the classic porous "ant farm" look).
    for (let k = 0; k < 26; k++) {
        let wx = 105 + Math.random() * 550;
        let wy = 40 + Math.random() * 200;
        let wang = -Math.PI / 2 + (Math.random() - 0.5) * 1.2; // downward bias
        const phase = Math.random() * 10;
        const len = 40 + Math.random() * 90;
        for (let s = 0; s < len; s += 2) {
            carve(wx, wy, 2.5 + Math.random() * 1.5);
            const steer = Math.sin(s * 0.18 + phase) * 0.9;
            wx += Math.cos(wang + steer) * 2;
            wy += Math.sin(wang + steer) * 2;
            if (wy < 22 || wy > 275) break;
        }
    }

    // Scattered small cavities: porous pockets and vugs of varied size.
    for (let k = 0; k < 90; k++) {
        const hx = 105 + Math.random() * 550;
        const hy = 25 + Math.random() * 230;
        carve(hx, hy, 2 + Math.random() * 5);
    }

    // Two or three nest entrances: shafts from the open surface down into the
    // maze, well clear of the reservoir's waterline. Entrance columns are
    // randomized each Reset (2..3 entrances, none in the reservoir band,
    // none through a bar's support column, none too close to each other).
    const entranceCount = 2 + (Math.random() < 0.5 ? 0 : 1); // 2 or 3
    const entrances = [];
    let eGuard = 0;
    while (entrances.length < entranceCount && eGuard++ < 80) {
        const ex = 130 + Math.random() * 520;
        if (Math.abs(ex - 360) < 140) continue;               // reservoir band
        let underBar = false;
        for (const [bx, by, bw, bh] of bars) {
            if (ex > bx - 20 && ex < bx + bw + 20) { underBar = true; break; }
        }
        if (underBar) continue;
        let dup = false;
        for (const px of entrances) if (Math.abs(px - ex) < 80) { dup = true; break; }
        if (dup) continue;
        entrances.push(ex);
    }
    while (entrances.length < 2) entrances.push([175, 655][entrances.length]);
    for (const ex of entrances) {
        const top = surfaceHeight(ex);
        const phase = Math.random() * 6.28;
        for (let y = top + 2; y > 225; y -= 2) {
            const wob = ex + Math.sin(y * 0.15 + phase) * 3;
            for (let yy = Math.round(y) - 2; yy <= Math.round(y) + 2; yy++)
                for (let x = Math.round(wob) - 4; x <= Math.round(wob) + 4; x++) {
                    if (x < 0 || x >= W || yy < BEDROCK_TOP || yy >= H) continue;
                    const i = (yy * W + x) * 4;
                    if (data[i] === MATBYTE[SAND]) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; }
                }
        }
    }
    return data;
}

// ---------------------------------------------------------------------------
// Oriented rigid-body engine. Bodies are rotated boxes (concrete bars and
// rubble chunks) stamped into the grid as concrete cells. They fall, tip
// over when their center of mass leaves the support span (torque about the
// pivot contact), snap under bending load, and shatter into tumbling chunks.
// Coordinates: cx/cy = center (texture coords, y-up); vy positive = downward.
// ---------------------------------------------------------------------------

function makeBarBody(x, y, w, h) {
    return {
        cx: x + (w - 1) / 2, cy: y + (h - 1) / 2,
        len: Math.max(w, h), thick: Math.min(w, h),
        angle: w >= h ? 0 : Math.PI / 2,
        omega: 0, vx: 0, vy: 0,
        kind: 'bar', stamped: [], snapTimer: (Math.random() * 15) | 0,
    };
}

// Rasterize the oriented box into integer cells.
function bodyCells(b, cx = b.cx, cy = b.cy, angle = b.angle) {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const hl = (b.len - 1) / 2 + 0.49, ht = (b.thick - 1) / 2 + 0.49;
    const ex = Math.abs(ca) * hl + Math.abs(sa) * ht + 1;
    const ey = Math.abs(sa) * hl + Math.abs(ca) * ht + 1;
    const cells = [];
    for (let y = Math.round(cy - ey); y <= Math.round(cy + ey); y++) {
        for (let x = Math.round(cx - ex); x <= Math.round(cx + ex); x++) {
            const dx = x - cx, dy = y - cy;
            const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
            if (Math.abs(u) <= hl && Math.abs(v) <= ht) cells.push(x, y);
        }
    }
    return cells;
}

function ownSetOf(b) {
    const s = new Set();
    for (let i = 0; i < b.stamped.length; i += 2) s.add(b.stamped[i + 1] * W + b.stamped[i]);
    return s;
}

function clearBody(b) {
    const st = b.stamped;
    if (!st.length) return;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    const s = ownSetOf(b);
    for (let i = 0; i < st.length; i += 2) {
        x0 = Math.min(x0, st[i]); x1 = Math.max(x1, st[i]);
        y0 = Math.min(y0, st[i + 1]); y1 = Math.max(y1, st[i + 1]);
    }
    stampRegion(x0, y0, x1 - x0 + 1, y1 - y0 + 1, (m, a, x, y) =>
        (m === CONCRETE && s.has(y * W + x)) ? [AIR, 0] : null);
    b.stamped = [];
}

function stampBody(b) {
    const cells = bodyCells(b);
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    const s = new Set();
    for (let i = 0; i < cells.length; i += 2) {
        const x = cells[i], y = cells[i + 1];
        if (x < 0 || x >= W || y < BEDROCK_TOP || y >= H) continue;
        s.add(y * W + x);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (!s.size) { b.stamped = []; return; }
    let displaced = 0;
    stampRegion(x0, y0, x1 - x0 + 1, y1 - y0 + 1, (m, a, x, y) => {
        if (!s.has(y * W + x) || m === BEDROCK) return null;
        // Pore water in saturated ground, and the water steam is carrying,
        // are displaced exactly like standing water when a body takes the cell.
        if (m === WATER || (m === SAND && isWetCell(x, y)) || isSteamCell(x, y)) displaced++;
        return [CONCRETE, 255];
    });
    b.stamped = cells;
    // Conserve displaced water: splash a few droplets on a hard entry, seat
    // the rest in the open cells just above the body.
    if (displaced > 0) {
        if (Math.abs(b.vy) > 2.5) {
            const drops = Math.min(6, displaced);
            for (let k = 0; k < drops; k++) {
                grains.push({
                    x: b.cx + (Math.random() - 0.5) * b.len * 0.7, y: y1 + 1,
                    vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 3, mat: WATER,
                });
            }
            displaced -= drops;
        }
        // Seat the remainder in the open cells above (up to the free surface
        // when the body is submerged) in a single region write.
        let surfY = y1 + 1;
        const midX = Math.round((x0 + x1) / 2);
        while (surfY < H - 1 && !isFreeAir(midX, surfY)) surfY++;
        const seat = (m, a, sx, sy) => {
            if (displaced > 0 && m === AIR && !isSteamCell(sx, sy)) { displaced--; return [WATER, 0]; }
            return null;
        };
        stampRegion(x0, y1 + 1, x1 - x0 + 1, Math.min(H - (y1 + 1), surfY - y1 + 4), seat);
        if (displaced > 0) stampRegion(x0, y1 + 1, x1 - x0 + 1, H - (y1 + 1), seat);
        if (displaced > 0) audit.depositFailWater += displaced; // audited exit
    }
}

// Try to move/rotate a body to a new pose; blocked by any solid cell that
// is not currently its own. Returns true when the pose was applied.
// On failure blockCell holds the cell that stopped it, so an impact can find
// out WHAT it hit and hand over momentum.
let blockCell = -1;

function tryPose(b, ncx, ncy, nangle) {
    const own = ownSetOf(b);
    const cells = bodyCells(b, ncx, ncy, nangle);
    for (let i = 0; i < cells.length; i += 2) {
        const x = cells[i], y = cells[i + 1];
        if (x < 0 || x >= W) continue;          // may slide off the open sides
        if (y < BEDROCK_TOP) { blockCell = -1; return false; }
        if (y >= H) continue;
        if (isSolid(matAt(x, y)) && !own.has(y * W + x)) { blockCell = y * W + x; return false; }
    }
    blockCell = -1;
    clearBody(b);
    b.cx = ncx; b.cy = ncy; b.angle = nangle;
    stampBody(b);
    return true;
}

// Which body (if any) owns a given cell. Only ever called on an impact, so
// the linear scan costs nothing in the common case.
function bodyAtCell(k, skip) {
    for (const b of bodies) {
        if (b === skip) continue;
        for (let i = 0; i < b.stamped.length; i += 2)
            if (b.stamped[i + 1] * W + b.stamped[i] === k) return b;
    }
    return null;
}

// Lift one sand cell out of the grid and throw it as a ballistic grain.
// Mass-conserving by construction: the cell is only spawned if it was really
// removed, so an impact spray can never create material.
function ejectSandCell(x, y, vx, vy, spawnX = x) {
    if (x < 0 || x >= W || y < BEDROCK_TOP || y >= H) return false;
    const wet = isWetCell(x, y);
    let ok = false;
    stampRegion(x, y, 1, 1, m => {
        if (m !== SAND) return null;
        ok = true;
        return [AIR, 0];
    });
    if (ok) {
        grains.push({ x: spawnX, y, vx, vy, mat: SAND });
        // Saturated ground sprays its pore water out with the grain.
        if (wet) grains.push({ x: spawnX, y, vx: vx * 0.7, vy: vy * 1.1, mat: WATER });
    }
    return ok;
}

// Shove one grain out from under a body and pile it up alongside — the bow
// wave a slab raises either side of itself as it presses into soft ground.
// The grain is re-deposited rather than thrown, so it cannot simply land back
// on the body that displaced it.
function bermSandCell(x, y, edgeX, dir) {
    if (x < 0 || x >= W || y < BEDROCK_TOP || y >= H) return false;
    const wet = isWetCell(x, y);
    let ok = false;
    stampRegion(x, y, 1, 1, m => {
        if (m !== SAND) return null;
        ok = true;
        return [AIR, 0];
    });
    if (!ok) return false;
    const tx = Math.max(0, Math.min(W - 1, Math.round(edgeX + dir * (1 + Math.random() * 4))));
    depositGrain({ x: tx, y, vx: 0, vy: 0, mat: SAND });
    if (wet) depositGrain({ x: tx, y, vx: 0, vy: 0, mat: WATER });
    return true;
}

// A body hitting something. Real impacts are not dead stops: momentum goes
// into whatever was struck, the ground under the contact face is shocked out
// of its packing and sprays, the body beds into the divot it just made, and a
// brittle bar dropped hard enough simply breaks. Returns true when the body
// no longer exists (it broke), so the caller must stop touching it.
function bodyImpact(b, bi) {
    const v = b.vy;
    // Momentum transfer: if another body is what stopped us, hand it a share.
    // Without this a struck stack freezes solid the instant the top piece
    // lands, instead of collapsing in sequence.
    const hit = blockCell >= 0 ? bodyAtCell(blockCell, b) : null;
    if (hit && v > 1) {
        hit.vy += v * 0.45;
        hit.vx += b.vx * 0.45;
        // Sign matters: elsewhere in this solver a NEGATIVE omega puts the
        // body's right end down, so a hit landing left of the target's centre
        // must ADD omega to drive the struck side down. Getting this backwards
        // made the target try to rotate up into the very body that hit it,
        // the pose was refused, and the momentum vanished.
        hit.omega -= Math.max(-0.05, Math.min(0.05, (b.cx - hit.cx) * 0.0009 * v));
        b.vy *= 0.55;
    }
    if (b.vy <= 3) {
        b.vy = (b.kind === 'chunk' && b.vy > 2.5) ? -b.vy * 0.25 : 0;
        b.omega *= 0.4;
        return false;
    }
    SFX.thud(Math.min(1, b.vy / 9));
    spawnDust(b.cx, b.cy, Math.min(12, b.len >> 2));

    const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
    const hl = (b.len - 1) / 2, vb = -((b.thick - 1) / 2 + 1);
    const face = u => [Math.round(b.cx + u * ca - vb * sa), Math.round(b.cy + u * sa + vb * ca)];
    // Ground shock along the contact face: the packing under a hard landing
    // is destroyed, and some of it is thrown clear as spray.
    let thrown = 0;
    let bx0 = W, bx1 = 0;
    for (let i = 0; i < b.stamped.length; i += 2) {
        if (b.stamped[i] < bx0) bx0 = b.stamped[i];
        if (b.stamped[i] > bx1) bx1 = b.stamped[i];
    }
    for (let u = -hl; u <= hl; u += 1) {
        const [x, y] = face(u);
        stampRegion(x - 1, y - 2, 3, 3, m => (m === SAND ? 'loosen' : null));
        // Spray squirts out from the EDGES of the contact face: ground under
        // the middle of a slab has nowhere to go, and a grain launched there
        // just hits the underside and drops straight back.
        if (thrown < 14 && b.vy > 4.5 && Math.abs(u) > hl * 0.6 &&
            Math.random() < 0.40 * Math.min(1, b.vy / 8)) {
            const dir = u < 0 ? -1 : 1;
            const edge = dir < 0 ? bx0 : bx1;
            if (ejectSandCell(x, y, dir * (1.5 + Math.random() * b.vy * 0.45),
                              0.6 + Math.random() * b.vy * 0.3, edge + dir * 2)) thrown++;
        }
    }
    // Bedding in: a compact body drives itself into soft ground rather than
    // perching on top of it, and the ground it displaces has to go somewhere —
    // it heaps up along both flanks as a bow wave.
    if (b.vy > 5 && b.len <= 48) {
        for (let k = 0, sink = Math.min(2, Math.floor(b.vy / 5)); k < sink; k++) {
            let moved = 0;
            for (let u = -hl; u <= hl; u += 1) {
                const [x, y] = face(u);
                const dir = u < 0 ? -1 : 1;
                if (bermSandCell(x, y, dir < 0 ? bx0 : bx1, dir)) moved++;
            }
            if (!moved || !tryPose(b, b.cx, b.cy - 1, b.angle)) break;
        }
    }
    // Brittle failure: concrete dropped hard enough breaks on landing. Only
    // a real span breaks; a compact block just beds in.
    if (b.kind === 'bar' && b.len >= 50 && b.vy > 7 && Math.random() < 0.75) {
        const parts = splitBody(b, bi, (Math.random() - 0.5) * b.len * 0.5);
        if (parts) {
            for (const q of parts) {
                q.vy = b.vy * 0.2;
                q.omega = (Math.random() - 0.5) * 0.12;
            }
            return true;
        }
    }
    b.vy = (b.kind === 'chunk' && b.vy > 2.5) ? -b.vy * 0.25 : 0;
    b.omega *= 0.4;
    return false;
}

function bodyContacts(b) {
    const own = ownSetOf(b);
    const contacts = [];
    for (let i = 0; i < b.stamped.length; i += 2) {
        const x = b.stamped[i], y = b.stamped[i + 1];
        if (!own.has((y - 1) * W + x) && isSolid(matAt(x, y - 1))) contacts.push(x, y);
    }
    return contacts;
}

function stepBody(b, bi) {
    const contacts = bodyContacts(b);
    const inWater = matAt(Math.round(b.cx), Math.round(b.cy)) === WATER;

    if (contacts.length === 0 && b.stamped.length) {
        // Free flight: gravity, drag/buoyancy, tumbling. Light debris is
        // buoyant and bobs up to float at the surface.
        if (inWater && b.buoyant) b.vy = Math.max(b.vy - 0.35, -2.2);
        else b.vy = Math.min(b.vy + (inWater ? 0.12 : 0.55), inWater ? 2 : 8);
        if (inWater) { b.vx *= 0.9; b.omega *= 0.9; }
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(b.vx), Math.abs(b.vy), Math.abs(b.omega) * b.len)));
        for (let s = 0; s < n; s++) {
            if (tryPose(b, b.cx + b.vx / n, b.cy - b.vy / n, b.angle + b.omega / n)) continue;
            if (tryPose(b, b.cx + b.vx / n, b.cy - b.vy / n, b.angle)) { b.omega *= -0.1; continue; }
            if (tryPose(b, b.cx, b.cy - b.vy / n, b.angle)) { b.vx *= -0.3; continue; }
            // Vertical contact: momentum transfer, ground shock, bedding in,
            // and brittle failure (bodyImpact returns true if b broke apart).
            if (bodyImpact(b, bi)) return;
            break;
        }
        return;
    }

    if (!contacts.length) return; // fully out of bounds

    // Grounded: friction, then check static stability (COM over support?).
    b.vy = 0;
    b.vx *= 0.8;
    if (Math.abs(b.vx) > 0.3 && !tryPose(b, b.cx + Math.sign(b.vx), b.cy, b.angle)) b.vx = 0;

    let minX = Infinity, maxX = -Infinity, px = 0, py = 0;
    for (let i = 0; i < contacts.length; i += 2) {
        if (contacts[i] < minX) minX = contacts[i];
        if (contacts[i] > maxX) maxX = contacts[i];
    }
    let tipping = 0;
    if (b.cx < minX - 1.5) { tipping = 1; px = minX; }
    else if (b.cx > maxX + 1.5) { tipping = 1; px = maxX; }

    // A body that is statically stable can still be SPINNING: a blast impulse
    // or a hit from another body puts real angular momentum into it. Rotation
    // used to happen only while tipping, so that momentum was silently thrown
    // away and a shoved bar just sat there. Now it rocks, and rocks off its
    // perch if the shove was hard enough.
    const spun = !tipping && Math.abs(b.omega) > 0.006;
    if (spun) px = b.omega > 0 ? minX : maxX;

    if (tipping || spun) {
        for (let i = 0; i < contacts.length; i += 2)
            if (contacts[i] === px) py = contacts[i + 1];
        // Gravity torque about the pivot contact (CCW positive, y-up).
        if (tipping) b.omega += -(b.cx - px) * 0.0022;
        b.omega = Math.max(-0.2, Math.min(0.2, b.omega));
        const steps = Math.max(1, Math.ceil(Math.abs(b.omega) * b.len / 1.5));
        for (let s = 0; s < steps; s++) {
            const d = b.omega / steps;
            const co = Math.cos(d), si = Math.sin(d);
            const rx = b.cx - px, ry = b.cy - py;
            const ncx = px + rx * co - ry * si;
            const ncy = py + rx * si + ry * co;
            if (!tryPose(b, ncx, ncy, b.angle + d)) { b.omega *= 0.1; break; }
        }
        if (spun) b.omega *= 0.82;   // rocking friction bleeds it off
    } else {
        b.omega *= 0.5;
        if (Math.abs(b.omega) < 0.004) b.omega = 0;
    }

    // Bending failure: a roughly-horizontal bar snaps where an overhang or
    // an unsupported mid-span exceeds its flexural capacity.
    if (b.kind === 'bar' && b.len >= 50 && Math.abs(Math.sin(b.angle)) < 0.4 && ++b.snapTimer >= 15) {
        b.snapTimer = 0;
        checkBendingSnap(b, bi);
    }
}

const CANTILEVER_LIMIT = 35;
const SPAN_LIMIT = 90;

function checkBendingSnap(b, bi) {
    const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
    const own = ownSetOf(b);
    const hu = Math.round((b.len - 1) / 2);
    const vb = -((b.thick - 1) / 2 + 1.2); // just below the bottom edge
    const sup = [];
    for (let u = -hu; u <= hu; u++) {
        const x = Math.round(b.cx + u * ca - vb * sa);
        const y = Math.round(b.cy + u * sa + vb * ca);
        sup.push(isSolid(matAt(x, y)) && !own.has(y * W + x));
    }
    const n = sup.length;
    let first = sup.indexOf(true);
    let last = sup.lastIndexOf(true);
    if (first < 0) return; // free-falling; handled elsewhere
    // Rebar plasticity: repeated overloads fatigue the bar, lowering its
    // snap threshold; a sub-critical overhang makes it droop visibly first.
    b.fatigue = b.fatigue || 0;
    // Flexural capacity goes with the SQUARE of section depth, so a thin slab
    // sags and snaps over a span a deep beam carries without noticing.
    // Normalised to the 8px section the placement tool draws by default, so
    // the authored scene (9-10px bars) is unchanged or slightly stronger.
    const tScale = Math.pow(Math.max(2, b.thick) / 8, 2);
    const cant = CANTILEVER_LIMIT * tScale - Math.min(12, b.fatigue * 0.6);
    const span = SPAN_LIMIT * tScale - Math.min(25, b.fatigue * 1.2);
    const overL = first, overR = n - 1 - last;
    const worst = Math.max(overL, overR);
    if (worst > cant * 0.55 && worst <= cant) {
        b.fatigue++;
        const dir = overL >= overR ? 1 : -1; // droop the free end downward
        const px = overL >= overR ? b.cx + (first - hu) * ca : b.cx + (last - hu) * ca;
        const py = overL >= overR ? b.cy + (first - hu) * sa : b.cy + (last - hu) * sa;
        const d = dir * 0.008;
        const co = Math.cos(d), si = Math.sin(d);
        const rx = b.cx - px, ry = b.cy - py;
        tryPose(b, px + rx * co - ry * si, py + rx * si + ry * co, b.angle + d);
    }
    let splitU = null;
    if (overL > cant) splitU = first;              // left overhang
    else if (overR > cant) splitU = last;          // right overhang
    else {
        let run = 0, runStart = 0;
        for (let i = first; i <= last; i++) {
            if (!sup[i]) { if (run === 0) runStart = i; run++; if (run > span) { splitU = runStart + (run >> 1); break; } }
            else run = 0;
        }
    }
    if (splitU === null) return;
    splitBody(b, bi, splitU - hu);
}

function splitBody(b, bi, uSplit) {
    const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
    const hl = (b.len - 1) / 2;
    const lenA = Math.round(uSplit + hl);
    const lenB = b.len - lenA;
    if (lenA < 4 || lenB < 4) return null;
    clearBody(b);
    bodies.splice(bi, 1);
    const mk = (uMid, len) => ({
        cx: b.cx + uMid * ca, cy: b.cy + uMid * sa,
        len, thick: b.thick, angle: b.angle,
        omega: 0, vx: 0, vy: 0,
        kind: len >= 50 ? 'bar' : 'chunk', stamped: [], snapTimer: 0,
    });
    const A = mk((-hl + (lenA - 1) / 2), lenA);
    const B = mk((uSplit + (lenB - 1) / 2), lenB);
    stampBody(A); stampBody(B);
    bodies.push(A, B);
    SFX.snap();
    spawnDust(b.cx, b.cy, 10);
    return [A, B];
}

function updateBodies() {
    for (let bi = bodies.length - 1; bi >= 0; bi--) stepBody(bodies[bi], bi);
}

// A blast wave does not sort structures into "destroyed" and "untouched" at a
// hard radius. Close in, concrete is pulverised; at middle distance it
// fractures into a few large pieces; out at the fringe it survives but is
// left damaged, and the next overload finishes it. Everything inside the
// shell is shoved by the impulse whether or not it breaks.
function applyImpulse(b, cx, cy, imp) {
    const ang = Math.atan2(b.cy - cy, b.cx - cx);
    // Heavier sections move less for the same impulse; capped so a small
    // fragment is flung hard rather than teleported.
    const k = Math.min(9, imp / Math.max(0.8, (b.len * b.thick) / 140));
    b.vx += Math.cos(ang) * k;
    b.vy -= Math.sin(ang) * k;   // vy > 0 is downward, so an upward push is negative
    b.omega = Math.max(-0.35, Math.min(0.35, b.omega + (Math.random() - 0.5) * k * 0.05));
}

function pulverizeBody(b, i, cx, cy, minLen, spread) {
    const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
    const hl = (b.len - 1) / 2;
    clearBody(b);
    bodies.splice(i, 1);
    SFX.shatter();
    spawnDust(b.cx, b.cy, 16);
    spawnSparks(b.cx, b.cy, 6, 3);
    let u = -hl;
    while (u < hl) {
        const clen = Math.min(minLen + (Math.random() * spread | 0), hl - u + 1);
        const uMid = u + (clen - 1) / 2;
        const ccx = b.cx + uMid * ca, ccy = b.cy + uMid * sa;
        const ang = Math.atan2(ccy - cy, ccx - cx) + (Math.random() - 0.5) * 0.6;
        const spd = 2 + Math.random() * 3.5;
        const chunk = {
            cx: ccx, cy: ccy, len: clen, thick: Math.min(b.thick, 6),
            angle: b.angle, omega: (Math.random() - 0.5) * 0.3,
            vx: Math.cos(ang) * spd,
            vy: -(Math.sin(ang) * spd + 1 + Math.random() * 2), // vy>0 = down
            kind: 'chunk', stamped: [], snapTimer: 0,
            buoyant: Math.random() < 0.2, // light charred debris floats
        };
        stampBody(chunk);
        bodies.push(chunk);
        u += clen;
    }
}

function blastBodies(cx, cy, S) {
    for (let i = bodies.length - 1; i >= 0; i--) {
        const b = bodies[i];
        // Nearest distance from the blast to the body's actual cells — bars
        // are only fractured by direct blasts, never through overburden.
        let near = Infinity;
        for (let k = 0; k < b.stamped.length; k += 8)
            near = Math.min(near, Math.hypot(b.stamped[k] - cx, b.stamped[k + 1] - cy));
        if (near >= S) continue;
        const imp = 30 / (1 + Math.pow(near / 16, 2));
        if (near < S * 0.35) {
            // Pulverised: gravel close in, rubble a little further out.
            pulverizeBody(b, i, cx, cy, near < S * 0.18 ? 3 : 4, near < S * 0.18 ? 3 : 5);
        } else if (near < S * 0.7 && b.len >= 24) {
            // Fractured into two or three large pieces that are thrown clear.
            const parts = splitBody(b, i, (Math.random() - 0.5) * b.len * 0.6);
            if (!parts) { applyImpulse(b, cx, cy, imp); continue; }
            for (const q of parts) applyImpulse(q, cx, cy, imp * 0.8);
            if (Math.random() < 0.5) {
                const big = parts[0].len >= parts[1].len ? parts[0] : parts[1];
                if (big.len >= 24) {
                    const p2 = splitBody(big, bodies.indexOf(big), (Math.random() - 0.5) * big.len * 0.6);
                    if (p2) for (const q of p2) applyImpulse(q, cx, cy, imp * 0.8);
                }
            }
        } else {
            // Survived, but damaged: fatigue lowers its snap threshold, so a
            // repeatedly shelled bar eventually fails under its own load.
            b.fatigue = (b.fatigue || 0) + 3;
            applyImpulse(b, cx, cy, imp);
        }
    }
}

// ---------------------------------------------------------------------------
// Ordnance
// ---------------------------------------------------------------------------

function detonate(cx, cy) {
    const submerged = matAt(cx, cy) === WATER;
    // Mass-conserving blast: nothing is destroyed. Every sand/water cell in
    // the blast radius is converted into a ballistic grain, then re-deposited
    // wherever it lands.
    //
    // Depth of burial governs everything else about a real shot. A surface
    // burst vents most of its energy to the air: a wide shallow scoop, a big
    // airblast, not much ejecta. Burial couples the charge to the ground and
    // crater volume peaks near 0.55 R of overburden. Bury it deeper still and
    // nothing vents at all — the shot leaves a sealed camouflet cavity and
    // lifts the ground above it into a heave dome instead of throwing ejecta,
    // which is why deep rounds mound the surface rather than crater it.
    computeColumnHeights(); // exact overburden, not the every-other-frame copy
    const burial = Math.max(0, colH[Math.max(0, Math.min(W - 1, cx))] - cy);
    const dob = burial / TNT_BLAST_R;                      // scaled depth of burst
    const coupling = Math.exp(-Math.pow((dob - 0.55) / 0.45, 2));
    const vent = Math.max(0, Math.min(1, 1.15 - dob * 1.05)); // fraction that escapes
    const R = Math.round(TNT_BLAST_R * (0.62 + 0.55 * coupling));
    const R2 = R + Math.round(10 + 26 * vent); // pressure shell: heave + fluid impulse

    // Line-of-sight reach (from Sand): a blast may only excavate what it can
    // actually see. Without this the crater formed in full on the far side of
    // a concrete wall — the per-cell "concrete resists the direct crater" test
    // spared the wall itself and then dug out everything behind it, so a
    // bunker gave no protection at all. Each of 360 rays walks outward and
    // stops once it has chewed through its budget of solid.
    const reach = new Float32Array(360);
    {
        const step = (Math.PI * 2) / 360;
        for (let a = 0; a < 360; a++) {
            const ux = Math.cos(a * step), uy = Math.sin(a * step);
            let solid = 0, t = 2;
            for (; t < R2; t += 2) {
                const m = matAt(Math.round(cx + ux * t), Math.round(cy + uy * t));
                if (m === SAND) solid += 1;             // blown through
                else if (m === CONCRETE || m === BEDROCK) solid += 20;  // shields
                if (solid > BLAST_SOLID_BUDGET) break;
            }
            reach[a] = t;
        }
    }

    const ejecta = [];
    stampRegion(cx - R2, cy - R2, 2 * R2 + 1, 2 * R2 + 1, (m, a, x, y) => {
        const d = Math.hypot(x - cx, y - cy);
        if (d > R2) return null;
        let ai = Math.round(Math.atan2(y - cy, x - cx) * 180 / Math.PI);
        if (ai < 0) ai += 360;
        if (d > reach[ai % 360]) return null;           // shielded
        if (d <= R) {
            const shock = Math.round(255 * (1 - 0.25 * d / R));
            // Deep water in the fireball flashes to an expanding steam
            // bubble (it carries the water's mass and condenses back);
            // shallower water is thrown as spray.
            if (m === WATER && Math.random() < 0.55) return [AIR, 222, shock, 235]; // marked steam
            if (m === SAND || m === WATER) {
                ejecta.push([x, y, d, m]);
                // Wet ground throws its pore water out along with the grain.
                if (m === SAND && isWetCell(x, y)) ejecta.push([x, y, d, WATER]);
                return [AIR, 0, shock];
            }
            if (m === AIR) {
                // Steam in the fireball keeps its G byte: it carries real
                // water mass, and flattening it to smoke would destroy that
                // mass unaudited (overlapping blasts leaked ~90 cells each).
                const gb = mirror[(y * W + x) * 4 + 1];
                const wasSteam = gb >= 136 && Math.abs(mirror[(y * W + x) * 4 + 3] - 222) < 2;
                return wasSteam ? [AIR, 222, shock, gb] : [AIR, 0, shock, 95];
            }
            return null; // concrete & bedrock resist the direct crater
        }
        // Vitrified crater rim: the fireball fuses the first shell of sand
        // into a glassy lining.
        if (m === SAND && d <= R + 3) {
            // Fusing wet ground boils its pore water off as steam-borne
            // spray rather than deleting it.
            if (isWetCell(x, y)) grains.push({
                x, y, mat: WATER,
                vx: (x - cx) / d * 2, vy: (y - cy) / d * 2 + 2,
            });
            return [82, a, 0, 250];
        }
        // Shell: the ground shock heaves loose surface material and shoves
        // the surrounding water outward (momentum, not destruction).
        const fall = 1 - (d - R) / (R2 - R);
        const ox = (x - cx) / d, oy = (y - cy) / d;
        if (m === WATER) {
            const g = Math.max(0, Math.min(255, Math.round(128 + ox * 62 * fall)));
            const bv = Math.max(0, Math.min(255, Math.round(128 + oy * 62 * fall)));
            return [WATER, 0, bv, g];
        }
        if (m === SAND && Math.random() < 0.4 * fall &&
            (matAt(x, y + 1) === AIR || matAt(x - 1, y) === AIR || matAt(x + 1, y) === AIR)) {
            // Surface skin in the shell is thrown as low-speed hot dust.
            grains.push({
                x, y, mat: SAND, hot: true,
                vx: ox * (1 + 2 * Math.random()),
                vy: oy * (1 + 2 * Math.random()) + 1.5 + Math.random(),
            });
            // Heaved wet ground carries its pore water up with it.
            if (isWetCell(x, y)) grains.push({ x, y, mat: WATER, vx: ox * 1.5, vy: oy * 1.5 + 2 });
            return [AIR, 0, 0];
        }
        return null;
    });
    computeColumnHeights(); // the crater just changed the surface
    // Material that cannot vent has to go somewhere: it lifts the overburden.
    // Stacking it on top of the column raises the ground into the dome a
    // buried shot really makes, and leaves the cavity below to collapse later.
    const heave = x0 => {
        const hx = Math.max(0, Math.min(W - 1, Math.round(x0)));
        depositGrain({ x: hx, y: colH[hx], vx: 0, vy: 0, mat: SAND });
    };
    for (const [x, y, d, m] of ejecta) {
        if (m === SAND && Math.random() > vent) {
            heave(cx + (Math.random() + Math.random() - 1) * R * 1.3);
            continue;
        }
        // Real excavation flows outward over time and leaves the ground as an
        // inverted cone: near-vertical over the centre, about 45 degrees at
        // the rim, and later the further out it starts. Staging the launches
        // turns the old instantaneous starburst into a curtain that grows.
        const t = Math.min(1, d / Math.max(1, R));
        const side = (x === cx) ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(x - cx);
        const ang = Math.PI * 0.5 * (1 - t) + Math.PI * 0.25 * t;
        const spd = (5 + 10 * (1 - t)) * (0.6 + 0.8 * Math.random()) * (0.35 + 0.65 * vent);
        // Blast sand flies as red-hot embers and lands as scorched, slowly
        // cooling ground.
        grains.push({
            x, y, mat: m, hot: m === SAND,
            vx: Math.cos(ang) * side * spd + (Math.random() - 0.5),
            vy: Math.sin(ang) * spd + 1.0 + Math.random(),
            delay: Math.round(t * 8 + Math.random() * 2),
        });
    }
    // Air-blast wind (from Sand): the expanding pressure wave shoves every
    // grain already in flight, so an earlier ejecta curtain or a settling dust
    // cloud billows away from the new blast instead of sailing through it
    // untouched. A camouflet, venting nothing, barely stirs the air.
    const windR = R2 * 2;
    for (const g of grains) {
        const d = Math.hypot(g.x - cx, g.y - cy);
        if (d > windR || d < 0.5) continue;
        const push = 3.0 * (1 - d / windR) * (0.15 + 0.85 * vent);
        g.vx += ((g.x - cx) / d) * push;
        g.vy += ((g.y - cy) / d) * push * 0.5;
    }

    // Air-blast impulse knocks nearby ordnance flying (from Sand), so a stack
    // of live bombs scatters instead of sitting politely inside the fireball
    // waiting its turn. The detonating bomb itself is still in the list here —
    // it sits at d ~ 0 and is skipped, then spliced out by the caller.
    const kickR = R2 * 2.2;
    for (const q of projectiles) {
        const d = Math.hypot(q.x - cx, q.y - cy);
        if (d > kickR || d < 0.5) continue;
        const kick = 9 * (1 - d / kickR) * (0.15 + 0.85 * vent);
        q.vx += ((q.x - cx) / d) * kick;
        q.vy += ((q.y - cy) / d) * kick + 0.9;
        q.rest = 0;
    }

    blastBodies(cx, cy, Math.round(TNT_SHATTER_R * (0.55 + 0.45 * coupling)));
    // Seismic ground wave: an expanding tremor ring shakes marginal ground
    // loose well beyond the crater over the following half-second.
    // A well-coupled buried shot shakes far more ground than a surface burst,
    // and vents far less light and airblast.
    quakes.push({ cx, cy, f: 0, k: 0.55 + 0.9 * coupling });
    shakeEnergy = Math.max(shakeEnergy, 0.45 + 0.55 * coupling);
    flash = Math.min(1, flash + (submerged ? 0.45 : 0.8) * (0.2 + 0.8 * vent));
    rings.push({ x: cx, y: cy, r: 6, amp: (submerged ? 5 : 9) * (0.35 + 0.65 * vent) });
    if (rings.length > 4) rings.shift();
    spawnBlastParticles(cx, cy, submerged, vent);
    const depth = Math.max(0, Math.min(1,
        (colH[Math.max(0, Math.min(W - 1, cx))] - cy) / 140));
    SFX.boom({ submerged, depth });
    // Phone haptics scaled by what actually vented (from Sand).
    try { navigator.vibrate?.(Math.round(50 + 130 * vent)); } catch { /* unsupported */ }
}

function updateQuakes() {
    for (let i = quakes.length - 1; i >= 0; i--) {
        const q = quakes[i];
        q.f++;
        const rad = TNT_BLAST_R + 30 + q.f * 12;
        const prob = 0.22 * (1 - q.f / 11) * (q.k || 1);
        stampRegion(q.cx - rad, q.cy - rad, 2 * rad + 1, 2 * rad + 1, (m, a, x, y) => {
            if (m !== SAND) return null;
            const d = Math.hypot(x - q.cx, y - q.cy);
            if (d < rad - 8 || d > rad) return null;
            return Math.random() < prob ? 'loosen' : null;
        });
        if (q.f >= 10) quakes.splice(i, 1);
    }
}

function depositGrain(g) {
    const x = Math.round(g.x);
    if (x < 0 || x >= W) return; // over the open lateral boundary: drained
    let y = Math.max(BEDROCK_TOP, Math.round(Math.min(g.y, H - 1)));
    // Hard impacts shake the struck surface loose (secondary disturbance).
    if (g.mat === SAND && Math.hypot(g.vx, g.vy) > 6 && Math.random() < 0.4) {
        stampRegion(x - 1, y - 2, 3, 3, m => m === SAND ? 'loosen' : null);
    }
    if (g.mat === SAND) {
        // Settle at the first non-solid cell above the contact point. If that
        // cell holds water, the displaced water is pushed up to the surface,
        // so total water is conserved.
        while (y < H && isSolid(matAt(x, y))) y++;
        if (y >= H) { audit.depositFailSand++; return; }
        // Steam counts as displaced water: condensing it back out is what
        // keeps a blast that boiled the ground mass-exact once its own ejecta
        // starts raining back down through the steam cloud.
        const displacedWater = matAt(x, y) === WATER || isSteamCell(x, y);
        // Hot ejecta lands as scorched sand (G = ember intensity, cools on
        // the GPU); ordinary grains land as plain loose sand.
        stampRegion(x, y, 1, 1, () => g.hot ? [SAND, 0, 0, 230] : [SAND, 0]);
        SFX.grainLand(!!g.hot);
        if (g.hot && Math.random() < 0.35) spawnSparks(x, y + 1, 1, 1.6);
        if (displacedWater) {
            let wy = y + 1;
            while (wy < H && !isFreeAir(x, wy)) wy++;
            if (wy < H) stampRegion(x, wy, 1, 1, () => [WATER, 0]);
            else audit.depositFailWater++;
        }
    } else {
        // Water droplets merge with whatever pool they strike: the added
        // volume surfaces at the nearest open air cell in the column.
        while (y < H && !isFreeAir(x, y)) y++;
        if (y >= H) { audit.depositFailWater++; return; }
        stampRegion(x, y, 1, 1, () => [WATER, 0]);
    }
}

// Open lateral drainage: loose material reaching the boundary columns
// leaves the world permanently — the ONLY sanctioned way matter disappears.
function drainEdges() {
    // 4-column-aligned stamps (16-byte rows): 1px-wide texSubImage uploads
    // corrupted edge bytes on some drivers (fall speed bled into the scorch
    // channel). The extra columns also scrub any phantom scorch that does
    // appear, so it can never accumulate and flash-boil passing water.
    for (const x0 of [0, W - 4]) {
        stampRegion(x0, BEDROCK_TOP, 4, H - BEDROCK_TOP, (m, a, cx, cy) => {
            const edge = cx === 0 || cx === W - 1;
            if (edge && m === WATER) { audit.cellDrainWater++; return [AIR, 0]; }
            if (edge && m === SAND && a < 64) {
                audit.cellDrainSand++;
                if (isWetCell(cx, cy)) audit.cellDrainWater++; // its pore water leaves too
                return [AIR, 0];
            }
            if (m === SAND) {
                const mi = (cy * W + cx) * 4;
                if (mirror[mi + 1] > 0) return [mirror[mi], a, mirror[mi + 2], 0];
            }
            return null;
        });
    }
}

function updateGrains() {
    // Mid-air crowding (from Sand): dense ejecta curtains jostle instead of
    // ghosting through one another — a grain moving into a cell another grain
    // already occupies gives up part of its speed. Grains still waiting on
    // their staged-launch delay are not yet in flight and do not block.
    const occ = new Set();
    for (const g of grains) {
        if (!(g.delay > 0)) occ.add((Math.round(g.y) << 10) | Math.round(g.x));
    }

    for (let i = grains.length - 1; i >= 0; i--) {
        const g = grains[i];
        // Staged ejecta: excavation flows outward over several frames rather
        // than leaving all at once.
        if (g.delay > 0) { g.delay--; continue; }
        g.vy -= GRAVITY;
        g.vx += Math.sin(performance.now() * 0.00013) * 0.004; // ambient wind drift
        // Air drag: fine spray and dust decelerate quickly, so ejecta stays
        // in a realistic radius instead of sailing across the map.
        const drag = g.mat === WATER ? 0.968 : 0.986;
        g.vx *= drag; g.vy *= drag;
        const term = g.mat === WATER ? 8 : 9.5;
        const sp = Math.hypot(g.vx, g.vy);
        if (sp > term) { g.vx *= term / sp; g.vy *= term / sp; }
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(g.vx), Math.abs(g.vy))));
        const dx = g.vx / steps, dy = g.vy / steps;
        let alive = true;
        for (let s = 0; s < steps; s++) {
            const nx = g.x + dx, ny = g.y + dy;
            if (nx < 0 || nx >= W) {                                 // lateral drain
                (g.mat === WATER ? audit.grainDrainWater++ : audit.grainDrainSand++);
                alive = false; break;
            }
            if (ny >= H) { g.x = nx; g.y = ny; continue; }          // arcing above the sky
            if (ny < 0) { depositGrain(g); alive = false; break; }
            const m = matAt(Math.round(nx), Math.round(ny));
            if (m === AIR) {
                const tx = Math.round(nx), ty = Math.round(ny);
                // Only a *different* cell counts, or every grain would damp
                // itself against its own entry in the occupancy set.
                if ((tx !== Math.round(g.x) || ty !== Math.round(g.y)) &&
                    occ.has((ty << 10) | tx)) {
                    g.vx *= 0.82; g.vy *= 0.82;
                }
                g.x = nx; g.y = ny;
            } else if (m === WATER && g.mat === SAND) {
                // First contact with a pool throws up a splash droplet
                // (taken from the struck water cell — mass conserved).
                if (!g.entered && Math.abs(g.vy) > 2 && Math.random() < 0.5) {
                    const wx = Math.round(nx), wy = Math.round(ny);
                    stampRegion(wx, wy, 1, 1, mm => mm === WATER ? [AIR, 0] : null);
                    grains.push({
                        x: wx, y: wy, mat: WATER,
                        vx: (Math.random() - 0.5) * 3.5,
                        vy: 2.5 + Math.random() * 2.5,
                    });
                    SFX.plip();
                }
                g.entered = true;
                // Sand billows through water under heavy drag, sinking until
                // it strikes the bed.
                g.x = nx; g.y = ny;
                g.vx *= 0.75;
                g.vy = g.vy * 0.75 - 0.05;
            } else {
                depositGrain(g);                                     // touched down / merged
                alive = false;
                break;
            }
        }
        if (!alive) grains.splice(i, 1);
    }
}

function burstBalloon(cx, cy) {
    SFX.balloonPop();
    spawnMist(cx, cy, 14);
    const R = BALLOON_R;
    stampRegion(cx - R, cy - R, 2 * R + 1, 2 * R + 1, (m, a, x, y) => {
        const d = Math.hypot(x - cx, y - cy);
        if (d > R) return null;
        if (m === AIR) return [WATER, 0];
        return null;
    });
}

function touchesMat(p, target) {
    for (let i = 0; i < 8; i++) {
        const ang = i * Math.PI / 4;
        if (matAt(Math.round(p.x + Math.cos(ang) * p.r), Math.round(p.y + Math.sin(ang) * p.r)) === target) return true;
    }
    return matAt(Math.round(p.x), Math.round(p.y)) === target;
}

function collides(p, x, y) {
    for (let i = 0; i < 8; i++) {
        const ang = i * Math.PI / 4;
        if (isSolid(matAt(Math.round(x + Math.cos(ang) * p.r), Math.round(y + Math.sin(ang) * p.r)))) return true;
    }
    return false;
}

// Archimedes displacement: a submerged bomb occupies its volume as a solid
// disc stamped into the grid (cleared and re-stamped within the same frame,
// so the water never floods the gap — no churn). Overlapped water is pushed
// up to the free surface, permanently raising the level by the bomb's
// volume; a fast entry throws a crown splash of droplets.
function clearBombDisc(p) {
    if (!p.disc || !p.disc.length) return;
    const s = new Set(p.disc);
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (const k of p.disc) {
        const x = k % W, y = (k - x) / W;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    stampRegion(x0, y0, x1 - x0 + 1, y1 - y0 + 1, (m, a, x, y) =>
        (m === CONCRETE && s.has(y * W + x)) ? [AIR, 0] : null);
    p.disc = null;
}

function stampBombDisc(p) {
    const r = p.r - 1; // stamped body is 1px inside the collision radius
    const cx = Math.round(p.x), cy = Math.round(p.y);
    const cells = [];
    let displaced = 0;
    stampRegion(cx - r, cy - r, 2 * r + 1, 2 * r + 1, (m, a, x, y) => {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r) return null;
        if (m !== WATER && m !== AIR) return null; // never eat sand/concrete
        if (m === WATER) displaced++;
        cells.push(y * W + x);
        return [CONCRETE, 255];
    });
    p.disc = cells;
    if (!displaced) return 0;
    audit.discDisplaced += displaced;
    let toSeat = displaced;
    // Locate the free surface above the bomb.
    let sy2 = cy + r + 1;
    while (sy2 < H - 1 && !isFreeAir(cx, sy2)) sy2++;
    // Crown splash on a fast entry — droplets erupt AT the free surface
    // (a fast bomb is already below it by its first submerged frame).
    if (!p.wet) {
        const spd = Math.hypot(p.vx, p.vy);
        let drops = Math.min(toSeat, Math.round(spd * 2.5));
        if (drops > 0) {
            SFX.splash(Math.min(1, spd / 8));
            spawnMist(p.x, sy2 + 2, Math.min(20, drops * 2));
        }
        while (drops-- > 0 && toSeat > 0) {
            toSeat--;
            audit.splashSpawned++;
            grains.push({
                x: p.x + (Math.random() - 0.5) * 2 * p.r, y: sy2 + 1 + Math.random() * 2,
                vx: (Math.random() - 0.5) * 5 + p.vx * 0.3,
                vy: 2.5 + Math.random() * 3,
                mat: WATER,
            });
        }
    }
    const seat = (m, a, sx, sy) => {
        if (toSeat > 0 && m === AIR && !isSteamCell(sx, sy)) { toSeat--; return [WATER, 0]; }
        return null;
    };
    stampRegion(cx - r - 2, sy2 - 2, 2 * r + 5, Math.min(H - (sy2 - 2), 8), seat);
    if (toSeat > 0) stampRegion(cx - r - 6, cy, 2 * r + 13, H - cy, seat);
    if (toSeat > 0) audit.depositFailWater += toSeat; // nowhere to seat: audited exit
    return displaced;
}

function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        // Lift the bomb's stamped displacement disc for this frame; it is
        // re-stamped at the new position below (no GPU pass runs in between,
        // so water never floods the gap).
        if (p.disc) clearBombDisc(p);
        const inWater = touchesMat(p, WATER);

        // (TNT fuses burn underwater: submerged bombs sink and detonate.)
        if (p.type === 'tnt' && p.lit) {
            p.fuse -= dt;
            if (p.fuse <= 0) {
                detonate(Math.round(p.x), Math.round(p.y));
                projectiles.splice(i, 1);
                continue;
            }
        }

        p.vy -= GRAVITY * (inWater ? 0.22 : 1);
        if (inWater) { p.vx *= 0.93; p.vy *= 0.93; }
        // Air drag: dense ordnance has a high terminal velocity.
        const psp = Math.hypot(p.vx, p.vy);
        if (psp > 12) { p.vx *= 12 / psp; p.vy *= 12 / psp; }

        // Axis-separated movement in 1px increments (no tunnelling).
        let sx = Math.abs(p.vx), dirx = Math.sign(p.vx);
        while (sx > 0) {
            const step = Math.min(1, sx); sx -= step;
            if (!collides(p, p.x + dirx * step, p.y)) {
                p.x += dirx * step;
            } else if (!collides(p, p.x + dirx * step, p.y + 1)) {
                p.x += dirx * step; p.y += 1;   // roll over a 1px lip
            } else {
                p.vx *= -(inWater ? 0.05 : 0.4);
                break;
            }
        }
        let sy = Math.abs(p.vy), diry = Math.sign(p.vy);
        let landed = false;
        while (sy > 0) {
            const step = Math.min(1, sy); sy -= step;
            if (collides(p, p.x, p.y + diry * step)) {
                if (diry < 0) landed = true;
                p.vy *= -(inWater ? 0.02 : 0.35);
                if (Math.abs(p.vy) < 0.6) p.vy = 0;
                break;
            }
            p.y += diry * step;
        }

        // Spherical bombs roll downhill on uneven ground: probe the terrain
        // height under each shoulder and accelerate toward the lower side.
        if (collides(p, p.x, p.y - 1)) {
            const probe = px => {
                const xi = Math.max(0, Math.min(W - 1, Math.round(px)));
                let yy = Math.round(p.y);
                const floor = Math.max(0, yy - (2 * p.r + 6));
                while (yy > floor && !isSolid(matAt(xi, yy - 1))) yy--;
                return yy;
            };
            const dh = probe(p.x + p.r) - probe(p.x - p.r);
            if (Math.abs(dh) >= 2) p.vx -= (dh / (2 * p.r)) * GRAVITY * 0.9; // downhill pull
            p.vx *= 0.97; // rolling resistance
            p.roll = (p.roll || 0) + p.vx / p.r; // rolling spin (visual)
        } else {
            p.roll = (p.roll || 0) + p.vx * 0.3 / p.r; // slow tumble in flight
        }

        // A bomb in water occupies its volume as a solid disc: displaces the
        // overlapped water to the surface (Archimedes) with an entry splash.
        if (p.type === 'tnt') {
            if (inWater) {
                if (stampBombDisc(p) > 0) p.wet = true;
            } else {
                p.wet = false;
            }
        }

        if (p.type === 'balloon' && (landed || inWater || collides(p, p.x + Math.sign(p.vx || 1), p.y) || collides(p, p.x, p.y - 1))) {
            burstBalloon(Math.round(p.x), Math.round(p.y));
            projectiles.splice(i, 1);
            continue;
        }

        if (p.x < -30 || p.x > W + 30 || p.y < -30 || p.y > H + 60) {
            clearBombDisc(p);
            projectiles.splice(i, 1);
        }
    }
}

// ---------------------------------------------------------------------------
// Tools / input (all coordinates converted to texture space, y up)
// ---------------------------------------------------------------------------

function toTex(e) {
    const r = overlay.getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) * (W / r.width));
    const y = H - 1 - Math.round((e.clientY - r.top) * (H / r.height));
    return { x: Math.max(0, Math.min(W - 1, x)), y: Math.max(0, Math.min(H - 1, y)) };
}

function paintBrush(cx, cy) {
    const r = brush;
    stampRegion(cx - r, cy - r, 2 * r + 1, 2 * r + 1, (m, a, x, y) => {
        if (Math.hypot(x - cx, y - cy) > r) return null;
        if (tool === 'dig') return (m === SAND || m === WATER) ? [AIR, 0] : null; // vacuum can't cut concrete
        if (tool === 'sand') return (m === AIR || m === WATER) ? [SAND, 0] : null;
        if (tool === 'water') return (m === AIR) ? [WATER, 0] : null; // B/G default to rest velocity
        return null;
    });
}

function paintLine(x0, y0, x1, y1) {
    const d = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const steps = Math.max(1, Math.ceil(d / Math.max(1, brush * 0.5)));
    for (let i = 0; i <= steps; i++)
        paintBrush(Math.round(x0 + (x1 - x0) * i / steps), Math.round(y0 + (y1 - y0) * i / steps));
}

function commitBar(x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    // Section depth comes from the brush slider, so a bar can be drawn as a
    // thin slab or a deep beam — and since flexural capacity goes with the
    // square of it, the two behave completely differently under load.
    const th = Math.max(3, Math.min(16, brush));
    let bx, by, bw, bh;
    if (dx >= dy) { // horizontal bar
        bw = Math.max(16, dx); bh = th;
        bx = Math.min(x0, x1); by = y0 - (th >> 1);
    } else {        // vertical bar
        bw = th; bh = Math.max(16, dy);
        bx = x0 - (th >> 1); by = Math.min(y0, y1);
    }
    bx = Math.max(0, Math.min(W - bw, bx));
    by = Math.max(BEDROCK_TOP, Math.min(H - bh, by));
    const body = makeBarBody(bx, by, bw, bh);
    stampBody(body);
    bodies.push(body);
}

function launch(type, ox, oy, tx, ty) {
    let vx = (ox - tx) * SLING_K, vy = (oy - ty) * SLING_K;
    const s = Math.hypot(vx, vy);
    if (s > SLING_MAX) { vx *= SLING_MAX / s; vy *= SLING_MAX / s; }
    projectiles.push({
        type, x: ox, y: oy, vx, vy,
        r: type === 'tnt' ? 4 : 5,
        fuse: TNT_FUSE_MS, lit: type === 'tnt', rest: 0,
    });
    SFX.launch(Math.min(1, Math.hypot(vx, vy) / SLING_MAX));
}

function attachInput() {
    overlay.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        SFX.unlock();
        overlay.setPointerCapture(e.pointerId);
        const t = toTex(e);
        mouse.down = true; mouse.x = t.x; mouse.y = t.y;
        if (tool === 'dig' || tool === 'sand' || tool === 'water') {
            mouse.painting = true;
            mouse.lastX = t.x; mouse.lastY = t.y;
            paintBrush(t.x, t.y);
        } else if (tool === 'concrete') {
            barStart = { x: t.x, y: t.y };
        } else if ((tool === 'tnt' || tool === 'balloon') && matAt(t.x, t.y) === AIR) {
            aimOrigin = { x: t.x, y: t.y };
        }
        e.preventDefault();
    });

    overlay.addEventListener('pointermove', e => {
        const t = toTex(e);
        mouse.x = t.x; mouse.y = t.y;
        if (mouse.painting) {
            paintLine(mouse.lastX, mouse.lastY, t.x, t.y);
            mouse.lastX = t.x; mouse.lastY = t.y;
        }
    });

    const finish = e => {
        if (!mouse.down) return;
        mouse.down = false;
        const t = toTex(e);
        if (mouse.painting) mouse.painting = false;
        if (barStart) { commitBar(barStart.x, barStart.y, t.x, t.y); barStart = null; }
        if (aimOrigin) { launch(tool, aimOrigin.x, aimOrigin.y, t.x, t.y); aimOrigin = null; }
    };
    overlay.addEventListener('pointerup', finish);
    overlay.addEventListener('pointercancel', () => { mouse.down = false; mouse.painting = false; barStart = null; aimOrigin = null; });
}

// ---------------------------------------------------------------------------
// GFX support: column heights, juice particles, FX state, frame stats
// ---------------------------------------------------------------------------

// First-solid-from-the-top per column, uploaded as an 800x1 R8 strip. Drives
// the depth-ambient shading (dark caverns, lit shafts) and blast-depth audio.
function computeColumnHeights() {
    for (let x = 0; x < W; x++) {
        let y = H - 1;
        while (y > BEDROCK_TOP) {
            const m = (mirror[(y * W + x) * 4] + 30) / 60 | 0;
            if (m === SAND || m === CONCRETE || m === BEDROCK) break;
            y--;
        }
        colH[x] = y;
        heightBytes[x * 4] = Math.round(y * 255 / H);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, heightTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, heightBytes);
}

function spawnP(o) { if (particles.length < MAXP) particles.push(o); }

function spawnSparks(x, y, n, spd, life0 = 26, lifeR = 40) {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = spd * (0.4 + Math.random());
        spawnP({
            kind: 'spark', x, y,
            vx: Math.cos(a) * v, vy: Math.sin(a) * v + spd * 0.5,
            life: life0 + Math.random() * lifeR, age: 0,
            size: 2 + Math.random() * 2.5,
        });
    }
}

function spawnDust(x, y, n) {
    for (let i = 0; i < n; i++) {
        spawnP({
            kind: 'dust',
            x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 5,
            vx: (Math.random() - 0.5) * 1.6, vy: 0.4 + Math.random() * 1.1,
            life: 25 + Math.random() * 35, age: 0,
            size: 3 + Math.random() * 3.5,
        });
    }
}

function spawnMist(x, y, n = 1) {
    for (let i = 0; i < n; i++) {
        spawnP({
            kind: 'mist',
            x: x + (Math.random() - 0.5) * 4, y: y + Math.random() * 3,
            vx: (Math.random() - 0.5) * 0.9, vy: 0.3 + Math.random() * 0.8,
            life: 28 + Math.random() * 40, age: 0,
            size: 3 + Math.random() * 4,
        });
    }
}

function spawnBubbles(x, y, n) {
    for (let i = 0; i < n; i++) {
        spawnP({
            kind: 'bubble',
            x: x + (Math.random() - 0.5) * 14, y: y + (Math.random() - 0.5) * 14,
            vx: (Math.random() - 0.5) * 0.6, vy: 0.3 + Math.random() * 0.7,
            life: 240, age: 0,
            size: 1.5 + Math.random() * 1.8,
        });
    }
}

function spawnBlastParticles(cx, cy, submerged, vent = 1) {
    // A camouflet barely shows above ground: almost no fire, mostly dust.
    const k = 0.2 + 0.8 * vent;
    if (submerged) {
        spawnBubbles(cx, cy, Math.round(40 * k));
        spawnSparks(cx, cy, Math.round(10 * k), 2, 8, 8);
    } else {
        spawnSparks(cx, cy, Math.round(55 * k), 4.5);
        spawnSparks(cx, cy, Math.round(20 * k), 2.2, 70, 70); // lingering embers
        spawnDust(cx, cy, Math.round(24 * (0.6 + 0.4 * vent)));
    }
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (++p.age >= p.life) { particles.splice(i, 1); continue; }
        switch (p.kind) {
            case 'spark': p.vy -= 0.13; p.vx *= 0.965; p.vy *= 0.965; break;
            case 'dust': p.vy -= 0.02; p.vx *= 0.94; p.vy *= 0.94; break;
            case 'mist': p.vy += 0.012; p.vx = p.vx * 0.96 + (Math.random() - 0.5) * 0.06; break;
            case 'bubble':
                p.vy = Math.min(p.vy + 0.05, 1.6);
                p.vx = p.vx * 0.9 + (Math.random() - 0.5) * 0.3;
                break;
        }
        p.x += p.vx; p.y += p.vy;
        if (p.x < 1 || p.x >= W - 1 || p.y < BEDROCK_TOP) { particles.splice(i, 1); continue; }
        const m = p.y < H ? matAt(Math.round(p.x), Math.round(p.y)) : AIR;
        if (p.kind === 'bubble') {
            if (m !== WATER) { particles.splice(i, 1); continue; } // surfaced/popped
        } else if (isSolid(m)) {
            particles.splice(i, 1);
        } else if (m === WATER && p.kind === 'spark') {
            p.life = Math.min(p.life, p.age + 5); // quenched
        }
    }
}

function fillParticleData() {
    let n = 0;
    for (const p of particles) {
        if (n >= MAXP) break;
        const k = 1 - p.age / p.life;
        let r, g2, b, a, size = p.size;
        if (p.kind === 'spark') {
            const heat = k * k;
            r = 1.0; g2 = 0.25 + 0.65 * heat; b = 0.06 + 0.5 * heat * heat;
            a = 0.85 * k;
            size = p.size * (0.5 + k);
        } else if (p.kind === 'dust') {
            r = 0.45; g2 = 0.38; b = 0.28; a = 0.10 * k;
        } else if (p.kind === 'mist') {
            r = 0.55; g2 = 0.72; b = 0.85; a = 0.09 * k;
        } else { // bubble
            r = 0.5; g2 = 0.8; b = 0.95; a = 0.35;
        }
        const o = n * 7;
        particleData[o] = p.x;
        particleData[o + 1] = p.y;
        particleData[o + 2] = size;
        particleData[o + 3] = r;
        particleData[o + 4] = g2;
        particleData[o + 5] = b;
        particleData[o + 6] = a;
        n++;
    }
    return n;
}

// Shock rings, blast flash and smoothed screen shake.
function updateFx(t, dt) {
    const s = dt / 16.6;
    for (let i = rings.length - 1; i >= 0; i--) {
        const q = rings[i];
        q.r += 8.5 * s;
        q.amp *= Math.pow(0.87, s);
        if (q.amp < 0.15) rings.splice(i, 1);
    }
    flash *= Math.pow(0.8, s);
    if (flash < 0.004) flash = 0;
    shakeEnergy *= Math.pow(0.93, s);
    if (shakeEnergy < 0.01) shakeEnergy = 0;
    const e = shakeEnergy * shakeEnergy * 8;
    shakeX = (Math.sin(t * 0.061) + Math.sin(t * 0.097 + 1.3) * 0.6) * e;
    shakeY = (Math.cos(t * 0.083) + Math.sin(t * 0.113 + 0.7) * 0.6) * e;
}

// Cheap Monte-Carlo read of the mirror: drives the continuous audio beds and
// seeds waterfall mist. ~240 samples/frame, no full-grid scans.
function sampleStats() {
    const K = 240;
    let loose = 0, wmove = 0, wfall = 0;
    for (let k = 0; k < K; k++) {
        const x = (Math.random() * W) | 0;
        const y = (BEDROCK_TOP + Math.random() * (H - BEDROCK_TOP)) | 0;
        const i = (y * W + x) * 4;
        const m = (mirror[i] + 30) / 60 | 0;
        if (m === SAND) {
            if (mirror[i + 3] < 64 && matAt(x, y - 1) === AIR) loose++;
        } else if (m === WATER) {
            if (Math.abs(mirror[i + 1] - 128) > 6 || Math.abs(mirror[i + 2] - 128) > 7) wmove++;
            if (matAt(x, y - 1) === AIR) {
                wfall++;
                if (Math.random() < 0.5) spawnMist(x, y, 1);
            }
        }
    }
    let lit = 0;
    for (const p of projectiles) if (p.lit) lit++;
    return {
        pour: Math.min(1, loose / K * 30 + grains.length / 300),
        flow: Math.min(1, wmove / K * 9),
        falls: Math.min(1, wfall / K * 45),
        wind: Math.abs(Math.sin(performance.now() * 0.00013) * 0.7),
        fuse: lit,
        rumble: quakes.length > 0 ? 1 : shakeEnergy,
        vac: mouse.painting && tool === 'dig' ? 1 : 0,
    };
}

function bindTex(unit, texture) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
}

const NOFX = typeof location !== 'undefined' && location.search.includes('nofx');

// Post-processed present: sim state -> light field -> scene FBO (+ additive
// particles) -> bloom chain -> composite (shake, shock rings, flash, ACES).
function present(t) {
    if (NOFX) { // diagnostic: raw scene straight to the canvas, no post passes
        gl.bindVertexArray(vaoTri);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(progRender.prog);
        gl.uniform1i(progRender.u_state, 0);
        gl.uniform1i(progRender.u_light, 1);
        gl.uniform1i(progRender.u_heights, 2);
        gl.uniform1f(progRender.u_time, t / 1000);
        bindTex(0, tex[front]);
        bindTex(1, lightTex[lightFront]);
        bindTex(2, heightTex);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return;
    }
    // Point lights: lit fuses, fresh explosions, a few hot ejecta grains.
    const lights = [];
    for (const p of projectiles) {
        if (p.lit && lights.length < 24) lights.push(p.x, p.y, 26, 0.5 + Math.random() * 0.35);
    }
    for (const q of rings) {
        if (q.amp > 2.5 && lights.length < 28) lights.push(q.x, q.y, 95, Math.min(1.6, q.amp * 0.22));
    }
    for (const g of grains) {
        if (g.hot && lights.length < 32) lights.push(g.x, g.y, 11, 0.28);
    }

    gl.bindVertexArray(vaoTri);
    gl.useProgram(progLight.prog);
    gl.uniform1i(progLight.u_state, 0);
    gl.uniform1i(progLight.u_prev, 1);
    gl.uniform1i(progLight.u_nlights, lights.length / 4);
    if (lights.length) gl.uniform4fv(progLight.u_lights, new Float32Array(lights));
    gl.viewport(0, 0, LW, LH);
    for (let i = 0; i < 2; i++) { // two diffusion steps/frame -> faster spread
        gl.bindFramebuffer(gl.FRAMEBUFFER, lightFbo[1 - lightFront]);
        bindTex(0, tex[front]);
        bindTex(1, lightTex[lightFront]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        lightFront = 1 - lightFront;
    }

    // Scene pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
    gl.viewport(0, 0, W, H);
    gl.useProgram(progRender.prog);
    gl.uniform1i(progRender.u_state, 0);
    gl.uniform1i(progRender.u_light, 1);
    gl.uniform1i(progRender.u_heights, 2);
    gl.uniform1f(progRender.u_time, t / 1000);
    bindTex(0, tex[front]);
    bindTex(1, lightTex[lightFront]);
    bindTex(2, heightTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Additive particles into the scene so bright sparks feed the bloom.
    const pcount = fillParticleData();
    if (pcount > 0) {
        gl.useProgram(progParticle.prog);
        gl.bindVertexArray(vaoParticle);
        gl.bindBuffer(gl.ARRAY_BUFFER, particleBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, particleData, 0, pcount * 7);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArrays(gl.POINTS, 0, pcount);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(vaoTri);
    }

    // Bloom: bright-pass then two separable gaussian iterations at half res.
    gl.viewport(0, 0, LW, LH);
    gl.useProgram(progBright.prog);
    gl.uniform1i(progBright.u_scene, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, blurFbo[0]);
    bindTex(0, sceneTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(progBlur.prog);
    gl.uniform1i(progBlur.u_scene, 0);
    gl.uniform2f(progBlur.u_texel, 1 / LW, 1 / LH);
    for (const [sIdx, dIdx, dx, dy] of [[0, 1, 1, 0], [1, 0, 0, 1], [0, 1, 2.2, 0], [1, 0, 0, 2.2]]) {
        gl.uniform2f(progBlur.u_dir, dx, dy);
        gl.bindFramebuffer(gl.FRAMEBUFFER, blurFbo[dIdx]);
        bindTex(0, blurTex[sIdx]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Composite to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(progComposite.prog);
    gl.uniform1i(progComposite.u_scene, 0);
    gl.uniform1i(progComposite.u_bloom, 1);
    gl.uniform1f(progComposite.u_time, t / 1000);
    gl.uniform1f(progComposite.u_flash, flash);
    gl.uniform2f(progComposite.u_shake, shakeX, shakeY);
    const rr = new Float32Array(16);
    const nr = Math.min(4, rings.length);
    for (let i = 0; i < nr; i++) {
        rr[i * 4] = rings[i].x;
        rr[i * 4 + 1] = rings[i].y;
        rr[i * 4 + 2] = rings[i].r;
        rr[i * 4 + 3] = rings[i].amp;
    }
    gl.uniform1i(progComposite.u_nrings, nr);
    gl.uniform4fv(progComposite.u_rings, rr);
    bindTex(0, sceneTex);
    bindTex(1, blurTex[0]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function frame(t) {
    if (disposed) return;
    const dt = Math.min(t - lastT, 50);
    lastT = t;
    avgDelta = avgDelta * 0.9 + dt * 0.1;

    if (running || stepRequest) {
        // Demo mode: rain one lit TNT from a random sky position every second.
        if (demo) {
            demoTimer += dt;
            if (demoTimer >= 1000) {
                demoTimer -= 1000;
                projectiles.push({
                    type: 'tnt',
                    x: 40 + Math.random() * (W - 80), y: H - 25,
                    vx: (Math.random() - 0.5) * 2, vy: 0,
                    r: 4, fuse: TNT_FUSE_MS, lit: true, rest: 0,
                });
            }
        }
        updateBodies();
        updateProjectiles(dt);
        updateGrains();
        updateQuakes();
        // Dynamic sub-stepping against the 16.6ms budget.
        const subs = avgDelta < 12 ? 4 : (avgDelta < 19 ? 3 : 2);
        for (let i = 0; i < subs; i++) runSubstep();
        readback();
        drainEdges();
        stepRequest = false;
    }

    frameNo++;
    if ((frameNo & 1) === 0) computeColumnHeights();
    updateParticles();
    updateFx(t, dt);
    SFX.frame(dt, sampleStats());

    present(t);
    drawOverlay(t);

    fpsFrames++;
    if (t - fpsTime > 500) { fps = Math.round(fpsFrames * 1000 / (t - fpsTime)); fpsFrames = 0; fpsTime = t; }
    rafId = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// 2D overlay: aim line, trajectory, projectiles, previews, cursor, HUD
// ---------------------------------------------------------------------------

const sy = ty => H - 1 - ty; // texture y -> screen y

function chip(x, y, w2, h2) {
    octx.fillStyle = 'rgba(10, 14, 22, 0.55)';
    if (octx.roundRect) {
        octx.beginPath();
        octx.roundRect(x, y, w2, h2, 5);
        octx.fill();
        octx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
        octx.lineWidth = 1;
        octx.stroke();
    } else {
        octx.fillRect(x, y, w2, h2);
    }
}

function drawOverlay(t) {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, W, H);
    // Match the composite pass's screen shake so the overlay stays glued to
    // the world (sampling at uv+shake shifts the image by -shake px; GL y-up
    // flips to +y on the canvas).
    octx.setTransform(1, 0, 0, 1, -shakeX, shakeY);

    // Slingshot aim line + predicted trajectory.
    if (aimOrigin && mouse.down) {
        const ox = aimOrigin.x, oy = aimOrigin.y;
        octx.strokeStyle = 'rgba(255,255,255,0.85)';
        octx.setLineDash([4, 4]);
        octx.lineWidth = 2;
        octx.beginPath();
        octx.moveTo(ox, sy(oy));
        octx.lineTo(mouse.x, sy(mouse.y));
        octx.stroke();
        octx.setLineDash([]);

        let vx = (ox - mouse.x) * SLING_K, vy = (oy - mouse.y) * SLING_K;
        const s = Math.hypot(vx, vy);
        if (s > SLING_MAX) { vx *= SLING_MAX / s; vy *= SLING_MAX / s; }
        let px = ox, py = oy;
        octx.fillStyle = 'rgba(255,235,130,0.9)';
        for (let i = 0; i < 26; i++) {
            for (let k = 0; k < 3; k++) { vy -= GRAVITY; px += vx; py += vy; }
            if (px < 0 || px > W || py < 0) break;
            if (isSolid(matAt(Math.round(px), Math.round(py)))) break;
            octx.fillRect(Math.round(px) - 1, Math.round(sy(py)) - 1, 3, 3);
        }
        octx.fillStyle = '#fff';
        octx.fillRect(ox - 2, sy(oy) - 2, 5, 5);
    }

    // Concrete bar placement preview.
    if (barStart && mouse.down) {
        const dx = Math.abs(mouse.x - barStart.x), dy = Math.abs(mouse.y - barStart.y);
        octx.strokeStyle = 'rgba(200,210,220,0.9)';
        octx.lineWidth = 1;
        if (dx >= dy) octx.strokeRect(Math.min(barStart.x, mouse.x), sy(barStart.y) - 4, Math.max(16, dx), 8);
        else octx.strokeRect(barStart.x - 4, sy(Math.max(barStart.y, mouse.y)), 8, Math.max(16, dy));
    }

    // Ballistic ejecta grains (blast sand flies as red-hot embers).
    for (const g of grains) {
        if (g.delay > 0) continue; // still inside the fireball, not yet launched
        octx.fillStyle = g.mat === WATER ? '#5ab0e8' : (g.hot ? '#f0472e' : '#d8a95e');
        octx.fillRect(Math.round(g.x) - 1, Math.round(sy(g.y)) - 1, 2, 2);
    }

    // Projectiles.
    for (const p of projectiles) {
        const x = Math.round(p.x), y = Math.round(sy(p.y));
        if (p.type === 'tnt') {
            octx.fillStyle = '#a3212b';
            octx.beginPath(); octx.arc(x, y, p.r, 0, 7); octx.fill();
            // Rotating band shows the bomb's roll/tumble.
            octx.save();
            octx.translate(x, y);
            octx.rotate(-(p.roll || 0));
            octx.fillStyle = '#5e1218';
            octx.fillRect(-p.r, -1, p.r * 2, 2);
            octx.restore();
            if (p.lit) {
                if ((t / 90 | 0) % 2 === 0) { octx.fillStyle = '#ffd24a'; octx.fillRect(x - 1, y - p.r - 4, 3, 3); }
                octx.fillStyle = '#fff';
                octx.font = 'bold 10px monospace';
                octx.textAlign = 'center';
                octx.fillText((p.fuse / 1000).toFixed(1), x, y - p.r - 7);
            }
        } else {
            octx.fillStyle = '#43c6e8';
            octx.beginPath(); octx.arc(x, y, p.r, 0, 7); octx.fill();
            octx.fillStyle = '#bdeefc';
            octx.fillRect(x - 2, y - 3, 2, 2);
        }
    }

    // Brush cursor.
    if ((tool === 'dig' || tool === 'sand' || tool === 'water')) {
        octx.strokeStyle = tool === 'dig' ? 'rgba(255,120,120,0.8)' : 'rgba(255,255,255,0.6)';
        octx.lineWidth = 1;
        octx.beginPath(); octx.arc(mouse.x, sy(mouse.y), brush, 0, 7); octx.stroke();
    }

    // HUD (screen-fixed: drop the world shake transform).
    octx.setTransform(1, 0, 0, 1, 0, 0);
    chip(W - 76, 4, 72, 16);
    octx.fillStyle = fps >= 50 ? '#7dff9b' : '#ffcf5e';
    octx.font = 'bold 11px monospace';
    octx.textAlign = 'left';
    octx.fillText(`${fps} FPS`, W - 70, 16);

    // Live conservation counter (grid cells + grains currently in flight).
    if (++countTimer >= 30) { recount(); countTimer = 0; }
    let gs = 0, gw = 0;
    for (const g of grains) (g.mat === WATER ? gw++ : gs++);
    chip(W - 250, 24, 246, 16);
    octx.fillStyle = '#e8d9a8';
    octx.fillText(`SAND ${counts.sand + gs}  WATER ${counts.water + gw}`, W - 244, 36);
    if (!running) {
        chip(4, 4, 66, 16);
        octx.fillStyle = '#ffcf5e';
        octx.fillText('PAUSED', 8, 16);
    } else if (demo) {
        chip(4, 4, 96, 16);
        octx.fillStyle = '#ff8a5e';
        octx.fillText('DEMO RAID', 8, 16);
    }
}
