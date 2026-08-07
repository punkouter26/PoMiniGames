// poracerGl.js — PoRacer's frame-rate and image quality layer (§GFX-1).
//
// THE PROBLEM
// PoRacer is a thin client: the server pushes a snapshot roughly every 50 ms and
// racingInterop.js drew one frame per snapshot. That is a hard 20 fps ceiling
// with no amount of GPU able to help, because no frame existed to draw between
// snapshots. On a 120 Hz phone the game was showing one frame in six. It also
// meant every car's motion was quantised to the network tick, which is what made
// the driving feel like it was on rails rather than under the player's hand.
//
// TWO FIXES, IN ORDER OF HOW MUCH THEY MATTER:
//
// 1. INTERPOLATION. Snapshots are buffered instead of drawn. A rAF loop renders
//    at display rate, reading the world at (now − RENDER_DELAY) and lerping
//    between the two snapshots that bracket that instant. This is the standard
//    client-side interpolation used by every networked game, and the delay is
//    the price: rendering slightly in the past is what guarantees there are two
//    real samples to interpolate between, rather than extrapolating into a
//    future that has not arrived.
//
//    RENDER_DELAY is ~1.6 snapshot intervals. Less and a single late packet
//    leaves nothing to interpolate toward, so the cars stutter — which is worse
//    than the extra 30 ms of latency, since PoRacer's input already round-trips
//    to the server anyway.
//
// 2. WEBGL2 COMPOSITE. The 2D scene is uploaded as a texture and passed through
//    a fragment shader for radial motion blur, chromatic aberration, heat
//    shimmer, speed lines and a bright-pass bloom — all scaled by actual speed,
//    plus the shared impact envelope on collisions.
//
//    KEEPING THE 2D DRAWING WAS DELIBERATE. Reimplementing racingInterop.js's
//    ~1,400 lines of track, weather, smoke, skid and car rendering in WebGL
//    would be a rewrite with a large surface for regressions, to arrive at an
//    image the player would find *equivalent*. Compositing instead costs one
//    texture upload per frame and buys effects that are impossible in Canvas2D
//    at any price. The upload is the honest cost of this design and it is why
//    the GL layer switches itself off on the low tier.

import * as Impact from './impactBus.js';

const RENDER_DELAY_MS = 80;
// Snapshots older than this are dropped: a tab that was backgrounded comes back
// with a stale buffer, and interpolating across that gap would slide every car
// across the map.
const STALE_MS = 1500;

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
uniform int   uTaps;     // motion-blur sample count, from the quality tier

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
    // rises with speed: still air does not shimmer, air being torn through does.
    float haze = (0.25 + uSpeed * 0.75) * 0.0016;
    uv += vec2(
        sin(uv.y * 46.0 + uTime * 3.1) * haze,
        cos(uv.x * 38.0 + uTime * 2.4) * haze * 0.6);

    // ── Radial motion blur ─────────────────────────────────────────────
    // Radial and not directional: the camera is locked behind the car, so on
    // screen the world streams outward from the vanishing point. Blurring along
    // the velocity vector would be correct for a fixed camera and wrong here.
    //
    // Strength is zero at the centre and grows with radius — the middle of the
    // frame is where the player is looking and where the car is, and smearing
    // it makes the game feel drunk rather than fast.
    float amount = (uSpeed * 0.055 + uPunch * 0.10) * smoothstep(0.05, 0.75, r);
    vec3 col = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i < 16; i++) {
        if (i >= uTaps) break;
        float t = float(i) / float(uTaps);
        // Weight the near samples more heavily: an unweighted box smear reads
        // as a ghost image, a weighted one reads as motion.
        float wgt = 1.0 - t * 0.65;
        vec2 s = uv - toC * (t * amount);
        col += texture(tScene, s).rgb * wgt;
        total += wgt;
    }
    col /= max(total, 0.0001);

    // ── Chromatic aberration ───────────────────────────────────────────
    // Radial, scaled by the same radius mask, so the frame edges fringe and the
    // centre stays clean — which is how a real wide lens behaves.
    float ca = (uSpeed * 0.0016 + uPunch * 0.0060) * smoothstep(0.1, 0.9, r);
    if (ca > 0.00002) {
        vec2 dir = r > 0.0001 ? toC / r : vec2(0.0);
        col.r = texture(tScene, uv - dir * ca).r;
        col.b = texture(tScene, uv + dir * ca).b;
    }

    // ── Bright-pass bloom ──────────────────────────────────────────────
    // Four wide taps rather than a separable gaussian in its own pass: at this
    // radius the difference is invisible over a scene that is mostly dark
    // asphalt, and it saves two full-screen render targets.
    vec3 bloom = vec3(0.0);
    vec2 px = 2.5 / uRes;
    bloom += texture(tScene, uv + vec2( px.x,  px.y) * 3.0).rgb;
    bloom += texture(tScene, uv + vec2(-px.x,  px.y) * 3.0).rgb;
    bloom += texture(tScene, uv + vec2( px.x, -px.y) * 3.0).rgb;
    bloom += texture(tScene, uv + vec2(-px.x, -px.y) * 3.0).rgb;
    bloom *= 0.25;
    // Only what is already bright blooms. Without the threshold the whole image
    // just gets a soft glow, which reads as an out-of-focus screen.
    bloom = max(bloom - 0.62, 0.0) * 1.9;
    col += bloom;

    // ── Speed lines ────────────────────────────────────────────────────
    // Radial streaks hashed by angle so they are stable frame to frame at a
    // given angle but irregular around the circle. Gated hard on speed: at a
    // standstill they must be completely absent, not merely faint.
    float sl = smoothstep(0.55, 1.0, uSpeed);
    if (sl > 0.001) {
        float ang = atan(toC.y, toC.x);
        float lane = floor(ang * 26.0);
        float streak = step(0.82, hash11(lane + floor(uTime * 22.0)));
        float mask = smoothstep(0.28, 0.85, r) * streak * sl;
        col += vec3(0.85, 0.92, 1.0) * mask * 0.16;
    }

    // ── Speed vignette ─────────────────────────────────────────────────
    // Tunnel vision at speed. A constant vignette is a look; one that closes in
    // as you accelerate is information.
    col *= 1.0 - smoothstep(0.35, 0.95, r) * (0.18 + uSpeed * 0.22);

    frag = vec4(col, 1.0);
}`;

// ── Snapshot buffer ────────────────────────────────────────────────────────

let prev = null;      // {t, elapsedSec, weather, cars}
let cur = null;
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
let uTaps = null;
let sceneCanvas = null;
let glReady = false;
let startTime = 0;

/** Top speed used to normalise the shader's uSpeed. Matches the C# car model. */
const MAX_SPEED = 380;

function tierTaps() {
    switch (document.documentElement.getAttribute('data-gfx')) {
        case 'low': return 0;      // 0 disables the GL layer entirely
        case 'medium': return 6;
        default: return 12;
    }
}

/** Shortest-arc angle interpolation. Plain lerp spins a car the long way round
 *  whenever its heading crosses ±π, which is once per lap on most corners. */
function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
}

/**
 * Build the car array for a point in time between two snapshots.
 * Identity is by array index rather than by name: the server sends a stable
 * ordering, and matching on a string per car per frame would allocate.
 */
function interpolate(a, b, t) {
    const out = new Array(b.cars.length);
    for (let i = 0; i < b.cars.length; i++) {
        const cb = b.cars[i];
        const ca = a && a.cars[i] && a.cars[i].name === cb.name ? a.cars[i] : cb;
        out[i] = {
            ...cb,
            x: ca.x + (cb.x - ca.x) * t,
            y: ca.y + (cb.y - ca.y) * t,
            h: lerpAngle(ca.h, cb.h, t),
            v: ca.v + (cb.v - ca.v) * t,
            // boost and skid are 0..1 intensities that drive particle spawns and
            // glow; interpolating them keeps those effects smooth too.
            boost: (ca.boost || 0) + ((cb.boost || 0) - (ca.boost || 0)) * t,
            skid: (ca.skid || 0) + ((cb.skid || 0) - (ca.skid || 0)) * t,
        };
    }
    return out;
}

// ── GL composite ───────────────────────────────────────────────────────────

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
    uTaps = gl.getUniformLocation(prog, 'uTaps');
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
    }
    if (glCanvas && glCanvas.parentNode) glCanvas.parentNode.removeChild(glCanvas);
    if (sceneCanvas) sceneCanvas.style.opacity = '';
    gl = null; prog = null; vao = null; tex = null; glCanvas = null; glReady = false;
}

function composite(speed01) {
    if (!glReady || !sceneCanvas) return;
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
    gl.uniform1i(uTaps, tierTaps());
    gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ── Render loop ────────────────────────────────────────────────────────────

function frame() {
    raf = requestAnimationFrame(frame);
    if (!cur || !origDrawSnapshot) return;
    if (document.hidden) return;

    const now = performance.now();
    if (now - cur.t > STALE_MS) return;   // connection stalled; hold the last frame

    const renderAt = now - RENDER_DELAY_MS;
    let cars;
    if (prev && renderAt >= prev.t && renderAt <= cur.t && cur.t > prev.t) {
        cars = interpolate(prev, cur, (renderAt - prev.t) / (cur.t - prev.t));
    } else if (prev && renderAt > cur.t) {
        // Ahead of the newest snapshot — a packet is late. Extrapolate along the
        // last known trajectory, but only briefly: beyond about one interval the
        // guess diverges badly on corners, and a car that visibly drives through
        // a wall and snaps back is worse than one that pauses.
        const over = Math.min(renderAt - cur.t, 60) / Math.max(1, cur.t - prev.t);
        cars = interpolate(prev, cur, 1 + over);
    } else {
        cars = cur.cars;
    }

    const player = cars.find((c) => c.isPlayer) || cars[0];
    const speed01 = player ? Math.min(1, Math.abs(player.v || 0) / MAX_SPEED) : 0;

    origDrawSnapshot(mainId, miniId, cur.elapsedSec, cur.weather, cars);

    if (tierTaps() > 0) {
        if (!glReady) {
            const el = document.getElementById(mainId);
            if (el) ensureGl(el);
        }
        composite(speed01);
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
    R.drawSnapshot = (mainCanvasId, miniCanvasId, elapsedSec, weather, cars) => {
        if (!cars || !cars.length) return;
        mainId = mainCanvasId;
        miniId = miniCanvasId;
        prev = cur;
        // The .NET marshaller hands us a fresh array each call, so the reference
        // is safe to retain; `cars` is never mutated after this point.
        cur = { t: performance.now(), elapsedSec, weather, cars };
        // A snapshot arriving after a stall would otherwise be interpolated
        // against a snapshot from before it, sliding every car across the map.
        if (prev && cur.t - prev.t > STALE_MS) prev = null;
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
    prev = cur = null;
    origDrawSnapshot = null;
    installed = false;
}

if (typeof window !== 'undefined') {
    // racingInterop.js is a classic script and has already run by the time any
    // module evaluates, so PoRacerRender exists. Installing here rather than
    // from the page means the patch is in place before the first snapshot
    // arrives — a page-driven install would race the hub's initial push.
    install();
    window.addEventListener('pagehide', uninstall);
    window.PoRacerGl = { install, uninstall };
}
