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
//    2026-08-10 — THE BUFFER MUST BE DEEPER THAN THE DELAY. This held exactly two
//    snapshots (`prev`/`cur`) while rendering 80 ms in the past, i.e. it kept 50 ms
//    of history to serve a 80 ms lookback. On roughly 60% of frames `renderAt` fell
//    BEFORE the older of the two and the code fell through to "draw the newest
//    snapshot as-is" — which is 80 ms in the *future* of where the frame should be.
//    A car at constant speed rendered 50,50,50,50 → 0,5,10,15 → 100,100,100 →
//    50,55,60: a full-interval jump forward followed by a two-interval snap back,
//    twenty times a second. That was the "cars shake back and forth" report, and it
//    was the interpolator causing it, not the network.
//
//    The buffer is now a time-indexed ring and the lookback is clamped to the
//    history it actually holds, so the bracketing pair always exists.
//
// 1b. SERVER-CLOCK TIMELINE. Snapshots used to be stamped with their ARRIVAL time,
//    so playback speed tracked packet spacing: a pair delivered 30 ms apart replayed
//    50 ms of motion in 30 ms, the next pair at 70 ms replayed it slow. Every
//    delivery hiccup became a visible speed wobble. Each snapshot already carries
//    the sim's own monotonic clock (PoRacerRaceSnapshot.ServerTimeMs), so we
//    interpolate on THAT and keep a smoothed local→server offset. Positions and
//    their timestamps then come from the same clock, and arrival jitter is absorbed
//    by the offset filter instead of being rendered.
//
// 2. WEBGL2 COMPOSITE. The 2D scene is uploaded as a texture and passed through
//    a fragment shader for chromatic aberration, heat shimmer, speed lines, a
//    bright-pass bloom and a speed vignette — all scaled by actual speed, plus
//    the shared impact envelope on collisions.
//    (The radial motion blur this list used to lead with was removed 2026-08-08
//    at the user's request — see the note in the shader.)
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

    // ── Radial motion blur — REMOVED 2026-08-08 (user request) ─────────
    // This ran up to 12 weighted taps smeared outward from the frame centre,
    // ramped by uSpeed*0.055 + uPunch*0.10. Because a racing game spends
    // almost all of its time at speed, the smear was effectively always on and
    // the whole picture outside the very centre read as out of focus rather
    // than as fast — the same reason the equivalent effect came out of
    // PoMarbleRace. A single sharp read replaces the tap loop, so this is also
    // 11 fewer texture fetches per pixel per frame.
    //
    // The uTaps uniform went with the loop. tierTaps() stays: returning 0 is still what
    // switches the whole GL layer off on the low tier (see the guard in installGl()).
    vec3 col = texture(tScene, uv).rgb;

    // ── Chromatic aberration (cyberpunk lens flare on speed and punch) ──
    float ca = (uSpeed * 0.0028 + uPunch * 0.0090) * smoothstep(0.08, 0.92, r);
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
    bloom = max(bloom - 0.58, 0.0) * 2.2;
    col += bloom;

    // ── Speed warp and speed streaks ──────────────────────────────────
    float sl = smoothstep(0.48, 1.0, uSpeed);
    if (sl > 0.001) {
        float ang = atan(toC.y, toC.x);
        float lane = floor(ang * 32.0);
        float streak = step(0.78, hash11(lane + floor(uTime * 26.0)));
        float mask = smoothstep(0.24, 0.90, r) * streak * sl;
        col += vec3(0.0, 0.95, 1.0) * mask * 0.20 + vec3(1.0, 0.35, 0.85) * mask * 0.12;
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

/**
 * Car positions at server-clock instant `ts`.
 *
 * Every branch returns a value that is CONTINUOUS with its neighbours: clamped
 * to the oldest sample when we are behind the buffer, interpolated inside it,
 * and briefly extrapolated past the newest. The bug this replaced broke exactly
 * that property — its "behind the buffer" branch returned the NEWEST sample, so
 * falling off the back of the buffer teleported every car forward.
 */
function sampleAt(ts) {
    const n = buf.length;
    if (n === 0) return null;
    if (n === 1) return buf[0].cars;

    if (ts <= buf[0].st) return buf[0].cars;

    const last = buf[n - 1];
    if (ts >= last.st) {
        // Past the newest snapshot — a packet is late. Extrapolate along the last
        // known trajectory, but only briefly: beyond about one interval the guess
        // diverges badly on corners, and a car that visibly drives through a wall
        // and snaps back is worse than one that pauses.
        const before = buf[n - 2];
        const span = last.st - before.st;
        if (span <= 0) return last.cars;
        return interpolate(before, last, 1 + Math.min(ts - last.st, 60) / span);
    }

    for (let i = n - 1; i > 0; i--) {
        const a = buf[i - 1], b = buf[i];
        if (ts >= a.st) return interpolate(a, b, (ts - a.st) / (b.st - a.st));
    }
    return buf[0].cars;
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
    const cars = sampleAt(now + clockOffset - RENDER_DELAY_MS);
    if (!cars) return;

    const player = cars.find((c) => c.isPlayer) || cars[0];
    const speed01 = player ? Math.min(1, Math.abs(player.v || 0) / MAX_SPEED) : 0;

    origDrawSnapshot(mainId, miniId, newest.elapsedSec, newest.weather, cars);

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

if (typeof window !== 'undefined') {
    // racingInterop.js is a classic script and has already run by the time any
    // module evaluates, so PoRacerRender exists. Installing here rather than
    // from the page means the patch is in place before the first snapshot
    // arrives — a page-driven install would race the hub's initial push.
    install();
    window.addEventListener('pagehide', uninstall);
    window.PoRacerGl = { install, uninstall };
}
