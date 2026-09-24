// pocabinet/postfx.js
//
// HDR post-processing for PoCabinet (WebGL2: three ≥ r163 has no WebGL1 path, so
// multisampled half-float targets are always available).
//
//   scene ─► MSAA half-float target (linear HDR)
//        ─► bright pass (soft knee) at half res
//        ─► dual-filter bloom: N downsamples, N upsamples added back up the chain
//        ─► composite:
//             • speed — radial blur toward the vanishing point, chromatic fringing
//               at the edges, streaking speed lines (all masked off the centre)
//             • lens rain — refracting drops on the camera glass
//             • bloom + light shafts: the bloom texture blurred radially toward the
//               sun's screen position, plus a small glare/ghost when the sun is in view
//             • ACES filmic tone mapping with exposure, a light grade, vignette,
//               flash (flashbulbs, photo finish), slow-motion grade, grain
//             • linear → sRGB via three's <colorspace_fragment>
//
// `fx` is SceneHandle.fx — the per-frame bag race.js / environment.js write and
// scene.js fills (sun position, exposure). Reduced motion zeroes the speed effects.
// Quality 'low' | 'medium' | 'high' sets the bloom depth.

import * as THREE from 'three';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main() {
    // 4-tap box on the way down (the target is half size).
    vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;
    c *= 0.25;
    // One bad pixel (NaN/Inf from a degenerate triangle) would otherwise bloom into a blob.
    if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
    c = min(c, vec3(60.0));
    float br = max(c.r, max(c.g, c.b));
    float knee = uThreshold * 0.5;
    float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    float w = max(soft, br - uThreshold) / max(br, 1e-4);
    gl_FragColor = vec4(c * w, 1.0);
}`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
    vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    gl_FragColor = vec4(s / 8.0, 1.0);
}`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;     // the smaller, already-accumulated level
uniform sampler2D tBase;    // this level's downsample
uniform vec2 uTexel;        // texel of tSrc
varying vec2 vUv;
void main() {
    vec3 s = texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    gl_FragColor = vec4(texture2D(tBase, vUv).rgb + s / 12.0, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform float uTime;
uniform float uSpeed;
uniform float uMotion;
uniform float uRain;
uniform float uFlash;
uniform float uSlow;
uniform float uBloom;
uniform float uExposure;
uniform vec3 uSun;          // xy = screen uv, z = visibility
uniform vec3 uSunColor;
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

// One layer of drops on the lens: xy = refraction direction, z = coverage.
vec3 drops(vec2 q, float scale, float density) {
    vec2 g = q * scale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 r = hash22(id);
    if (hash12(id + 17.31) > density) return vec3(0.0);
    // Each drop lives a few seconds, then a new one forms elsewhere in the cell.
    float life = fract(uTime * (0.08 + r.y * 0.1) + r.x);
    vec2 c = (hash22(id + floor(uTime * (0.08 + r.y * 0.1) + r.x)) - 0.5) * 0.45;
    c.y -= life * 0.25 * (0.3 + uSpeed);
    float rad = (0.1 + r.y * 0.13) * smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.8, 1.0, life));
    vec2 dv = f - c;
    dv.x *= 1.0 + uSpeed * 0.6;
    float dist = length(dv);
    float m = smoothstep(rad, rad * 0.55, dist);
    return vec3(dv / max(rad, 1e-3) * m, m);
}

vec3 RRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
}
vec3 acesFilmic(vec3 c) {
    const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
    const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
    return clamp(outM * RRTAndODTFit(inM * c), 0.0, 1.0);
}

void main() {
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    vec2 uv = vUv;
    vec2 center = vec2(0.5, 0.5);
    vec2 toC = uv - center;

    // ── Speed: radial blur + fringing ──
    float bmask = smoothstep(0.18, 0.66, length(toC * asp));
    float amt = uSpeed * uSpeed * 0.032 * uMotion * bmask;
    vec3 col = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        float t = float(i) / 7.0;
        col += texture2D(tScene, uv - toC * amt * t).rgb;
    }
    col /= 8.0;
    if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
    float ca = (0.0004 + uSpeed * 0.0018) * uMotion * bmask;
    col.r = mix(col.r, texture2D(tScene, uv + toC * ca).r, 0.7);
    col.b = mix(col.b, texture2D(tScene, uv - toC * ca).b, 0.7);

    // ── Lens rain ──
    if (uRain > 0.001) {
        vec2 q = (uv - vec2(0.5, 0.0)) * asp;
        vec3 d1 = drops(q, 7.0, 0.3 * uRain);
        vec3 d2 = drops(q + vec2(0.371, 0.113), 16.0, 0.25 * uRain);
        float m = max(d1.z, d2.z);
        vec2 n = d1.xy * 0.035 + d2.xy * 0.018;
        vec3 dropCol = texture2D(tScene, uv - n * 1.6).rgb * 1.05;
        col = mix(col, dropCol, m) * (1.0 - m * (1.0 - m) * 1.0);
    }

    // ── Bloom + light shafts toward the sun ──
    vec3 bloom = texture2D(tBloom, uv).rgb;
    col += bloom * uBloom;
    if (uSun.z > 0.001) {
        vec2 sp = uSun.xy;
        vec2 dlt = (sp - uv) / 28.0;
        vec2 p = uv;
        vec3 shafts = vec3(0.0);
        float decay = 1.0;
        for (int i = 0; i < 28; i++) {
            p += dlt;
            vec3 b = texture2D(tBloom, p).rgb;
            shafts += b * decay;
            decay *= 0.95;
        }
        col += shafts / 28.0 * uSunColor * uSun.z * 0.9;
        vec2 ds = (uv - sp) * asp;
        float glare = exp(-length(ds) * 7.0) * 0.35 + exp(-abs(ds.y) * 90.0) * exp(-abs(ds.x) * 3.0) * 0.12;
        // A few ghosts along the line through the centre.
        vec2 axis = (center - sp);
        float ghosts = 0.0;
        for (int g = 1; g <= 3; g++) {
            vec2 gp = sp + axis * (0.6 + float(g) * 0.45);
            ghosts += smoothstep(0.05 + float(g) * 0.02, 0.0, length((uv - gp) * asp)) * 0.05;
        }
        col += uSunColor * (glare + ghosts) * uSun.z;
    }

    // ── Speed lines (added after bloom so they stay crisp) ──
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
    col += vec3(0.9, 0.95, 1.0) * streak * pow(uSpeed, 3.0) * 0.12 * uMotion;

    // ── Tone map + grade ──
    col = acesFilmic(col * uExposure / 0.6);
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(luma), col, 1.08);                       // a touch of saturation
    col = mix(col, vec3(luma) * vec3(0.9, 0.97, 1.08), uSlow * 0.55);
    float vig = smoothstep(0.5, 1.2, length(toC * asp * vec2(0.9, 1.0)));
    col *= 1.0 - vig * (0.35 + uSpeed * 0.15 * uMotion + uSlow * 0.35);
    col = mix(col, vec3(1.0, 0.98, 0.95), clamp(uFlash, 0.0, 1.0));
    col += (hash12(uv * uRes + fract(uTime * 7.3) * 91.0) - 0.5) * 0.004;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    #include <colorspace_fragment>
}`;

const LEVELS = { low: 3, medium: 4, high: 5 };

function target(w, h, samples = 0) {
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
        type: THREE.HalfFloatType, samples, depthBuffer: samples > 0,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
}

export class PostFx {
    constructor(renderer) {
        this.renderer = renderer;
        this.size = new THREE.Vector2();
        this.quality = 'high';
        renderer.getDrawingBufferSize(this.size);
        this.sceneTarget = target(this.size.x, this.size.y, 4);
        this.down = [];
        this.up = [];

        const mat = (frag, uniforms) => new THREE.ShaderMaterial({
            vertexShader: QUAD_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
        });
        this.brightMat = mat(BRIGHT_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.0 } });
        this.downMat = mat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
        this.upMat = mat(UP_FRAG, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() } });
        this.material = mat(COMPOSITE_FRAG, {
            tScene: { value: this.sceneTarget.texture },
            tBloom: { value: null },
            uRes: { value: new THREE.Vector2(this.size.x, this.size.y) },
            uTime: { value: 0 },
            uSpeed: { value: 0 },
            uMotion: { value: 1 },
            uRain: { value: 0 },
            uFlash: { value: 0 },
            uSlow: { value: 0 },
            uBloom: { value: 0.7 },
            uExposure: { value: 1 },
            uSun: { value: new THREE.Vector3() },
            uSunColor: { value: new THREE.Color(1, 0.9, 0.75) },
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quad.frustumCulled = false;
        this.quadScene = new THREE.Scene();
        this.quadScene.add(this.quad);
        this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.buildChain();
    }

    setQuality(q) {
        if (!LEVELS[q] || q === this.quality) return;
        this.quality = q;
        this.buildChain();
    }

    buildChain() {
        for (const t of [...this.down, ...this.up]) t.dispose();
        this.down = [];
        this.up = [];
        let w = Math.max(1, this.size.x >> 1), h = Math.max(1, this.size.y >> 1);
        for (let i = 0; i < LEVELS[this.quality]; i++) {
            this.down.push(target(w, h));
            this.up.push(target(w, h));
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
        }
    }

    setSize() {
        this.renderer.getDrawingBufferSize(this.size);
        const w = Math.max(1, this.size.x), h = Math.max(1, this.size.y);
        if (this.sceneTarget.width !== w || this.sceneTarget.height !== h) {
            this.sceneTarget.setSize(w, h);
            this.buildChain();
        }
        this.material.uniforms.uRes.value.set(w, h);
    }

    pass(material, out) {
        this.quad.material = material;
        this.renderer.setRenderTarget(out);
        this.renderer.render(this.quadScene, this.quadCamera);
    }

    render(scene, camera, fx, timeSeconds) {
        const r = this.renderer;
        r.setRenderTarget(this.sceneTarget);
        r.render(scene, camera);

        // Bloom chain.
        const b = this.brightMat.uniforms;
        b.tSrc.value = this.sceneTarget.texture;
        b.uTexel.value.set(1 / this.sceneTarget.width, 1 / this.sceneTarget.height);
        b.uThreshold.value = fx.bloomThreshold || 1.0;
        this.pass(this.brightMat, this.down[0]);
        for (let i = 1; i < this.down.length; i++) {
            const src = this.down[i - 1];
            this.downMat.uniforms.tSrc.value = src.texture;
            this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
            this.pass(this.downMat, this.down[i]);
        }
        const last = this.down.length - 1;
        let acc = this.down[last];
        for (let i = last - 1; i >= 0; i--) {
            this.upMat.uniforms.tSrc.value = acc.texture;
            this.upMat.uniforms.tBase.value = this.down[i].texture;
            this.upMat.uniforms.uTexel.value.set(1 / acc.width, 1 / acc.height);
            this.pass(this.upMat, this.up[i]);
            acc = this.up[i];
        }

        const u = this.material.uniforms;
        u.tBloom.value = acc.texture;
        u.uTime.value = timeSeconds % 1000;
        u.uSpeed.value = Math.min(1, Math.max(0, fx.speed || 0));
        u.uMotion.value = fx.reduced ? 0 : 1;
        u.uRain.value = fx.rain || 0;
        u.uFlash.value = fx.flash || 0;
        u.uSlow.value = fx.slow || 0;
        u.uBloom.value = fx.bloom ?? 0.7;
        u.uExposure.value = fx.exposure || 1;
        if (fx.sun) u.uSun.value.set(fx.sun.x, fx.sun.y, fx.sun.v);
        else u.uSun.value.set(0, 0, 0);
        if (fx.sunColor) u.uSunColor.value.copy(fx.sunColor);
        this.pass(this.material, null);
        this.quad.material = this.material;
    }

    dispose() {
        this.sceneTarget.dispose();
        for (const t of [...this.down, ...this.up]) t.dispose();
        for (const m of [this.brightMat, this.downMat, this.upMat, this.material]) m.dispose();
        this.quad.geometry.dispose();
    }
}
