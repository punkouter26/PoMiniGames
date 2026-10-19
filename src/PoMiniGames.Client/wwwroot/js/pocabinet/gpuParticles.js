// pocabinet/gpuParticles.js
//
// GPU smoke, dust, spray and fire for PoCabinet: WebGL2 GPGPU (three's WebGLRenderer, so it
// shares the scene's context; a WebGPU compute path would mean swapping the whole renderer).
// fx.js owns it on the 'medium' and 'high' quality tiers; on 'low' (or if float render targets
// are missing, or a shader fails to build) fx.js keeps its CPU pools instead.
//
// State lives in float textures, one texel per particle (high 256×128 = 32 768, medium
// 128×64 = 8 192):
//   state  (ping-pong, 2 attachments)  pos.xyz + age        vel.xyz + ground height
//   params (written at spawn only)     life, size0, size1, alpha     rgb (packed), heat, drag, gravity
//
// Each frame, from fx.js's update() (before the scene is drawn; the previous render target,
// autoClear and clear colour are restored afterwards):
//   1. sim — one full-screen pass, two outputs: drag toward a gusting global wind, buoyancy
//      (gravity < 0 rises; hot plumes rise hard and cool), 3D curl-noise turbulence that
//      evolves over time, ground contact against the height the particle was thrown from (the
//      road's height under the car, so hills and banking are no trouble), and the nearest 16
//      cars: each one's capsule pushes smoke aside and drags it along, and its wake trails two
//      counter-rotating vortices, so a car through a cloud parts and swirls it.
//   2. spawn — the frame's emissions (fx.js decides where and how much, exactly as before)
//      batched into a small vertex buffer and scattered as 1-px points into the next slots of
//      the ring (oldest particles are overwritten), into both state and params.
//   3. sun density — every particle splatted into a small sun-view map: Σα, Σα·d, Σα·d²
//      (d = depth along the sun ray). Read back per particle as a Gaussian column: the share of
//      the column's mass between it and the sun gives its transmittance, so a cloud's sunward
//      skin is bright and its far side and core sit in its own shadow.
//   4. render — one instanced draw of camera-facing quads, positions fetched from the state
//      texture (no per-particle JS work, ever). Procedural noise density (a noise texture
//      generated at start, no image files), a sphere normal bent by the noise for wrap
//      lighting from the sun (brighter rim toward it, darker core), Henyey-Greenstein forward
//      scatter when looking toward the sun, hemisphere ambient, the scene's linear fog,
//      distance and near-lens fades, a soft edge where it meets the ground. Premultiplied
//      blending, unsorted: many particles at low alpha. Fire writes HDR emission with alpha 0
//      (additive in the same draw) for the bloom to catch, then turns into black smoke.
//
// Cost follows the smoke, not the capacity: a log of each frame's spawns gives the ring's live
// window (slots spawned within the longest life still running), and only that window is
// splatted and drawn. A fill-rate governor thins the emission (down to 30%) while the frame
// rate sits under 50 fps and restores it above 56, so smoke never forces scene.js's tier drop.
//
// Reduced motion (scene.fx.reduced): turbulence, wake swirl, spin and flicker are calmed.
// Render only: it reads poses race.js already draws and never touches the sim.

import * as THREE from 'three';

const TIERS = {
    medium: { w: 128, h: 64, mult: 0.4, shadow: 192, maxSpawn: 1024 },
    high: { w: 256, h: 128, mult: 1, shadow: 256, maxSpawn: 3072 },
};
const MAX_CARS = 16;
const RANGE = 250;            // world units from the camera: further off, nothing is emitted
const FADE_FAR = 240;         // and particles fade out by here
const SHADOW_EXTENT = 64;     // half-size of the sun-view density map, world units
const SHADOW_NEAR = 30, SHADOW_FAR = 230, SHADOW_BACK = 130;

/** Emission kinds fx.js asks for. */
export const PUFF = { TYRE: 0, DUST: 1, GRIT: 2, SPRAY: 3, ENGINE: 4, WRECK: 5, FIRE: 6 };

// Per kind, applied to fx.js's CPU-pool numbers: n particles per request (high tier), life,
// end size and per-particle alpha multipliers, spread (jitter radius) and heat (1 = fire).
const KIND = [
    { n: 2, life: 2.0, size: 1.0, alpha: 1.0, spread: 0.3, heat: 0 },       // tyre smoke: hangs, spreads
    { n: 2, life: 1.7, size: 1.05, alpha: 0.8, spread: 0.35, heat: 0 },     // grass / gravel dust
    { n: 2, life: 1.2, size: 1.0, alpha: 0.8, spread: 0.3, heat: 0 },       // kerb grit
    { n: 2, life: 1.1, size: 1.0, alpha: 0.8, spread: 0.3, heat: 0 },       // rain spray
    { n: 2, life: 1.5, size: 1.0, alpha: 0.8, spread: 0.2, heat: 0 },       // engine smoke
    { n: 2, life: 1.5, size: 1.0, alpha: 0.75, spread: 0.3, heat: 0 },      // wreck smoke
    { n: 2, life: 2.0, size: 1.0, alpha: 1.0, spread: 0.25, heat: 1 },      // fire → black smoke
];
// Fill-rate governor: below GOV_LOW fps (real time) emission thins out, down to GOV_MIN of
// the tier's rate; above GOV_HIGH it recovers. Keeps smoke from pushing scene.js's automatic
// quality step-down (45 fps).
const GOV_LOW = 50, GOV_HIGH = 56, GOV_MIN = 0.3;

const QUAD_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// webgl-noise (Ashima Arts / Stefan Gustavson, MIT): 3D simplex noise with analytic gradient.
const SNOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v, out vec3 gradient) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    vec4 m2 = m * m;
    vec4 m4 = m2 * m2;
    vec4 pdotx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
    vec4 temp = m2 * m * pdotx;
    gradient = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
    gradient += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
    gradient *= 105.0;
    return 105.0 * dot(m4, pdotx);
}
// Curl of three noise potentials: a divergence-free swirl field.
vec3 curl(vec3 p) {
    vec3 g1, g2, g3;
    snoise(p, g1);
    snoise(p + vec3(31.416, -47.853, 12.793), g2);
    snoise(p + vec3(-233.145, -113.408, -185.31), g3);
    return vec3(g3.y - g2.z, g1.z - g3.x, g2.x - g1.y);
}`;

const SIM_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tPos;
uniform highp sampler2D tVel;
uniform highp sampler2D tA;
uniform highp sampler2D tB;
uniform float uDt;
uniform float uTime;
uniform float uTurb;
uniform float uSwirl;
uniform vec3 uWind;
uniform vec4 uCarPos[${MAX_CARS}];   // x, road height, z, heading
uniform vec4 uCarVel[${MAX_CARS}];   // vx, 0, vz, 1 = slot in use
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
${SNOISE}
void main() {
    ivec2 ij = ivec2(gl_FragCoord.xy);
    vec4 P = texelFetch(tPos, ij, 0);
    vec4 V = texelFetch(tVel, ij, 0);
    vec4 A = texelFetch(tA, ij, 0);
    float age = P.w + uDt;
    if (A.x <= 0.0 || age >= A.x) { oPos = vec4(P.xyz, max(age, A.x + 1.0)); oVel = V; return; }
    vec4 B = texelFetch(tB, ij, 0);
    float f = age / A.x;
    float heat = B.y, drag = B.z, grav = B.w;
    vec3 p = P.xyz, v = V.xyz;
    float floorY = V.w;
    float size = mix(A.y, A.z, 1.0 - (1.0 - f) * (1.0 - f));

    // Air moves with the wind, less of it down at the ground.
    vec3 wind = uWind * clamp((p.y - floorY) * 0.5 + 0.35, 0.35, 1.0);
    v = wind + (v - wind) * exp(-drag * uDt);
    // Buoyancy: hot plumes rise hard while young and cool as they go.
    v.y -= grav * (heat > 0.0 ? mix(1.8, 0.45, f) : 1.0) * uDt;
    // Turbulence: two octaves of curl noise drifting through time; a fresh puff still
    // follows the way it was thrown, an old one wanders. Heavy grit barely notices.
    vec3 q = p * 0.19 + vec3(0.0, -uTime * 0.21, uTime * 0.13);
    vec3 cn = curl(q) + 0.45 * curl(q * 2.4 + vec3(17.0, 3.0, -9.0));
    float tk = uTurb * clamp(1.0 - grav * 0.25, 0.25, 1.4) * (0.35 + 1.3 * smoothstep(0.0, 0.35, f)) * (1.0 + heat * 0.8);
    v += cn * tk * uDt;

    // Cars: the capsule shoves smoke aside and drags it along; the wake rolls it into two vortices.
    for (int i = 0; i < ${MAX_CARS}; i++) {
        vec4 cv = uCarVel[i];
        if (cv.w < 0.5) continue;
        vec4 cp = uCarPos[i];
        vec3 rel = p - cp.xyz;
        if (rel.y > 3.5 || rel.y < -1.5 || dot(rel.xz, rel.xz) > 196.0) continue;
        vec2 fw = vec2(cos(cp.w), sin(cp.w));
        vec2 rt = vec2(-fw.y, fw.x);
        float along = dot(rel.xz, fw);
        float across = dot(rel.xz, rt);
        float spd = length(cv.xz);
        float a = clamp(along, -1.25, 1.25);
        vec2 d = rel.xz - fw * a;
        float dist = length(d) + 1e-4;
        float over = max(0.0, rel.y - 1.15);
        float dd = length(vec2(max(0.0, dist - 0.95), over));
        float infl = 1.0 - smoothstep(0.0, 1.6, dd);
        if (infl > 0.0) {
            vec2 outw = d / dist;
            float push = (1.5 + spd * 0.55) * infl;
            v.xz += outw * push * uDt * 6.0;
            v.y += push * 0.35 * uDt * 6.0;
            v.xz += (cv.xz - v.xz) * infl * min(1.0, uDt * 5.0) * 0.7;
            if (dd <= 0.0) p.xz = cp.xz + fw * a + outw * 0.95;
        }
        float back = -along - 1.3;
        if (back > 0.0 && back < 11.0 && abs(across) < 2.6 && rel.y < 2.8 && spd > 1.0) {
            float w = (1.0 - back / 11.0) * (1.0 - smoothstep(1.2, 2.6, abs(across))) * min(1.0, spd / 18.0);
            v.xz += (cv.xz * 0.6 - v.xz) * w * min(1.0, uDt * 3.5);
            // Twin vortices off the car's flanks, counter-rotating: up the outside, in over the top.
            float side = across >= 0.0 ? 1.0 : -1.0;
            vec2 r = vec2(across - side * 0.85, rel.y - 0.65);
            float rr = dot(r, r);
            vec2 tang = vec2(-r.y, r.x) * side;
            float sw = uSwirl * spd * 0.22 * w * exp(-rr * 0.6);
            v.xz += rt * tang.x * sw * uDt * 6.0;
            v.y += tang.y * sw * uDt * 6.0;
        }
    }

    p += v * uDt;
    // The ground it was thrown from: a puff rests on it (half sunk) and spreads along it.
    float rest = floorY + size * 0.2;
    if (p.y < rest) { p.y = rest; v.y = abs(v.y) * 0.15; }
    oPos = vec4(p, age);
    oVel = vec4(v, floorY);
}`;

const SPAWN_VERT = /* glsl */ `
attribute float aSlot;
attribute vec4 aVel;
attribute vec4 aA;
attribute vec4 aB;
uniform vec2 uTex;
varying vec4 vPos;
varying vec4 vVel;
varying vec4 vA;
varying vec4 vB;
void main() {
    float x = mod(aSlot, uTex.x), y = floor(aSlot / uTex.x);
    gl_Position = vec4((x + 0.5) / uTex.x * 2.0 - 1.0, (y + 0.5) / uTex.y * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = 1.0;
    vPos = vec4(position, 0.0);
    vVel = aVel; vA = aA; vB = aB;
}`;

const SPAWN_STATE_FRAG = /* glsl */ `
precision highp float;
varying vec4 vPos;
varying vec4 vVel;
varying vec4 vA;
varying vec4 vB;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() { o0 = vPos; o1 = vVel; }`;

const SPAWN_PARAM_FRAG = SPAWN_STATE_FRAG.replace('o0 = vPos; o1 = vVel;', 'o0 = vA; o1 = vB;');

// Shared by the sun-density splat and the render: life envelope, size and fire phase.
const ENVELOPE = /* glsl */ `
uniform highp sampler2D tPos;
uniform highp sampler2D tA;
uniform highp sampler2D tB;
uniform vec2 uTex;
uniform vec2 uWindow;        // first live slot of the ring, slot count: draw i is slot (start + i) mod count
float hash1(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
float slotOf(float i) { return mod(uWindow.x + i, uWindow.y); }
ivec2 texelOf(float slot) { return ivec2(int(mod(slot, uTex.x)), int(floor(slot / uTex.x))); }
// out: position + age, params B, size, smoke alpha, fire phase (−1 = not fire), age fraction
bool envelope(float slot, out vec4 P, out vec4 B, out float size, out float alpha, out float firePhase, out float f) {
    ivec2 ij = texelOf(slot);
    P = texelFetch(tPos, ij, 0);
    vec4 A = texelFetch(tA, ij, 0);
    f = P.w / max(A.x, 1e-3);
    if (A.x <= 0.0 || f >= 1.0) return false;
    B = texelFetch(tB, ij, 0);
    size = mix(A.y, A.z, 1.0 - (1.0 - f) * (1.0 - f));
    alpha = A.w * smoothstep(0.0, 0.07, f) * pow(1.0 - f, 1.4);
    firePhase = -1.0;
    if (B.y > 0.0) {
        firePhase = f / 0.4;
        size = mix(A.y * 1.5, A.z, smoothstep(0.3, 1.0, f));
        alpha = A.w * smoothstep(0.45, 1.0, firePhase) * pow(1.0 - f, 1.2);
    }
    return true;
}`;

const SHADOW_VERT = /* glsl */ `
${ENVELOPE}
uniform float uPxPerUnit;
varying float vW;
varying float vD;
void main() {
    vec4 P, B; float size, alpha, fp, f;
    if (!envelope(slotOf(position.x), P, B, size, alpha, fp, f) || alpha < 0.002) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    vec4 c = projectionMatrix * viewMatrix * vec4(P.xyz, 1.0);
    gl_Position = c;
    float px = size * uPxPerUnit;
    gl_PointSize = max(px, 1.5);
    vW = alpha * min(1.0, px * px / 2.25);
    vD = c.z;
}`;

const SHADOW_FRAG = /* glsl */ `
varying float vW;
varying float vD;
void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float w = vW * max(0.0, 1.0 - dot(q, q)) * 1.5;
    gl_FragColor = vec4(w, w * vD, w * vD * vD, 0.0);
}`;

const RENDER_VERT = /* glsl */ `
${ENVELOPE}
attribute float aSlot;
uniform highp sampler2D tVel;
uniform sampler2D tShadow;
uniform mat4 uShadowMat;
uniform vec3 uShadow;        // on, extinction, depth units per world unit
uniform float uScale;        // pixels per world unit at depth 1
uniform float uMaxPx;
uniform float uFar;
uniform float uTime;
uniform float uMotion;
varying vec2 vC;
varying vec2 vN;
varying vec2 vSeed;
varying vec4 vCol;           // albedo, alpha
varying vec3 vFire;          // HDR emission
varying vec3 vL;             // sun transmittance, age fraction, ground
varying vec3 vView;
varying vec4 vSun;           // sun direction (view space), forward-scatter phase
uniform vec3 uSunDir;
void main() {
    float slot = slotOf(aSlot);
    vec4 P, B; float size, alpha, fp, f;
    if (!envelope(slot, P, B, size, alpha, fp, f)) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    float fire = 0.0;
    vec3 fireCol = vec3(0.0);
    if (fp >= 0.0 && fp < 1.0) {
        float t = fp;
        fireCol = mix(vec3(2.6, 1.9, 0.9), vec3(1.8, 0.62, 0.12), smoothstep(0.0, 0.4, t));
        fireCol = mix(fireCol, vec3(0.5, 0.07, 0.01), smoothstep(0.4, 0.8, t)) * (1.0 - smoothstep(0.65, 1.0, t));
        fireCol *= B.y * (1.0 + uMotion * 0.25 * sin(uTime * 31.0 + slot * 1.7));
        fire = 1.0;
    }
    vec4 mv = viewMatrix * vec4(P.xyz, 1.0);
    float depth = -mv.z;
    float px = size * uScale / max(depth, 0.1);
    float fade = smoothstep(1.2, 4.5, depth) * (1.0 - smoothstep(uFar * 0.7, uFar, depth)) * smoothstep(uMaxPx * 1.6, uMaxPx, px);
    alpha *= fade;
    fireCol *= fade;
    if (depth < 0.4 || (alpha < 0.0015 && fire * fade < 0.01)) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

    float sd = hash1(slot);
    float ang = sd * 6.2832 + P.w * uMotion * (sd - 0.5) * 0.8;
    float ca = cos(ang), sa = sin(ang);
    vec2 cr = mat2(ca, sa, -sa, ca) * position.xy;
    mv.xy += cr * size;
    gl_Position = projectionMatrix * mv;
    vC = cr * 2.0;
    vN = position.xy + 0.5;
    vSeed = vec2(hash1(slot + 1.7), hash1(slot + 5.3));
    vView = mv.xyz;
    // Forward scatter (Henyey-Greenstein, g 0.6, 1 = isotropic): thin smoke glows against the sun.
    vec3 Lv = normalize(mat3(viewMatrix) * uSunDir);
    float cosT = dot(normalize(mv.xyz), Lv);
    vSun = vec4(Lv, 0.64 / pow(1.36 - 1.2 * cosT, 1.5));

    // How far this corner is above the ground the particle rests on, in particle radii.
    float floorY = texelFetch(tVel, texelOf(slot), 0).w;
    float wy = P.y + (cr.x * viewMatrix[1][0] + cr.y * viewMatrix[1][1]) * size;
    float ground = (wy - floorY) / max(size * 0.5, 0.05);

    // Sun transmittance through the cloud: the column's mass in front of this particle.
    float T = 1.0;
    if (uShadow.x > 0.5) {
        vec4 sc = uShadowMat * vec4(P.xyz, 1.0);
        float edge = 1.0 - smoothstep(0.85, 1.0, max(abs(sc.x), abs(sc.y)));
        if (edge > 0.0) {
            vec3 S = texture2D(tShadow, sc.xy * 0.5 + 0.5).rgb;
            if (S.x > 1e-3) {
                float mu = S.y / S.x;
                float sig = sqrt(max(S.z / S.x - mu * mu, 0.0) + pow(size * uShadow.z * 0.35, 2.0)) + 1e-4;
                float front = 1.0 / (1.0 + exp(-1.7 * (sc.z - mu) / sig));
                T = mix(1.0, 0.22 + 0.78 * exp(-uShadow.y * S.x * front), edge);   // never black: light scatters in
            }
        }
    }
    float cr8 = B.x;
    vec3 rgb = vec3(mod(cr8, 256.0), mod(floor(cr8 / 256.0), 256.0), floor(cr8 / 65536.0)) / 255.0;
    vCol = vec4(rgb, alpha);
    vFire = fireCol;
    vL = vec3(T, f, ground);
}`;

const RENDER_FRAG = /* glsl */ `
uniform sampler2D tNoise;
uniform vec3 uSunCol;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uFogColor;
uniform vec2 uFog;
varying vec2 vC;
varying vec2 vN;
varying vec2 vSeed;
varying vec4 vCol;
varying vec3 vFire;
varying vec3 vL;
varying vec3 vView;
varying vec4 vSun;
void main() {
    float r2 = dot(vC, vC);
    if (r2 >= 1.0) discard;
    float f = vL.y;
    vec2 uv = vN * 0.42 + vSeed;
    vec4 n1 = texture2D(tNoise, uv);
    vec4 n2 = texture2D(tNoise, uv * 1.9 + vec2(0.31 + f * 0.3, 0.17 - f * 0.22));
    float nz = n1.r * 0.6 + n2.g * 0.4;
    float shape = 1.0 - r2;
    // Billowy, and older puffs tear apart at the edges.
    float dens = smoothstep(0.0, 0.6, shape * 1.15 + (nz - 0.5) * (1.3 + f * 0.9) - 0.15 - f * 0.35);
    dens *= smoothstep(-0.2, 0.6, vL.z);
    float a = vCol.a * dens;
    // Flame: ragged tongues, hottest in the middle.
    float flame = clamp(shape * 1.7 + (nz - 0.5) * 2.4 - 0.55 - f * 0.5, 0.0, 1.0);
    vec3 emi = vFire * flame * flame;
    if (a < 0.0015 && dot(emi, vec3(1.0)) < 0.004) discard;

    // A sphere normal bent by the noise: wrap-lit from the sun, the core darker.
    vec2 grad = n1.ba - 0.5;
    vec3 nrm = normalize(vec3(vC + grad * 1.3, sqrt(max(1.0 - r2, 0.0)) + 0.15));
    float wrap = clamp(dot(nrm, vSun.xyz) * 0.65 + 0.35, 0.0, 1.0);
    float core = smoothstep(0.3, 1.0, dens);
    float T = vL.x;
    float hg = vSun.w;
    vec3 direct = uSunCol * T * (wrap * mix(1.0, 0.6, core) + hg * 0.12 * (1.0 - core * 0.7));
    float upW = dot(mat3(viewMatrix)[1], nrm);
    vec3 amb = mix(uGround, uSky, clamp(upW * 0.5 + 0.5, 0.0, 1.0)) * mix(0.7, 1.0, T) * mix(1.0, 0.8, core);
    vec3 col = vCol.rgb * (direct + amb);

    float fz = smoothstep(uFog.x, uFog.y, -vView.z);
    col = mix(col, uFogColor, fz);
    emi *= 1.0 - fz;
    gl_FragColor = vec4(col * a + emi, a);
    #include <colorspace_fragment>
}`;

/** Tileable value-noise fbm (r), billowy fbm (g) and the gradient of r (b, a). */
function noiseTexture(size = 128) {
    let seed = 1234567;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const layer = period => {
        const g = new Float32Array(period * period);
        for (let i = 0; i < g.length; i++) g[i] = rnd();
        return { g, period };
    };
    const sample = (L, u, v) => {
        const p = L.period, x = u * p, y = v * p;
        const xi = Math.floor(x), yi = Math.floor(y);
        const fx = x - xi, fy = y - yi;
        const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
        const x0 = ((xi % p) + p) % p, x1 = (x0 + 1) % p, y0 = ((yi % p) + p) % p, y1 = (y0 + 1) % p;
        const a = L.g[y0 * p + x0], b = L.g[y0 * p + x1], c = L.g[y1 * p + x0], d = L.g[y1 * p + x1];
        return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
    };
    const A = [4, 8, 16, 32].map(layer), Bl = [6, 12, 24, 48].map(layer);
    const r = new Float32Array(size * size), gch = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            const u = i / size, v = j / size;
            let s = 0, w = 0.5, t = 0, tw = 0.55;
            for (const L of A) { s += sample(L, u, v) * w; w *= 0.5; }
            for (const L of Bl) { t += (1 - Math.abs(sample(L, u, v) * 2 - 1)) * tw; tw *= 0.5; }
            r[j * size + i] = s;
            gch[j * size + i] = t;
        }
    }
    const norm = a => {
        let lo = Infinity, hi = -Infinity;
        for (const x of a) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
        for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / Math.max(1e-6, hi - lo);
    };
    norm(r); norm(gch);
    const data = new Uint8Array(size * size * 4);
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            const k = j * size + i;
            const dx = r[j * size + (i + 1) % size] - r[j * size + (i + size - 1) % size];
            const dy = r[((j + 1) % size) * size + i] - r[((j + size - 1) % size) * size + i];
            data[k * 4] = r[k] * 255;
            data[k * 4 + 1] = gch[k] * 255;
            data[k * 4 + 2] = Math.max(0, Math.min(255, 128 + dx * size * 6));
            data[k * 4 + 3] = Math.max(0, Math.min(255, 128 + dy * size * 6));
        }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
}

function floatTarget(w, h, count, type = THREE.FloatType, filter = THREE.NearestFilter) {
    return new THREE.WebGLRenderTarget(w, h, {
        count, type, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter,
        depthBuffer: false, generateMipmaps: false,
    });
}

const additive = {
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
};

/** Whether this renderer can run the GPU particles at all (float render targets). */
export function gpuParticlesSupported(renderer) {
    try { return !!renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float'); } catch { return false; }
}

export class GpuParticles {
    /**
     * @param sceneHandle scene.js SceneHandle (renderer, camera, sun, hemi, fog, fx bag)
     * @param tier        'medium' | 'high'
     */
    constructor(sceneHandle, tier) {
        const cfg = TIERS[tier];
        if (!cfg) throw new Error(`pocabinet/gpuParticles: no tier ${tier}`);
        const r = sceneHandle.renderer;
        if (!gpuParticlesSupported(r)) throw new Error('pocabinet/gpuParticles: float render targets unavailable');
        this.sh = sceneHandle;
        this.renderer = r;
        this.tier = tier;
        this.W = cfg.w; this.H = cfg.h; this.count = cfg.w * cfg.h;
        this.mult = cfg.mult;
        this.maxSpawn = cfg.maxSpawn;
        this.next = 0;
        this.time = 0;
        this.frames = 0;
        this.failed = false;
        this.budget = 1;          // emission share the fill-rate governor allows (GOV_MIN..1)
        this.frameMs = 1000 / 60;
        this.lastNow = 0;
        this.camX = 0; this.camZ = 0;
        const ang = Math.random() * Math.PI * 2;
        this.windDir = new THREE.Vector2(Math.cos(ang), Math.sin(ang));
        this.windSpeed = 0.6 + Math.random() * 0.6;

        // ── State ──
        this.state = [floatTarget(this.W, this.H, 2), floatTarget(this.W, this.H, 2)];
        this.params = floatTarget(this.W, this.H, 2);
        this.cur = 0;
        const blendable = r.extensions.has('EXT_float_blend');
        this.shadowSize = cfg.shadow;
        this.shadow = floatTarget(cfg.shadow, cfg.shadow, 1, blendable ? THREE.FloatType : THREE.HalfFloatType, THREE.LinearFilter);
        this.noise = noiseTexture(128);
        const tex = new THREE.Vector2(this.W, this.H);
        // The live window of the ring: only slots spawned within the longest life still running
        // are drawn and splatted, so the cost follows how much smoke there is, not the capacity.
        this.window = new THREE.Vector2(0, this.count);
        this.spawnLog = [];       // per frame: { t (sim time), n spawned, life (longest) }
        this.live = 0;
        this.pending = 0;
        this.drawn = 0;
        this.frameLife = 0;

        this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const cars = [], carVel = [];
        for (let i = 0; i < MAX_CARS; i++) { cars.push(new THREE.Vector4()); carVel.push(new THREE.Vector4()); }

        // ── Sim pass ──
        this.simMat = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT, fragmentShader: SIM_FRAG,
            uniforms: {
                tPos: { value: null }, tVel: { value: null }, tA: { value: this.params.textures[0] }, tB: { value: this.params.textures[1] },
                uDt: { value: 0 }, uTime: { value: 0 }, uTurb: { value: 1 }, uSwirl: { value: 1 },
                uWind: { value: new THREE.Vector3() },
                uCarPos: { value: cars }, uCarVel: { value: carVel },
            },
            depthTest: false, depthWrite: false, blending: THREE.NoBlending,
        });
        this.simScene = new THREE.Scene();
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMat);
        quad.frustumCulled = false;
        this.simScene.add(quad);
        this.quadGeom = quad.geometry;

        // ── Spawn pass: this frame's emissions, one point per particle, into its slot ──
        const M = this.maxSpawn;
        this.sPos = new Float32Array(M * 3);
        this.sSlot = new Float32Array(M);
        this.sVel = new Float32Array(M * 4);
        this.sA = new Float32Array(M * 4);
        this.sB = new Float32Array(M * 4);
        this.spawnN = 0;
        const sg = new THREE.BufferGeometry();
        const dyn = (arr, size) => new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
        sg.setAttribute('position', dyn(this.sPos, 3));
        sg.setAttribute('aSlot', dyn(this.sSlot, 1));
        sg.setAttribute('aVel', dyn(this.sVel, 4));
        sg.setAttribute('aA', dyn(this.sA, 4));
        sg.setAttribute('aB', dyn(this.sB, 4));
        sg.setDrawRange(0, 0);
        this.spawnGeom = sg;
        const spawnMat = frag => new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3, vertexShader: SPAWN_VERT, fragmentShader: frag,
            uniforms: { uTex: { value: tex } }, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
        });
        this.spawnStateMat = spawnMat(SPAWN_STATE_FRAG);
        this.spawnParamMat = spawnMat(SPAWN_PARAM_FRAG);
        this.spawnPoints = new THREE.Points(sg, this.spawnStateMat);
        this.spawnPoints.frustumCulled = false;
        this.spawnScene = new THREE.Scene();
        this.spawnScene.add(this.spawnPoints);

        // ── Sun density pass ──
        const slots = new Float32Array(this.count * 3);
        const slot1 = new Float32Array(this.count);
        for (let i = 0; i < this.count; i++) { slots[i * 3] = i; slot1[i] = i; }
        const shg = new THREE.BufferGeometry();
        shg.setAttribute('position', new THREE.BufferAttribute(slots, 3));
        this.shadowGeom = shg;
        this.shadowMat = new THREE.ShaderMaterial({
            vertexShader: SHADOW_VERT, fragmentShader: SHADOW_FRAG,
            uniforms: {
                tPos: { value: null }, tA: { value: this.params.textures[0] }, tB: { value: this.params.textures[1] },
                uTex: { value: tex }, uWindow: { value: this.window }, uPxPerUnit: { value: cfg.shadow / (SHADOW_EXTENT * 2) },
            },
            depthTest: false, depthWrite: false, transparent: true, ...additive,
        });
        const shPoints = new THREE.Points(shg, this.shadowMat);
        shPoints.frustumCulled = false;
        this.shadowScene = new THREE.Scene();
        this.shadowScene.add(shPoints);
        this.sunCam = new THREE.OrthographicCamera(-SHADOW_EXTENT, SHADOW_EXTENT, SHADOW_EXTENT, -SHADOW_EXTENT, SHADOW_NEAR, SHADOW_FAR);
        this.shadowMatrix = new THREE.Matrix4();

        // ── Render ──
        const plane = new THREE.PlaneGeometry(1, 1);
        const g = new THREE.InstancedBufferGeometry();
        g.index = plane.index;
        g.setAttribute('position', plane.attributes.position);
        g.setAttribute('aSlot', new THREE.InstancedBufferAttribute(slot1, 1));
        g.instanceCount = this.count;
        this.plane = plane;
        this.geom = g;
        this.material = new THREE.ShaderMaterial({
            vertexShader: RENDER_VERT, fragmentShader: RENDER_FRAG,
            uniforms: {
                tPos: { value: null }, tVel: { value: null }, tA: { value: this.params.textures[0] }, tB: { value: this.params.textures[1] },
                tShadow: { value: this.shadow.texture }, tNoise: { value: this.noise },
                uTex: { value: tex }, uWindow: { value: this.window },
                uShadowMat: { value: this.shadowMatrix },
                uShadow: { value: new THREE.Vector3(1, 0.5, 2 / (SHADOW_FAR - SHADOW_NEAR)) },
                uScale: { value: 400 }, uMaxPx: { value: 300 }, uFar: { value: FADE_FAR },
                uTime: { value: 0 }, uMotion: { value: 1 },
                uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
                uSunCol: { value: new THREE.Color(1, 1, 1) },
                uSky: { value: new THREE.Color(0.3, 0.35, 0.4) },
                uGround: { value: new THREE.Color(0.15, 0.15, 0.12) },
                uFogColor: { value: new THREE.Color() },
                uFog: { value: new THREE.Vector2(220, 900) },
            },
            transparent: true, depthWrite: false, depthTest: true,
            blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        });
        this.mesh = new THREE.Mesh(g, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 4;
        this.mesh.name = 'pocabinet-gpu-smoke';

        this._cc = new THREE.Color();
        this._size = new THREE.Vector2();
        this._v = new THREE.Vector3();
        this._near = [];
        this.disposed = false;
    }

    /**
     * One request from fx.js, in the CPU pool's terms (world units; `floor` = the ground it was
     * thrown from); expanded here into several smaller, longer-lived particles.
     */
    emit(kind, x, y, z, vx, vy, vz, life, s0, s1, a0, r, g, b, drag, grav, floor) {
        if (this.disposed) return;
        const dx = x - this.camX, dz = z - this.camZ;
        if (dx * dx + dz * dz > RANGE * RANGE) return;
        const k = KIND[kind] || KIND[0];
        const rnd = Math.random;
        const want = k.n * this.mult * this.budget;
        const n = Math.floor(want) + (rnd() < want % 1 ? 1 : 0);
        if (n < 1) return;
        // Fewer particles on medium: each carries more of the opacity.
        const alpha = a0 * k.alpha * Math.min(1.6, Math.sqrt(k.n / Math.max(1, want)));
        const rgb = Math.round(Math.min(1, r) * 255) + Math.round(Math.min(1, g) * 255) * 256 + Math.round(Math.min(1, b) * 255) * 65536;
        const spread = k.spread + s0 * 0.35;
        for (let i = 0; i < n; i++) {
            if (this.spawnN >= this.maxSpawn) return;
            const j = this.spawnN++;
            this.sSlot[j] = this.next;
            this.next = (this.next + 1) % this.count;
            const ox = (rnd() - 0.5) * 2 * spread, oy = (rnd() - 0.5) * spread, oz = (rnd() - 0.5) * 2 * spread;
            this.sPos[j * 3] = x + ox; this.sPos[j * 3 + 1] = y + oy; this.sPos[j * 3 + 2] = z + oz;
            const j4 = j * 4;
            this.sVel[j4] = vx + (rnd() - 0.5) * 1.0 + ox * 0.6;
            this.sVel[j4 + 1] = vy * (0.7 + rnd() * 0.6);
            this.sVel[j4 + 2] = vz + (rnd() - 0.5) * 1.0 + oz * 0.6;
            this.sVel[j4 + 3] = floor;
            this.sA[j4] = life * k.life * (0.75 + rnd() * 0.5);
            if (this.sA[j4] > this.frameLife) this.frameLife = this.sA[j4];
            this.sA[j4 + 1] = s0 * (0.7 + rnd() * 0.5);
            this.sA[j4 + 2] = s1 * k.size * (0.65 + rnd() * 0.6);
            this.sA[j4 + 3] = alpha * (0.7 + rnd() * 0.6);
            this.sB[j4] = rgb;
            this.sB[j4 + 1] = k.heat;
            this.sB[j4 + 2] = drag;
            this.sB[j4 + 3] = grav;
        }
    }

    /**
     * Advance and prepare for this frame's draw.
     * @param dt   seconds (slow motion already applied; 0 = paused: frozen, still drawn)
     * @param cars [{ x, y, h, heading, speed }] sim units (fx.js's poses)
     */
    step(dt, cars) {
        if (this.disposed) return;
        const r = this.renderer, sh = this.sh, cam = sh.camera;
        this.camX = cam.position.x; this.camZ = cam.position.z;
        const reduced = !!sh.fx?.reduced;
        this.time += dt;
        this.govern();
        const prevTarget = r.getRenderTarget();
        const prevAuto = r.autoClear;
        r.getClearColor(this._cc);
        const prevAlpha = r.getClearAlpha();
        try {
            if (dt > 0) {
                const u = this.simMat.uniforms;
                u.tPos.value = this.state[this.cur].textures[0];
                u.tVel.value = this.state[this.cur].textures[1];
                u.uDt.value = dt;
                u.uTime.value = this.time;
                u.uTurb.value = reduced ? 0.6 : 2.6;
                u.uSwirl.value = reduced ? 0 : 1;
                const gust = 1 + 0.35 * Math.sin(this.time * 0.37) + 0.15 * Math.sin(this.time * 1.13);
                u.uWind.value.set(this.windDir.x * this.windSpeed * gust, 0, this.windDir.y * this.windSpeed * gust);
                this.nearestCars(cars, u.uCarPos.value, u.uCarVel.value);
                this.cur ^= 1;
                r.setRenderTarget(this.state[this.cur]);
                r.render(this.simScene, this.ortho);
            }
            r.autoClear = false;
            this.pending = this.spawnN;
            if (this.spawnN > 0) {
                const a = this.spawnGeom.attributes;
                const n = this.spawnN;
                for (const [name, size] of [['position', 3], ['aSlot', 1], ['aVel', 4], ['aA', 4], ['aB', 4]]) {
                    const at = a[name];
                    at.clearUpdateRanges?.();
                    at.addUpdateRange?.(0, n * size);
                    at.needsUpdate = true;
                }
                this.spawnGeom.setDrawRange(0, n);
                this.spawnPoints.material = this.spawnStateMat;
                r.setRenderTarget(this.state[this.cur]);
                r.render(this.spawnScene, this.ortho);
                this.spawnPoints.material = this.spawnParamMat;
                r.setRenderTarget(this.params);
                r.render(this.spawnScene, this.ortho);
                this.spawnN = 0;
            }
            this.trackWindow();
            this.sunPass();
        } finally {
            r.setRenderTarget(prevTarget);
            r.autoClear = prevAuto;
            r.setClearColor(this._cc, prevAlpha);
        }
        this.updateRender(reduced);
        this.frames++;
        if (this.frames === 4 || this.frames === 60 || this.frames === 600) this.checkPrograms();
    }

    /** Thin the emission while the frame rate sags, restore it when there is headroom. */
    govern() {
        const now = performance.now();
        const ms = now - this.lastNow;
        this.lastNow = now;
        if (!(ms > 0 && ms < 250)) return;   // first frame, or a stall / hidden tab
        this.frameMs += (ms - this.frameMs) * 0.05;
        const fps = 1000 / this.frameMs, s = ms / 1000;
        if (fps < GOV_LOW) this.budget = Math.max(GOV_MIN, this.budget - s * 0.6);
        else if (fps > GOV_HIGH) this.budget = Math.min(1, this.budget + s * 0.2);
    }

    /** The 16 cars nearest the camera into the sim's uniform arrays (world units). */
    nearestCars(cars, pos, vel) {
        const cx = this.camX, cz = this.camZ;
        const near = this._near;
        near.length = 0;
        for (const c of cars || []) {
            const x = c.x / 10, z = c.y / 10;
            const d = (x - cx) ** 2 + (z - cz) ** 2;
            if (d > 200 * 200) continue;
            if (near.length < MAX_CARS) { near.push({ c, d }); continue; }
            let worst = 0;
            for (let i = 1; i < near.length; i++) if (near[i].d > near[worst].d) worst = i;
            if (d < near[worst].d) near[worst] = { c, d };
        }
        for (let i = 0; i < MAX_CARS; i++) {
            const e = near[i];
            if (!e) { vel[i].w = 0; continue; }
            const c = e.c, s = (Number(c.speed) || 0) / 10, h = Number(c.heading) || 0;
            pos[i].set(c.x / 10, Number(c.h) || 0, c.y / 10, h);
            vel[i].set(Math.cos(h) * s, 0, Math.sin(h) * s, 1);
        }
    }

    /** Log this frame's spawns, expire frames whose longest life has run out: the live window. */
    trackWindow() {
        const log = this.spawnLog;
        log.push({ t: this.time, n: this.pending, life: this.frameLife });
        this.live += this.pending;
        this.pending = 0;
        this.frameLife = 0;
        while (log.length && (this.time - log[0].t > log[0].life || log[0].n === 0)) this.live -= log.shift().n;
        const n = Math.min(this.count, this.live);
        this.window.set((this.next - n + this.count) % this.count, this.count);
        this.drawn = n;
        this.geom.instanceCount = n;
        this.shadowGeom.setDrawRange(0, n);
        this.mesh.visible = n > 0;
    }

    /** Splat every live particle into the sun-view density map around the action. */
    sunPass() {
        const r = this.renderer, sh = this.sh;
        const sun = sh.sunDir || this._v.set(0.5, 0.8, 0.3).normalize();
        const f = sh.fx?.focus;
        const cam = sh.camera;
        let cx, cy, cz;
        if (f) { cx = f.x; cy = f.y || 0; cz = f.z; }
        else {
            cam.getWorldDirection(this._v);
            cx = cam.position.x + this._v.x * 25; cy = cam.position.y - 3; cz = cam.position.z + this._v.z * 25;
        }
        const sc = this.sunCam;
        sc.up.set(0, Math.abs(sun.y) > 0.98 ? 0 : 1, Math.abs(sun.y) > 0.98 ? 1 : 0);
        sc.position.set(cx + sun.x * SHADOW_BACK, cy + sun.y * SHADOW_BACK, cz + sun.z * SHADOW_BACK);
        sc.lookAt(cx, cy, cz);
        sc.updateMatrixWorld();
        this.shadowMatrix.multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse);
        this.shadowMat.uniforms.tPos.value = this.state[this.cur].textures[0];
        r.setRenderTarget(this.shadow);
        r.setClearColor(0x000000, 0);
        r.clear(true, false, false);
        r.render(this.shadowScene, sc);
    }

    updateRender(reduced) {
        const sh = this.sh, r = this.renderer, cam = sh.camera;
        const u = this.material.uniforms;
        const st = this.state[this.cur];
        u.tPos.value = st.textures[0];
        u.tVel.value = st.textures[1];
        r.getDrawingBufferSize(this._size);
        u.uScale.value = this._size.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
        u.uMaxPx.value = this._size.y * 0.2;
        u.uTime.value = this.time;
        u.uMotion.value = reduced ? 0 : 1;
        if (sh.sunDir) u.uSunDir.value.copy(sh.sunDir).normalize();
        const PI = Math.PI;
        if (sh.sun) u.uSunCol.value.copy(sh.sun.color).multiplyScalar(sh.sun.intensity / PI * 1.15);
        const hemi = sh.hemi;
        if (hemi) {
            const env = (sh.scene.environmentIntensity ?? 0.85) * 0.22;
            u.uSky.value.copy(hemi.color).multiplyScalar(hemi.intensity / PI * 1.4 + env);
            u.uGround.value.copy(hemi.groundColor).multiplyScalar(hemi.intensity / PI * 1.4).addScalar(env * 0.35);
        }
        const fog = sh.scene.fog;
        if (fog && fog.isFog) {
            u.uFogColor.value.copy(fog.color);
            u.uFog.value.set(fog.near, fog.far);
        } else {
            u.uFog.value.set(1e6, 1e6 + 1);
        }
    }

    /** A shader that failed to build: flag it so fx.js falls back to the CPU pools. */
    checkPrograms() {
        try {
            const props = this.renderer.properties;
            for (const m of [this.simMat, this.spawnStateMat, this.spawnParamMat, this.shadowMat, this.material]) {
                const d = props.get(m)?.currentProgram?.diagnostics;
                if (d && d.runnable === false) { this.failed = true; return; }
            }
        } catch { /* diagnostics are best-effort */ }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.mesh.parent?.remove(this.mesh);
        for (const t of [...this.state, this.params, this.shadow]) t.dispose();
        for (const m of [this.simMat, this.spawnStateMat, this.spawnParamMat, this.shadowMat, this.material]) m.dispose();
        for (const g of [this.quadGeom, this.spawnGeom, this.shadowGeom, this.geom, this.plane]) g.dispose();
        this.noise.dispose();
    }
}
