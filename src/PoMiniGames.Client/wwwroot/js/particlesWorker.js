// particlesWorker.js — the ambient field, rendered off the main thread.
//
// In Blazor WASM the main thread runs the .NET runtime, so a main-thread rAF
// loop competes with game logic and with GC pauses: the field visibly hitches
// during a collection even though the GPU is idle. Rendering from a worker with
// an OffscreenCanvas decouples the two entirely — particles keep flowing at
// full rate while the runtime is busy.
//
// The main thread stays responsible for anything DOM-shaped (pointer position,
// element size, viewport intersection) and forwards it as messages; this file
// never touches the DOM because a worker cannot.

import { initGl, drawFrame, POINT_COUNT } from './particlesCore.js';

let gl = null;
let u = null;
let canvas = null;
let raf = 0;
let startTime = 0;

let mouseX = 0.5;
let mouseY = 0.5;
let visible = true;
let inViewport = true;
let count = POINT_COUNT;
let qualityScale = 1;

function tick(now) {
    if (!gl) return;
    if (visible && inViewport) {
        drawFrame(gl, u, canvas.width, canvas.height, now - startTime, mouseX, mouseY, count);
    }
    raf = requestAnimationFrame(tick);
}

self.onmessage = (e) => {
    const m = e.data || {};
    switch (m.type) {
        case 'init': {
            canvas = m.canvas;
            gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
            if (!gl) { self.postMessage({ type: 'failed' }); return; }
            u = initGl(gl);
            if (!u) { self.postMessage({ type: 'failed' }); return; }
            canvas.width = m.width;
            canvas.height = m.height;
            gl.viewport(0, 0, canvas.width, canvas.height);
            startTime = performance.now();
            raf = requestAnimationFrame(tick);
            self.postMessage({ type: 'started' });
            break;
        }
        case 'resize': {
            if (!gl || !canvas) return;
            canvas.width = m.width;
            canvas.height = m.height;
            gl.viewport(0, 0, canvas.width, canvas.height);
            break;
        }
        case 'pointer':
            mouseX = m.x;
            mouseY = m.y;
            break;
        case 'visibility':
            visible = m.visible;
            break;
        case 'viewport':
            inViewport = m.inViewport;
            break;
        case 'quality':
            // Driven by visualRuntime.js's adaptive tier (§10). The old
            // per-worker thermal heuristic is gone: one authority for quality
            // beats two that can disagree.
            qualityScale = Math.max(0.05, Math.min(1, m.scale));
            count = Math.max(20, Math.round(POINT_COUNT * qualityScale));
            break;
        case 'stop':
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
            gl = null;
            u = null;
            canvas = null;
            self.close();
            break;
    }
};
