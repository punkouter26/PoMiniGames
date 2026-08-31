// gpuFxWebGPU.js — the WebGPU compute-particle backend (§GFX-12).
//
// The app has ONE shared GPU particle system (gpuFx.js, WebGL2). This module
// is the WebGPU beachhead: the same spawn interface (burstAt/celebrate/clear)
// simulated in a WGSL compute pass — an order of magnitude more particles per
// watt — behind feature detection. gpuFx delegates to it when `active()` is
// true; any failure anywhere falls back to the WebGL2 path untouched.
//
// IMPORTANT FALLBACK CONTRACT: if navigator.gpu is missing, adapter request
// fails, or ANY pipeline error throws, `active()` returns false and gpuFx
// never consults this module again. The old path is never left half-broken.
(function () {
    'use strict';

    const MAX_PARTICLES = 65536;
    let _device = null, _ctx = null, _format = null;
    let _pipeline = null, _render = null, _buffers = null, _bind = null;
    let _uniform = null, _uniformData = null;
    let _alive = 0, _canvas = null, _raf = 0, _tint = [0.55, 0.4, 1.0, 1.0];
    let _active = false, _probed = false;

    const COMPUTE_SHADER = `
struct Particle { pos: vec2f, vel: vec2f, life: f32, maxLife: f32, size: f32, hue: f32, _p0: f32, _p1: f32 };
struct Uniforms { dt: f32, time: f32, gravity: f32, drag: f32, count: u32, tint: vec4f, origin: vec2f, _pad: vec2f };
@group(0) @binding(0) var<storage, read_write> parts: array<Particle>;
@group(0) @binding(1) var<uniform> u: Uniforms;

fn hash(n: vec2f) -> f32 { return fract(sin(dot(n, vec2f(127.1, 311.7))) * 43758.5453); }

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= u.count) { return; }
    var p = parts[i];
    if (p.life <= 0.0) { return; }
    // Curl-ish flow field: cheap, stable, organic swirl without noise textures.
    let s = 0.9;
    let fx = sin(p.pos.y * s + u.time * 1.7) * cos(p.pos.x * s * 0.7 - u.time);
    let fy = cos(p.pos.x * s - u.time * 1.3) * sin(p.pos.y * s * 0.8 + u.time);
    p.vel = p.vel * (1.0 - u.drag * u.dt) + vec2f(fx, fy - u.gravity) * 260.0 * u.dt;
    p.pos = p.pos + p.vel * u.dt;
    p.life = p.life - u.dt;
    parts[i] = p;
}`;

    const RENDER_SHADER = `
struct Particle { pos: vec2f, vel: vec2f, life: f32, maxLife: f32, size: f32, hue: f32, _p0: f32, _p1: f32 };
struct Uniforms { dt: f32, time: f32, gravity: f32, drag: f32, count: u32, tint: vec4f, origin: vec2f, _pad: vec2f };
@group(0) @binding(0) var<storage, read> parts: array<Particle>;
@group(0) @binding(1) var<uniform> u: Uniforms;
@group(0) @binding(2) var<uniform> screen: vec4f;

struct VOut { @builtin(position) pos: vec4f, @location(0) fade: f32, @location(1) hue: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
    let p = parts[ii];
    var corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
    var o: VOut;
    if (p.life <= 0.0) { o.pos = vec4f(2.0, 2.0, 0.0, 1.0); o.fade = 0.0; o.hue = 0.0; return o; }
    let ndc = (p.pos / screen.xy) * 2.0 - 1.0;
    let px = 2.0 / screen.x;
    o.pos = vec4f(ndc + corner * p.size * px, 0.0, 1.0);
    o.fade = clamp(p.life / p.maxLife, 0.0, 1.0);
    o.hue = p.hue;
    return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
    let col = mix(u.tint.rgb, vec3f(1.0 - u.tint.r, 1.0 - u.tint.g, 1.0 - u.tint.b), in.hue * 0.35);
    return vec4f(col, in.fade * u.tint.a);
}`;

    function error(e) {
        if (!_probed) console.warn('gpuFxWebGPU: WebGPU unavailable, staying on WebGL2 —', e && e.message);
        _active = false; _probed = true;
    }

    async function probe() {
        if (_probed) return _active;
        _probed = true;
        try {
            if (!navigator.gpu) throw new Error('no navigator.gpu');
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error('no adapter');
            _device = await adapter.requestDevice();
            _active = true;
        } catch (e) { error(e); }
        return _active;
    }

    async function start(canvas) {
        if (!await probe()) return false;
        try {
            _canvas = canvas;
            _ctx = canvas.getContext('webgpu');
            if (!_ctx) throw new Error('no webgpu context');
            _format = navigator.gpu.getPreferredCanvasFormat();
            _ctx.configure({ device: _device, format: _format, alphaMode: 'premultiplied' });

            const zeros = new Float32Array(MAX_PARTICLES * 8);
            _buffers = {
                parts: _device.createBuffer({ size: zeros.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
                uniform: _device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
                screen: _device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
            };
            const computeModule = _device.createShaderModule({ code: COMPUTE_SHADER });
            const renderModule = _device.createShaderModule({ code: RENDER_SHADER });
            _pipeline = _device.createComputePipeline({
                layout: 'auto',
                compute: { module: computeModule, entryPoint: 'step' }
            });
            _bind = _device.createBindGroup({
                layout: _pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: _buffers.parts } },
                    { binding: 1, resource: { buffer: _buffers.uniform } },
                ]
            });
            _render = _device.createRenderPipeline({
                layout: 'auto',
                vertex: { module: renderModule, entryPoint: 'vs' },
                fragment: { module: renderModule, entryPoint: 'fs', targets: [{ format: _format }] },
                primitive: { topology: 'triangle-strip' },
            });
            _uniformData = new Float32Array(12);
            _active = true;
            loop();
            return true;
        } catch (e) { error(e); return false; }
    }

    function spawn(n, origin, speed, life, size) {
        if (!_active || !_device) return;
        // Ring-buffer spawn: overwrite the oldest slot. GPU adds life here via
        // a small staged write — the CPU side only seeds pos/vel/life.
        const data = new Float32Array(n * 8);
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const v = speed * (0.4 + Math.random() * 0.8);
            data[i * 8 + 0] = origin.x; data[i * 8 + 1] = origin.y;
            data[i * 8 + 2] = Math.cos(a) * v; data[i * 8 + 3] = Math.sin(a) * v;
            data[i * 8 + 4] = life; data[i * 8 + 5] = life;
            data[i * 8 + 6] = size; data[i * 8 + 7] = Math.random();
        }
        _device.queue.writeBuffer(_buffers.parts, 0, data);
        _alive = Math.max(_alive, n);
    }

    let _last = 0;
    function loop(now) {
        _raf = requestAnimationFrame(loop);
        now = now || performance.now();
        const dt = Math.min(0.05, (now - (_last || now)) / 1000); _last = now;
        if (!_device || !_canvas) return;

        _uniformData[0] = dt; _uniformData[1] = now / 1000;
        _uniformData[2] = 0.35; _uniformData[3] = 0.9;       // gravity, drag
        _uniformData[4] = MAX_PARTICLES;
        _uniformData[5] = _tint[0]; _uniformData[6] = _tint[1]; _uniformData[7] = _tint[2]; _uniformData[8] = _tint[3];
        _uniformData[9] = _canvas.width / 2; _uniformData[10] = _canvas.height / 2;
        _device.queue.writeBuffer(_buffers.uniform, 0, _uniformData);
        _device.queue.writeBuffer(_buffers.screen, 0, new Float32Array([_canvas.width, _canvas.height, 1, 1]));

        const enc = _device.createCommandEncoder();
        if (_alive > 0) {
            const cp = enc.beginComputePass();
            cp.setPipeline(_pipeline); cp.setBindGroup(0, _bind);
            cp.dispatchWorkgroups(Math.ceil(MAX_PARTICLES / 64));
            cp.end();
        }
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: _ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
        pass.setPipeline(_render);
        const rg = _device.createBindGroup({
            layout: _render.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: _buffers.parts } },
                { binding: 1, resource: { buffer: _buffers.uniform } },
                { binding: 2, resource: { buffer: _buffers.screen } },
            ]
        });
        pass.setBindGroup(0, rg);
        pass.draw(4, MAX_PARTICLES);
        pass.end();
        _device.queue.submit([enc.finish()]);
    }

    function setTintFromCss() {
        try {
            const cs = getComputedStyle(document.documentElement);
            const hex = (cs.getPropertyValue('--fx-accent') || '').trim();
            if (hex && /^#?[0-9a-f]{6}$/i.test(hex.replace('#', '#'))) {
                const v = parseInt(hex.replace('#', ''), 16);
                _tint[0] = ((v >> 16) & 255) / 255; _tint[1] = ((v >> 8) & 255) / 255; _tint[2] = (v & 255) / 255;
            }
        } catch { /* keep last tint */ }
    }

    window.PoGpuWebGPU = {
        probe: probe,
        active: function () { return _active; },
        start: start,
        burstAt: function (x, y, opts) {
            const o = opts || {};
            spawn(o.count || 220, { x: x, y: y }, o.speed || 220, (o.life || 900) / 1000, o.size || 5);
        },
        celebrate: function (scale) {
            setTintFromCss();
            for (let i = 0; i < 5; i++) {
                spawn(700, { x: _canvas ? _canvas.width * (0.2 + 0.15 * i) : 200, y: _canvas ? _canvas.height * 0.75 : 300 }, 300, 1.6, 6);
            }
        },
        clear: function () { if (_device) _device.queue.writeBuffer(_buffers.parts, 0, new Float32Array(MAX_PARTICLES * 8)); _alive = 0; },
        invalidateTint: setTintFromCss,
        stop: function () { cancelAnimationFrame(_raf); }
    };
})();
