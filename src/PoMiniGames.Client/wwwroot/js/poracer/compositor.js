import { sampleAt } from './interpolation.js';
import * as Impact from '../impactBus.js';
import * as Cue from '../gameCues.js';

const RENDER_DELAY_MS = 80;
// Snapshots older than this are dropped: a tab that was backgrounded comes back
// with a stale buffer, and interpolating across that gap would slide every car
// across the map.
const STALE_MS = 1500;
// Snapshots retained for interpolation. Must comfortably exceed
// RENDER_DELAY_MS / snapshot-interval (80/50 ≈ 1.6) or `renderAt` falls off the
// back of the buffer and there is no pair to interpolate between — see the note
// at the top of this file for what that looked like. Six entries is 300 ms of
// history, enough to also ride out a couple of dropped packets.
const BUFFER_MAX = 6;

const VERT_SRC = `#version 300 es
out vec2 vUv;
void main() {
    vec2 uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUv = uv;
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;

uniform sampler2D tScene;
uniform vec2  uRes;
uniform float uTime;
uniform float uSpeed;    // 0..1 normalised road speed
uniform float uPunch;    // 0..1 impact envelope
uniform float uBoost;    // 0..1 player boost intensity
uniform float uTheme;    // 0 = circuit, 1 = neon, 2 = desert

in vec2 vUv;
out vec4 frag;

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    return fract(p * (p + p));
}

void main() {
    vec2 uv = vUv;
    vec2 centre = vec2(0.5);
    vec2 toC = uv - centre;
    float r = length(toC);

    // ── Heat shimmer ───────────────────────────────────────────────────
    // Applied to the sample coordinate before anything reads the texture, so
    // every later effect inherits the warp instead of fighting it. Amplitude
    // rises with speed and desert heat: still air does not shimmer, air being torn through does.
    float desertBonus = (uTheme > 1.5) ? 0.0012 : 0.0;
    float haze = (0.25 + uSpeed * 0.75) * 0.0016 + desertBonus;
    uv += vec2(
        sin(uv.y * 46.0 + uTime * 3.1) * haze,
        cos(uv.x * 38.0 + uTime * 2.4) * haze * 0.6);

    vec3 col = texture(tScene, uv).rgb;

    // ── Chromatic aberration (cyberpunk lens flare on speed, boost, and punch) ──
    float ca = (uSpeed * 0.0028 + uBoost * 0.0075 + uPunch * 0.0090) * smoothstep(0.08, 0.92, r);
    if (ca > 0.00002) {
        vec2 dir = r > 0.0001 ? toC / r : vec2(0.0);
        col.r = texture(tScene, uv - dir * ca).r;
        col.b = texture(tScene, uv + dir * ca * 1.15).b;
    }

    // ── Bright-pass bloom & Neon track reflections ────────────────────
    vec3 bloom = vec3(0.0);
    vec2 px = 2.8 / uRes;
    bloom += texture(tScene, uv + vec2( px.x,  px.y) * 3.2).rgb;
    bloom += texture(tScene, uv + vec2(-px.x,  px.y) * 3.2).rgb;
    bloom += texture(tScene, uv + vec2( px.x, -px.y) * 3.2).rgb;
    bloom += texture(tScene, uv + vec2(-px.x, -px.y) * 3.2).rgb;
    bloom *= 0.25;
    float bloomCut = (uTheme > 0.5 && uTheme < 1.5) ? 0.46 : 0.58;
    float bloomMul = (uTheme > 0.5 && uTheme < 1.5) ? 2.9 : 2.2;
    bloom = max(bloom - bloomCut, 0.0) * bloomMul;
    col += bloom;

    // ── Speed warp and relativistic speed streaks ─────────────────────
    float activeSpeed = max(uSpeed, uBoost * 0.85);
    float sl = smoothstep(0.46, 1.0, activeSpeed);
    if (sl > 0.001) {
        float ang = atan(toC.y, toC.x);
        float lane = floor(ang * 48.0);
        float streak = step(0.74, hash11(lane + floor(uTime * 32.0)));
        float mask = smoothstep(0.20, 0.88, r) * streak * sl;
        vec3 themeStreak;
        if (uTheme > 1.5) {
            // Desert rally: amber, sand, and golden spark streaks
            themeStreak = mix(vec3(1.0, 0.78, 0.25), vec3(1.0, 0.45, 0.1), hash11(lane));
        } else if (uTheme > 0.5) {
            // Neon skyline: vivid electric cyan & magenta
            themeStreak = mix(vec3(0.0, 0.95, 1.0), vec3(1.0, 0.25, 0.88), hash11(lane));
        } else {
            // Grand prix: crisp cyan-white slipstream streaks
            themeStreak = mix(vec3(0.85, 0.95, 1.0), vec3(0.2, 0.85, 1.0), hash11(lane));
        }
        col += themeStreak * mask * (0.32 + uBoost * 0.28);
    }

    // ── Speed vignette & Contrast tuning ──────────────────────────────
    col *= 1.0 - smoothstep(0.32, 0.96, r) * (0.16 + uSpeed * 0.26);

    frag = vec4(col, 1.0);
}`;

// ── Snapshot buffer ────────────────────────────────────────────────────────

// Ascending by `st` (server clock, ms). Newest last.
/** @type {Array<{st:number, t:number, elapsedSec:number, weather:number, cars:Array}>} */
let buf = [];
// Local→server clock offset: serverNow ≈ performance.now() + clockOffset. Both
// clocks tick at the same rate, so this is a constant plus network jitter; the
// easing below is what filters the jitter out.
let clockOffset = null;
let mainId = null;
let miniId = null;
let origDrawSnapshot = null;
let raf = 0;
let installed = false;

// GL state.
let glCanvas = null;
let gl = null;
let prog = null;
let vao = null;
let tex = null;
let uRes = null;
let uTime = null;
let uSpeed = null;
let uPunch = null;
let uBoost = null;
let uTheme = null;
let sceneCanvas = null;
let glReady = false;
let startTime = 0;

/** Top speed used to normalise the shader's uSpeed. Matches the C# car model. */
const MAX_SPEED = 380;

function tierTaps() {
    if (window.PoRacer?.effectsReduced()) return 0;
    switch (document.documentElement.getAttribute('data-gfx')) {
        case 'low': return 0;      // 0 disables the GL layer entirely
        case 'medium': return 6;
        default: return 12;
    }
}

function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
    return s;
}

function ensureGl(canvas2d) {
    if (glReady || glCanvas) return glReady;
    sceneCanvas = canvas2d;

    glCanvas = document.createElement('canvas');
    glCanvas.className = 'racer-gl';
    Object.assign(glCanvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
    glCanvas.setAttribute('aria-hidden', 'true');
    canvas2d.parentNode?.insertBefore(glCanvas, canvas2d.nextSibling);

    gl = glCanvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
    if (!gl) { teardownGl(); return false; }

    const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) { teardownGl(); return false; }
    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { teardownGl(); return false; }

    vao = gl.createVertexArray();
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Canvas sources upload top-down, the GL framebuffer renders bottom-up.
    // Without this flip the composite presents vertically mirrored — which
    // reads as inverted steering (D turned the car left on screen) even though
    // the sim and the raw 2D canvas agree. Must be set before the first
    // texImage2D upload; it only affects canvas/image sources.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // LINEAR + CLAMP: the blur and aberration both sample off the exact texel
    // grid, and REPEAT would wrap the far edge of the track into the near one.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.useProgram(prog);
    uRes = gl.getUniformLocation(prog, 'uRes');
    uTime = gl.getUniformLocation(prog, 'uTime');
    uSpeed = gl.getUniformLocation(prog, 'uSpeed');
    uPunch = gl.getUniformLocation(prog, 'uPunch');
    uBoost = gl.getUniformLocation(prog, 'uBoost');
    uTheme = gl.getUniformLocation(prog, 'uTheme');
    gl.uniform1i(gl.getUniformLocation(prog, 'tScene'), 0);

    // The 2D canvas keeps drawing — it is the texture source — but stops being
    // what the player sees. `opacity` rather than `visibility: hidden` or
    // `display: none`: those two can let a browser skip rasterising the element,
    // and the whole design depends on it still producing pixels.
    canvas2d.style.opacity = '0';
    startTime = performance.now();
    glReady = true;
    return true;
}

function teardownGl() {
    if (gl) {
        if (tex) gl.deleteTexture(tex);
        if (vao) gl.deleteVertexArray(vao);
        if (prog) gl.deleteProgram(prog);
        // Deleting the objects is not the same as giving the context back:
        // detaching the canvas leaves the context live until GC collects it,
        // and the browser's live-context pool is small (~16 per renderer
        // process in Chrome). In an SPA that pool is shared with every other 3D
        // game the player visits, and exhausting it makes the NEXT getContext()
        // return null — which surfaces as GameShell's "needs 3D graphics" notice.
        gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    if (glCanvas && glCanvas.parentNode) glCanvas.parentNode.removeChild(glCanvas);
    if (sceneCanvas) sceneCanvas.style.opacity = '';
    gl = null; prog = null; vao = null; tex = null; glCanvas = null; glReady = false;
    uBoost = null; uTheme = null;
}

let lastSpeedDemonTime = 0;

function composite(speed01, boost01, themeId) {
    if (!glReady || !sceneCanvas) return;

    if (speed01 > 0.88) {
        const now = performance.now();
        if (now - lastSpeedDemonTime > 4000) {
            lastSpeedDemonTime = now;
            Cue.fire('poracer', 'speedDemon', { scale: 1.1 });
        }
    }
    const w = sceneCanvas.width;
    const h = sceneCanvas.height;
    if (!w || !h) return;
    if (glCanvas.width !== w || glCanvas.height !== h) {
        // Backing store only. The CSS size comes from `.racer-gl`'s inset:0 on
        // the wrapper, so it tracks the 2D canvas's layout automatically —
        // setting it inline here would fight that on every DPR change.
        glCanvas.width = w;
        glCanvas.height = h;
    }

    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Full re-upload rather than texSubImage2D: the canvas is fully repainted
    // every frame, so there is no sub-rectangle to spare, and reallocating lets
    // the driver handle a resize without a separate branch.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sceneCanvas);

    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniform2f(uRes, w, h);
    gl.uniform1f(uTime, (performance.now() - startTime) / 1000);
    gl.uniform1f(uSpeed, speed01);
    gl.uniform1f(uPunch, Impact.getPunch());
    if (uBoost) gl.uniform1f(uBoost, boost01 || 0);
    if (uTheme) gl.uniform1f(uTheme, themeId || 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ── Render loop ────────────────────────────────────────────────────────────

function frame() {
    raf = requestAnimationFrame(frame);
    if (!buf.length || !origDrawSnapshot) return;
    if (document.hidden) return;

    const newest = buf[buf.length - 1];
    const now = performance.now();
    if (now - newest.t > STALE_MS) return;   // connection stalled; hold the last frame

    // Where in server time this frame should show. The delay is FIXED — deriving
    // it from the buffer's current span instead makes it grow as the buffer fills,
    // which walks the sample point backwards during warm-up and reintroduces the
    // very stutter this is here to remove. sampleAt() clamps to the oldest sample
    // if the lookback outruns the history, which holds the frame for a moment
    // rather than jumping.
    const cars = sampleAt(buf, now + clockOffset - RENDER_DELAY_MS);
    if (!cars) return;

    const player = cars.find((c) => c.isPlayer) || cars[0];
    const speed01 = player ? Math.min(1, Math.abs(player.v || 0) / MAX_SPEED) : 0;
    const boost01 = player ? Math.min(1, Math.max(0, player.boost || 0)) : 0;
    const themeStr = window.PoRacerCurrentTheme || 'circuit';
    const themeId = themeStr === 'neonskyline' ? 1.0 : (themeStr === 'desertdustway' ? 2.0 : 0.0);

    origDrawSnapshot(mainId, miniId, newest.elapsedSec, newest.weather, cars);

    if (tierTaps() > 0) {
        if (!glReady) {
            const el = document.getElementById(mainId);
            if (el) ensureGl(el);
        }
        composite(speed01, boost01, themeId);
    } else if (glReady) {
        // Dropped to the low tier mid-session: hand the canvas back rather than
        // leaving a frozen composited frame on screen.
        teardownGl();
    }
}

/**
 * Patch PoRacerRender so snapshots are buffered and interpolated instead of
 * drawn on arrival. Idempotent.
 */
export function install() {
    if (installed) return true;
    const R = window.PoRacerRender;
    if (!R || typeof R.drawSnapshot !== 'function') return false;

    origDrawSnapshot = R.drawSnapshot.bind(R);
    R.drawSnapshot = (mainCanvasId, miniCanvasId, elapsedSec, weather, cars, serverTimeMs) => {
        if (!cars || !cars.length) return;
        mainId = mainCanvasId;
        miniId = miniCanvasId;

        const t = performance.now();
        // Fall back to arrival time if the caller predates the serverTimeMs
        // argument. Then the timeline is jittery again, but never wrong.
        const st = Number.isFinite(serverTimeMs) ? serverTimeMs : t;

        // Re-seed on the first snapshot, on a race restart (the sim's stopwatch
        // is per-race, so `st` walks backwards), and after a stall — in each case
        // the old buffer describes a different world and interpolating into it
        // would slide every car across the map.
        const offsetNow = st - t;
        if (clockOffset === null || !buf.length
            || st < buf[buf.length - 1].st
            || Math.abs(offsetNow - clockOffset) > STALE_MS) {
            buf = [];
            clockOffset = offsetNow;
        } else {
            // Same rate on both clocks, so this only ever chases network jitter.
            // Ease rather than track: a single late packet must not shove the
            // playback clock, which is what would make the whole field lurch.
            clockOffset += (offsetNow - clockOffset) * 0.05;
        }

        // The .NET marshaller hands us a fresh array each call, so the reference
        // is safe to retain; `cars` is never mutated after this point.
        buf.push({ st, t, elapsedSec, weather, cars });
        if (buf.length > BUFFER_MAX) buf.shift();

        if (!raf) raf = requestAnimationFrame(frame);
    };

    // Outdoors: almost no early reflections and a short, dark tail. See
    // acoustics.js — the default "generic room" made the track sound indoors.
    try { window.PoAcoustics?.setSpace('outdoor'); } catch { /* optional */ }

    installed = true;
    return true;
}

/** Restore the original renderer and drop the GL layer. */
export function uninstall() {
    if (!installed) return;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (origDrawSnapshot && window.PoRacerRender) {
        window.PoRacerRender.drawSnapshot = origDrawSnapshot;
    }
    teardownGl();
    buf = [];
    clockOffset = null;
    origDrawSnapshot = null;
    installed = false;
}

