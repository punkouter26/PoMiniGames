// pocabinet/slipstream.js
//
// The tow, made visible. Render only: the physics has no drafting force (the AI only likes to
// tuck in), so this reads the poses race.js draws and never feeds anything back.
//
//   • draft — how deep the car in focus sits in another's wake, 0..1: the nearest car ahead
//     within WAKE_LEN, near the same line and heading the same way, scaled by speed and eased.
//     Written to fx.draft (audio.js muffles the wind in it) and fx.draftAhead (that car).
//   • streamlines — wind-tunnel ribbons pouring off the leading car's tail, swirling in its
//     wake and parting round the car behind: one instanced-free mesh of RIBBONS × SEGMENTS
//     quads whose shape is computed in the vertex shader (camera-facing, so they read as
//     smoke-thin lines from any angle), dashes flowing toward the follower. Additive and
//     HDR-bright enough for a whisper of bloom; their opacity is the draft.
//   • haze — a long refraction plume through the gap between the two cars (fx.haze, drawn by
//     postfx.js's heat-haze pass), so the air itself looks disturbed.
//   • the gauge — `--tow` (0..1) and data-tow on #pocabinetGauge: the empty bottom quarter of
//     the rev ring fills from the middle out, and the glass glows cyan (PoCabinetPage.razor.css).
//
// Reduced motion keeps the meter and a still, faint set of lines; the flow and the haze stop.

import * as THREE from 'three';
import * as ph from './physics.js';

const CAR_LEN = 39;          // sim units, nose to tail (physics.js hull)
const WAKE_LEN = 170;        // sim units behind a car's tail that still tow
const WAKE_HALF = 15;        // sim units either side of its line
const RIBBONS = 18;
const SEGMENTS = 48;
const TAIL_X = -2.0;         // car-local tail (cars.js builds along +X)

const VERT = /* glsl */ `
attribute float aLine;
attribute float aAlong;
attribute float aSide;
uniform float uLen;          // world units from the leader's tail to past the follower
uniform float uFollow;       // car-local x of the follower's centre (negative)
uniform float uTime;
uniform float uWidth;
varying float vAlong;
varying float vSide;
varying float vSeed;

float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }

vec3 stream(float s, float line) {
    float seed = hash(line + 1.7);
    float a0 = line / ${RIBBONS}.0 * 6.2831853;
    float r0 = 0.32 + seed * 0.42;
    float x = ${TAIL_X.toFixed(2)} - s * uLen;
    // The wake widens and swirls as it trails; round the car behind it is pushed outward.
    float bump = exp(-pow((x - uFollow) / 2.4, 2.0));
    float r = r0 * (1.0 + s * 0.9) + bump * 0.95;
    float a = a0 + s * (2.4 + seed) * (mod(line, 2.0) * 2.0 - 1.0) + uTime * 0.7;
    float y = 0.72 + sin(a) * r * 0.62 + bump * 0.25;
    float z = cos(a) * r * 1.15;
    return vec3(x, max(y, 0.06), z);
}

void main() {
    float s = aAlong;
    vec4 p = modelViewMatrix * vec4(stream(s, aLine), 1.0);
    vec4 q = modelViewMatrix * vec4(stream(min(1.0, s + 0.02), aLine), 1.0);
    vec4 b = modelViewMatrix * vec4(stream(max(0.0, s - 0.02), aLine), 1.0);
    vec2 t = (q.xy / max(-q.z, 0.1)) - (b.xy / max(-b.z, 0.1));
    vec2 n = normalize(vec2(-t.y, t.x) + 1e-6);
    p.xy += n * aSide * uWidth * max(-p.z, 0.1) * 0.0045;
    gl_Position = projectionMatrix * p;
    vAlong = s;
    vSide = aSide;
    vSeed = hash(aLine * 3.1);
}`;

const FRAG = /* glsl */ `
uniform float uAmount;
uniform float uTime;
uniform float uFlow;
varying float vAlong;
varying float vSide;
varying float vSeed;
void main() {
    float f = fract(vAlong * (5.0 + vSeed * 3.0) - uTime * uFlow * (1.6 + vSeed) + vSeed * 7.0);
    float dash = smoothstep(0.0, 0.12, f) * smoothstep(0.7, 0.3, f);
    float ends = smoothstep(0.0, 0.08, vAlong) * smoothstep(1.0, 0.72, vAlong);
    float edge = 1.0 - abs(vSide);
    float a = uAmount * mix(0.35, 1.0, dash) * ends * edge * 0.6;
    gl_FragColor = vec4(vec3(0.72, 0.88, 1.0) * 1.6 * a, a);
}`;

export class Slipstream {
    /** @param scene SceneHandle (scene.js) */
    constructor(scene) {
        this.scene = scene;
        this.draft = 0;
        this.ahead = null;
        this.time = 0;
        this.gauge = null;
        this.lastTow = -1;

        const n = RIBBONS * SEGMENTS * 2;
        const line = new Float32Array(n), along = new Float32Array(n), side = new Float32Array(n);
        for (let r = 0, k = 0; r < RIBBONS; r++) {
            for (let s = 0; s < SEGMENTS; s++) {
                for (const sd of [-1, 1]) {
                    line[k] = r; along[k] = s / (SEGMENTS - 1); side[k] = sd; k++;
                }
            }
        }
        const idx = [];
        for (let r = 0; r < RIBBONS; r++) {
            for (let s = 0; s < SEGMENTS - 1; s++) {
                const a = (r * SEGMENTS + s) * 2;
                idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            }
        }
        const geom = new THREE.BufferGeometry();
        // three needs a position attribute to draw; the shape comes from the shader.
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        geom.setAttribute('aLine', new THREE.BufferAttribute(line, 1));
        geom.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
        geom.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
        geom.setIndex(idx);
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT, fragmentShader: FRAG,
            uniforms: {
                uLen: { value: 10 }, uFollow: { value: -8 }, uTime: { value: 0 }, uWidth: { value: 1 },
                uAmount: { value: 0 }, uFlow: { value: 1 },
            },
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(geom, this.material);
        this.mesh.name = 'pocabinet-slipstream';
        this.mesh.frustumCulled = false;
        this.mesh.matrixAutoUpdate = false;
        this.mesh.visible = false;
        this.mesh.renderOrder = 5;
        scene.scene.add(this.mesh);
    }

    /**
     * Once a frame, after race.js has placed the cars. `focus` is the car in view, `cars` the
     * field; `gauge` the solo HUD's #pocabinetGauge when there is one.
     */
    update(dt, focus, cars, gauge) {
        const fx = this.scene.fx;
        const reduced = !!fx.reduced;
        this.time += reduced ? 0 : dt;
        let best = null, target = 0;
        if (focus && focus.render && Array.isArray(cars)) {
            const r = focus.render;
            const fxh = Math.cos(r.heading), fyh = Math.sin(r.heading);
            const speed01 = Math.min(1, Math.abs(r.speed) / ph.MAX_SPEED);
            const fast = Math.max(0, Math.min(1, (speed01 - 0.35) / 0.35));
            if (fast > 0) {
                for (const c of cars) {
                    if (c === focus || !c.render || c.body?.wrecked) continue;
                    const dx = c.render.x - r.x, dy = c.render.y - r.y;
                    const along = dx * fxh + dy * fyh - CAR_LEN;
                    if (along < 2 || along > WAKE_LEN) continue;
                    const lat = Math.abs(-dx * fyh + dy * fxh);
                    if (lat > WAKE_HALF) continue;
                    if (Math.cos(c.render.heading - r.heading) < 0.9) continue;
                    const k = (1 - along / WAKE_LEN) * (1 - (lat / WAKE_HALF) ** 2) * fast;
                    if (k > target) { target = k; best = c; }
                }
            }
        }
        // In quickly, out a little slower (the tow lets go as you pull out).
        const rate = target > this.draft ? 4 : 2.5;
        this.draft += (target - this.draft) * (dt > 0 ? 1 - Math.exp(-dt * rate) : 0);
        if (this.draft < 0.003) this.draft = 0;
        if (best) this.ahead = best;
        if (this.draft === 0) this.ahead = null;
        fx.draft = this.draft;
        fx.draftAhead = this.ahead;

        this.place(focus, reduced);
        this.meter(gauge);
    }

    place(focus, reduced) {
        const fx = this.scene.fx;
        const lead = this.ahead;
        const group = lead?.mesh?.group;
        const show = this.draft > 0.01 && group && focus?.render;
        this.mesh.visible = !!show;
        if (fx.haze) fx.haze.length = 0;
        if (!show) return;
        group.updateWorldMatrix(true, false);
        this.mesh.matrix.copy(group.matrixWorld);
        this.mesh.matrixWorldNeedsUpdate = true;
        const gap = Math.hypot(lead.render.x - focus.render.x, lead.render.y - focus.render.y) / 10;
        const u = this.material.uniforms;
        u.uFollow.value = -gap;
        u.uLen.value = Math.max(4, gap + 2.6);
        u.uTime.value = this.time;
        u.uAmount.value = Math.min(1, this.draft * 1.4) * (reduced ? 0.5 : 1);
        u.uFlow.value = reduced ? 0 : 1;
        u.uWidth.value = 1.8;
        if (reduced) return;
        // The haze plume: the leader's tail to the follower's nose.
        const tail = new THREE.Vector3(TAIL_X, 0.6, 0).applyMatrix4(group.matrixWorld);
        const h = focus.render.heading;
        const nose = new THREE.Vector3(focus.render.x / 10 + Math.cos(h) * 1.9, focus.render.h + 0.6, focus.render.y / 10 + Math.sin(h) * 1.9);
        (fx.haze || (fx.haze = [])).push({ x: tail.x, y: tail.y, z: tail.z, tx: nose.x, ty: nose.y, tz: nose.z, radius: 1.1, strength: this.draft * 1.6 });
    }

    meter(gauge) {
        if (gauge !== this.gauge) { this.gauge = gauge || null; this.lastTow = -1; }
        const g = this.gauge;
        if (!g || !g.isConnected) return;
        const tow = Math.round(Math.min(1, this.draft * 1.25) * 100) / 100;
        if (tow === this.lastTow) return;
        this.lastTow = tow;
        g.style.setProperty('--tow', tow.toFixed(2));
        g.dataset.tow = tow > 0.15 ? 'on' : 'off';
    }

    dispose() {
        this.scene.scene?.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        const fx = this.scene.fx;
        if (fx) { fx.draft = 0; fx.draftAhead = null; if (fx.haze) fx.haze.length = 0; }
        if (this.gauge) { this.gauge.style.removeProperty('--tow'); this.gauge.dataset.tow = 'off'; }
    }
}
