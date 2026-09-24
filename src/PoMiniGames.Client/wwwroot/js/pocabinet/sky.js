// pocabinet/sky.js
//
// Sky dome for PoCabinet: a camera-following inverted sphere with a gradient,
// sun, drifting fbm clouds, stars at night, a city glow on the horizon and — on
// the Press Briefing track — sweeping searchlights. Replaces the flat
// scene.background colour.
//
// The horizon colour is read from scene.fog every frame, so whatever the fog
// becomes (environment.js darkens it at night) the ground fades into the sky
// with no seam. Written at the far plane (z = w) and drawn first.

import * as THREE from 'three';

// Per-track look. Directions are world space (y up). The DirectionalLight in
// scene.js follows `sun`, clamped high enough to keep the road lit.
const PRESETS = {
    capitol: {
        zenith: '#060d20', sun: [-0.62, 0.07, -0.78], sunColor: '#ff8a3d', sunSize: 1,
        clouds: 0.38, cloudColor: '#c98a7a', glow: '#ffb070', stars: 0.35, beams: 0,
    },
    maralago: {
        zenith: '#2f6fbf', sun: [0.35, 0.72, 0.45], sunColor: '#fff2d0', sunSize: 1.4,
        clouds: 0.26, cloudColor: '#ffffff', glow: '#ffe2b0', stars: 0, beams: 0,
    },
    pressbriefing: {
        zenith: '#040108', sun: [0.2, 0.3, 0.9], sunColor: '#000000', sunSize: 0,
        clouds: 0.3, cloudColor: '#4a2346', glow: '#ff3a6a', stars: 0.6, beams: 1,
    },
};

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
}`;

const FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunSize;
uniform float uCloud;
uniform vec3 uCloudColor;
uniform vec3 uGlow;
uniform float uStars;
uniform float uBeams;
uniform float uTime;
uniform float uNight;
uniform float uRain;
varying vec3 vDir;

#define PI 3.14159265

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
               mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
}

void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float up = pow(smoothstep(-0.02, 0.65, h), 0.65);
    vec3 zen = mix(uZenith, uZenith * 0.12, uNight);
    zen = mix(zen, vec3(dot(zen, vec3(0.33))) * 1.4, uRain * 0.6);
    vec3 col = mix(uHorizon, zen, up);

    // Sun: disc + halo + a warm band along the horizon under it.
    float day = (1.0 - uNight * 0.92) * (1.0 - uRain * 0.85);
    float s = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSunColor * (pow(s, 1400.0 / max(uSunSize, 0.01)) * 5.0 + pow(s, 14.0) * 0.3) * day * step(0.01, uSunSize);
    col += uSunColor * pow(s, 3.0) * 0.18 * (1.0 - up) * day;

    // Stars.
    if (h > 0.0) {
        vec2 sp = vec2(atan(d.x, d.z) * 180.0 / PI, h * 180.0);
        vec2 cell = floor(sp * 1.3);
        float r = hash12(cell);
        float tw = 0.6 + 0.4 * sin(uTime * (1.5 + r * 4.0) + r * 40.0);
        float star = step(0.9965, r) * smoothstep(0.5, 0.1, length(fract(sp * 1.3) - 0.5)) * tw;
        col += vec3(star) * max(uStars, uNight) * (1.0 - uRain) * smoothstep(0.02, 0.2, h) * 1.2;
    }

    // Clouds: fbm on a plane overhead.
    if (h > 0.0) {
        vec2 cp = d.xz / (h + 0.12) * 0.9 + uTime * vec2(0.011, 0.004);
        float n = fbm(cp * 1.6);
        float cover = clamp(uCloud + uRain * 0.55, 0.0, 0.95);
        float c = smoothstep(1.0 - cover, 1.0 - cover + 0.32, n) * smoothstep(0.0, 0.22, h);
        vec3 lit = mix(uCloudColor * 0.55, uCloudColor * 1.1, smoothstep(0.3, 1.0, n));
        lit += uSunColor * pow(s, 6.0) * 0.4 * day;
        lit = mix(lit, vec3(0.28, 0.3, 0.33), uRain * 0.7);
        lit *= mix(1.0, 0.18, uNight);
        col = mix(col, lit, c * 0.88);
    }

    // City glow on the horizon: brightest at night.
    col += uGlow * exp(-max(h, 0.0) * 16.0) * (0.06 + uNight * 0.3);

    // Searchlights (Press Briefing).
    if (uBeams > 0.5) {
        float az = atan(d.x, d.z);
        for (int i = 0; i < 4; i++) {
            float fi = float(i);
            float beamAz = fi * 1.57 + 0.6 + sin(uTime * (0.21 + fi * 0.05) + fi * 1.7) * 0.7;
            float da = abs(mod(az - beamAz + PI, 2.0 * PI) - PI);
            float w = 0.012 + max(h, 0.0) * 0.08;
            float beam = exp(-da * da / (w * w)) * smoothstep(0.9, 0.0, h) * smoothstep(-0.01, 0.04, h);
            col += mix(vec3(1.0, 0.85, 0.95), uGlow, 0.35) * beam * 0.22;
        }
    }

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
}`;

export class Sky {
    constructor(trackId) {
        const p = PRESETS[trackId] || PRESETS.capitol;
        this.preset = p;
        this.baseZenith = new THREE.Color(p.zenith);
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            side: THREE.BackSide,
            depthWrite: false,
            fog: false,
            uniforms: {
                uZenith: { value: this.baseZenith.clone() },
                uHorizon: { value: new THREE.Color('#14233f') },
                uSunDir: { value: new THREE.Vector3(...p.sun).normalize() },
                uSunColor: { value: new THREE.Color(p.sunColor) },
                uSunSize: { value: p.sunSize },
                uCloud: { value: p.clouds },
                uCloudColor: { value: new THREE.Color(p.cloudColor) },
                uGlow: { value: new THREE.Color(p.glow) },
                uStars: { value: p.stars },
                uBeams: { value: p.beams },
                uTime: { value: 0 },
                uNight: { value: 0 },
                uRain: { value: 0 },
            },
        });
        this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), this.material);
        this.mesh.name = 'pocabinet-sky';
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = -1000;
    }

    /** World-space direction the DirectionalLight should shine from. */
    lightDirection() {
        const d = new THREE.Vector3(...this.preset.sun).normalize();
        d.y = Math.max(d.y, 0.6);
        return d.normalize();
    }

    setEnvironment(night, rain) {
        this.material.uniforms.uNight.value = Math.min(1, Math.max(0, Number(night) || 0));
        this.material.uniforms.uRain.value = rain ? 1 : 0;
    }

    update(camera, fog, timeSeconds) {
        this.mesh.position.copy(camera.position);
        if (camera.parent && camera.parent.isObject3D && camera.parent.type !== 'Scene') {
            camera.getWorldPosition(this.mesh.position);
        }
        if (fog) this.material.uniforms.uHorizon.value.copy(fog.color);
        this.material.uniforms.uTime.value = timeSeconds % 10000;
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
