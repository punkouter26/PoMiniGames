// pocabinet/postfx.js
//
// One full-screen pass over the rendered scene (WebGL2; three ≥ r163 has no
// WebGL1 path, so multisampled render targets are always available):
//
//   • speed — radial blur toward the vanishing point + chromatic fringing at
//     the edges + streaking speed lines, all scaled by speed and masked away
//     from the centre (and from the dash in cockpit view, which rides the camera)
//   • windscreen rain — two layers of refracting drops on the glass. In cockpit
//     view a screen-space wiper sweeps them away; a cleared cell refills after a
//     per-drop delay, so the glass visibly re-wets between passes. Chase and TV
//     cameras get a lighter lens-drop layer instead.
//   • moments — a white flash (camera flashbulbs, photo finish) and a slow-motion
//     grade (desaturated, cooler, heavier vignette)
//   • vignette + a touch of grain
//
// The scene renders into a half-float target in linear space; the colour-space
// conversion happens once, here, via three's <colorspace_fragment>.
//
// `fx` is SceneHandle.fx — the one bag of per-frame values race.js and
// environment.js write. Reduced motion zeroes blur, fringing and speed lines.

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uRes;
uniform float uTime;
uniform float uSpeed;
uniform float uMotion;
uniform float uRain;
uniform float uCockpit;
uniform float uWipeT;
uniform float uWipeP;
uniform float uFlash;
uniform float uSlow;
varying vec2 vUv;

#define PI 3.14159265

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

// Wiper geometry, aspect space (x centred, y = 0 at the bottom edge).
const vec2 PIVOT = vec2(0.0, -0.12);
const float A0 = 0.25;
const float A1 = PI - 0.25;
const float REACH = 1.25;

// Seconds since the blade last crossed point q (1e3 = never: outside the sweep).
float wipeSince(vec2 q) {
    vec2 d = q - PIVOT;
    float a = (atan(d.y, d.x) - A0) / (A1 - A0);
    if (a < 0.0 || a > 1.0 || length(d) > REACH) return 1e3;
    float P = uWipeP;
    float tm = mod(uWipeT, P);
    float t1 = a * P * 0.5;
    float t2 = P - a * P * 0.5;
    return tm >= t2 ? tm - t2 : (tm >= t1 ? tm - t1 : tm + P - t2);
}

// One drop layer: xy = refraction direction, z = coverage.
vec3 drops(vec2 q, float scale, float density, float wiped) {
    vec2 g = q * scale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 r = hash22(id);
    if (hash12(id + 17.31) > density) return vec3(0.0);
    float since = wiped > 0.5 ? wipeSince((id + 0.5) / scale) : 1e3;
    float age = since - r.x * uWipeP * 1.4;
    if (age < 0.0) return vec3(0.0);
    float grow = smoothstep(0.0, 0.3, age);
    vec2 c = (r - 0.5) * 0.45;
    // Airflow pushes drops up the glass at speed; they fade before leaving the cell.
    float creep = min(age * uSpeed * 0.3, 0.35);
    c.y += creep;
    float rad = (0.1 + r.y * 0.14) * grow * (1.0 - creep * 1.6);
    vec2 dv = f - c;
    dv.y *= 1.0 + uSpeed * 0.9;
    float dist = length(dv);
    float m = smoothstep(rad, rad * 0.55, dist);
    return vec3(dv / max(rad, 1e-3) * m, m);
}

void main() {
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    vec2 uv = vUv;
    vec2 center = vec2(0.5, 0.55);
    vec2 toC = uv - center;
    float dashMask = 1.0 - uCockpit * smoothstep(0.34, 0.14, uv.y);

    // ── Speed: radial blur + fringing ──
    float bmask = smoothstep(0.16, 0.62, length(toC * asp)) * dashMask;
    float amt = uSpeed * uSpeed * 0.036 * uMotion * bmask;
    vec3 col = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        float t = float(i) / 7.0;
        col += texture2D(tScene, uv - toC * amt * t).rgb;
    }
    col /= 8.0;
    float ca = (0.0005 + uSpeed * 0.0022) * uMotion * bmask;
    col.r = mix(col.r, texture2D(tScene, uv + toC * ca).r, 0.7);
    col.b = mix(col.b, texture2D(tScene, uv - toC * ca).b, 0.7);

    // ── Speed lines ──
    vec2 dir = toC * asp;
    float len = length(dir);
    float ang = atan(dir.y, dir.x);
    float laneF = ang * 180.0 / PI;
    float lane = floor(laneF);
    float lr = hash12(vec2(lane, 3.1));
    float streak = step(0.94, lr) * smoothstep(0.42, 0.9, len);
    float travel = fract(len * 1.1 - uTime * (1.6 + lr * 2.0) + lr * 7.0);
    streak *= smoothstep(0.0, 0.05, travel) * smoothstep(0.32, 0.08, travel);
    streak *= smoothstep(0.22, 0.05, abs(fract(laneF) - 0.5));
    col += vec3(0.9, 0.95, 1.0) * streak * pow(uSpeed, 3.0) * 0.12 * uMotion * dashMask;

    // ── Windscreen rain ──
    if (uRain > 0.001) {
        vec2 q = (uv - vec2(0.5, 0.0)) * asp;
        float wiped = uCockpit;
        float dens = mix(0.22, 0.6, uCockpit) * uRain;
        vec3 d1 = drops(q, 9.0, dens, wiped);
        vec3 d2 = drops(q + vec2(0.371, 0.113), 21.0, dens * 0.85, wiped);
        float m = max(d1.z, d2.z);
        vec2 n = d1.xy * 0.035 + d2.xy * 0.018;
        vec3 dropCol = texture2D(tScene, uv - n * 1.6).rgb * 1.08 + 0.025;
        float rim = m * (1.0 - m) * 3.5;
        col = mix(col, dropCol, m) * (1.0 - rim * 0.3);
        // Highlight on the upper-left of each drop.
        col += vec3(0.6) * pow(max(0.0, dot(normalize(d1.xy + d2.xy + 1e-4), vec2(-0.6, 0.8))), 12.0) * m * 0.12;

        if (uCockpit > 0.5) {
            float P = uWipeP;
            float tm = mod(uWipeT, P);
            float b = tm < P * 0.5 ? tm / (P * 0.5) : 2.0 - tm / (P * 0.5);
            float angB = A0 + b * (A1 - A0);
            vec2 bd = vec2(cos(angB), sin(angB));
            vec2 d = q - PIVOT;
            float along = dot(d, bd);
            float perp = abs(bd.x * d.y - bd.y * d.x);
            float blade = smoothstep(0.011, 0.005, perp) * step(0.2, along) * step(along, REACH);
            float arm = smoothstep(0.006, 0.002, perp) * step(0.0, along) * step(along, 0.2);
            col = mix(col, vec3(0.018), max(blade, arm) * 0.95);
        }
    }

    // ── Grade: slow motion, vignette, flash, grain ──
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(luma) * vec3(0.9, 0.97, 1.08), uSlow * 0.55);
    float vig = smoothstep(0.45, 1.15, length(toC * asp * vec2(0.9, 1.0)));
    col *= 1.0 - vig * (0.32 + uSpeed * 0.2 * uMotion + uSlow * 0.35);
    col = mix(col, vec3(1.0, 0.98, 0.95), clamp(uFlash, 0.0, 1.0));
    col += (hash12(uv * uRes + fract(uTime * 7.3) * 91.0) - 0.5) * 0.005;

    gl_FragColor = vec4(max(col, 0.0), 1.0);
    #include <colorspace_fragment>
}`;

export class PostFx {
    constructor(renderer) {
        this.renderer = renderer;
        this.size = new THREE.Vector2();
        renderer.getDrawingBufferSize(this.size);
        this.target = new THREE.WebGLRenderTarget(Math.max(1, this.size.x), Math.max(1, this.size.y), {
            type: THREE.HalfFloatType,
            samples: 4,
        });
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            depthTest: false,
            depthWrite: false,
            uniforms: {
                tScene: { value: this.target.texture },
                uRes: { value: new THREE.Vector2(this.size.x, this.size.y) },
                uTime: { value: 0 },
                uSpeed: { value: 0 },
                uMotion: { value: 1 },
                uRain: { value: 0 },
                uCockpit: { value: 1 },
                uWipeT: { value: 0 },
                uWipeP: { value: 1.8 },
                uFlash: { value: 0 },
                uSlow: { value: 0 },
            },
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quad.frustumCulled = false;
        this.quadScene = new THREE.Scene();
        this.quadScene.add(this.quad);
        this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }

    setSize() {
        this.renderer.getDrawingBufferSize(this.size);
        const w = Math.max(1, this.size.x), h = Math.max(1, this.size.y);
        if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
        this.material.uniforms.uRes.value.set(w, h);
    }

    render(scene, camera, fx, timeSeconds) {
        const r = this.renderer;
        r.setRenderTarget(this.target);
        r.render(scene, camera);
        r.setRenderTarget(null);
        const u = this.material.uniforms;
        u.uTime.value = timeSeconds % 1000;
        u.uSpeed.value = Math.min(1, Math.max(0, fx.speed || 0));
        u.uMotion.value = fx.reduced ? 0 : 1;
        u.uRain.value = fx.rain || 0;
        u.uCockpit.value = fx.cockpit ? 1 : 0;
        u.uWipeT.value = fx.wipeT || 0;
        u.uWipeP.value = fx.wipeP || 1.8;
        u.uFlash.value = fx.flash || 0;
        u.uSlow.value = fx.slow || 0;
        r.render(this.quadScene, this.quadCamera);
    }

    dispose() {
        this.target.dispose();
        this.material.dispose();
        this.quad.geometry.dispose();
    }
}
