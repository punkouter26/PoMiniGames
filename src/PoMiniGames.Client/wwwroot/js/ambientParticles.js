// §4 WebGL ambient particle field. 200 GPU-resident points rendered with a
// single fragment shader that computes a soft-circle + slow drift. Zero JS
// per-frame allocations; runs only when the page is visible.
//
// §7 (2026-07-29) Rendering moved to a worker + OffscreenCanvas. In Blazor WASM
// the main thread runs the .NET runtime, so the old main-thread rAF loop shared
// a thread with game logic and stuttered visibly during GC. The worker path
// decouples them. Browsers without `transferControlToOffscreen` fall back to the
// original in-thread renderer below — same shader, via particlesCore.js.
//
// This file keeps ownership of everything DOM-shaped (pointer, resize,
// intersection, visibility) because a worker cannot touch the DOM; it forwards
// those as messages.

import { initGl, drawFrame, POINT_COUNT } from './particlesCore.js';

let worker = null;

// Main-thread fallback state.
let gl = null;
let uniforms = null;
let raf = 0;
let visible = true;
let inViewport = true;
let lastX = 0.5;
let lastY = 0.5;
let currentPointCount = POINT_COUNT;

// Shared DOM observers (both paths).
let resizeObs = null;
let intersectObs = null;
let boundCanvas = null;
let onPointerMove = null;
let onTierChange = null;
let onVisibilityChange = null;
let onPageHide = null;

function currentQualityScale() {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--gfx-particles');
        const n = parseFloat(v);
        return Number.isFinite(n) && n > 0 ? n : 1;
    } catch {
        return 1;
    }
}

function attachDomObservers(canvas, onResize, onPointer, onVisible, onViewport, onQuality) {
    boundCanvas = canvas;

    resizeObs = new ResizeObserver(() => {
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        onResize(
            Math.max(1, Math.floor(canvas.clientWidth * dpr)),
            Math.max(1, Math.floor(canvas.clientHeight * dpr)));
    });
    resizeObs.observe(canvas);

    onPointerMove = (e) => {
        const rect = canvas.getBoundingClientRect();
        onPointer(
            ((e.clientX - rect.left) / rect.width) || 0,
            1 - ((e.clientY - rect.top) / rect.height) || 0);
    };
    canvas.addEventListener('pointermove', onPointerMove, { passive: true });

    // Keep references: these must be the SAME function objects passed to
    // removeEventListener in stop(), or the listeners outlive the canvas.
    onVisibilityChange = onVisible;
    onPageHide = stop;
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    // §2 battery guard: pause rendering when the canvas leaves the viewport.
    intersectObs = new IntersectionObserver((entries) => {
        for (const e of entries) onViewport(e.isIntersecting);
    }, { rootMargin: '50px' });
    intersectObs.observe(canvas);

    // §10 adaptive quality: visualRuntime.js is the single authority on how much
    // the machine can afford. The old local "60 slow frames -> halve the points"
    // heuristic is gone; two independent throttles could disagree and fight.
    onTierChange = () => onQuality(currentQualityScale());
    window.addEventListener('po-gfx-tier', onTierChange);
    onQuality(currentQualityScale());
}

export function start(canvas) {
    // ── Preferred path: render in a worker ─────────────────────────────
    if (typeof Worker === 'function' && typeof canvas.transferControlToOffscreen === 'function') {
        try {
            const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
            const off = canvas.transferControlToOffscreen();
            worker = new Worker(new URL('./particlesWorker.js', import.meta.url), { type: 'module' });

            let failed = false;
            worker.onmessage = (e) => {
                if (e.data && e.data.type === 'failed') {
                    // WebGL2 unavailable inside the worker. The canvas has
                    // already been transferred and cannot be reclaimed, so we
                    // cannot retry in-thread — leave it blank and let the CSS
                    // gradient behind it show through, same as the old
                    // no-WebGL behaviour.
                    failed = true;
                    stop();
                }
            };
            if (failed) return false;

            worker.postMessage({
                type: 'init',
                canvas: off,
                width: Math.max(1, Math.floor(canvas.clientWidth * dpr)),
                height: Math.max(1, Math.floor(canvas.clientHeight * dpr)),
            }, [off]);

            attachDomObservers(
                canvas,
                (w, h) => worker && worker.postMessage({ type: 'resize', width: w, height: h }),
                (x, y) => worker && worker.postMessage({ type: 'pointer', x, y }),
                () => worker && worker.postMessage({ type: 'visibility', visible: !document.hidden }),
                (iv) => worker && worker.postMessage({ type: 'viewport', inViewport: iv }),
                (scale) => worker && worker.postMessage({ type: 'quality', scale }));
            return true;
        } catch {
            // Fall through to the in-thread renderer.
            worker = null;
        }
    }

    // ── Fallback: original main-thread renderer ────────────────────────
    gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) {
        // Leave the canvas blank. The CSS gradient behind it stays visible.
        return false;
    }
    uniforms = initGl(gl);
    if (!uniforms) { gl = null; return false; }

    attachDomObservers(
        canvas,
        (w, h) => {
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            gl.viewport(0, 0, canvas.width, canvas.height);
        },
        (x, y) => { lastX = x; lastY = y; },
        () => { visible = !document.hidden; },
        (iv) => { inViewport = iv; },
        (scale) => { currentPointCount = Math.max(20, Math.round(POINT_COUNT * scale)); });

    const startTime = performance.now();
    function tick(now) {
        if (!gl) return;
        if (visible && inViewport) {
            drawFrame(gl, uniforms, canvas.width, canvas.height,
                now - startTime, lastX, lastY, currentPointCount);
        }
        raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return true;
}

export function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;

    if (worker) {
        try { worker.postMessage({ type: 'stop' }); } catch { /* already dead */ }
        worker = null;
    }

    if (onVisibilityChange) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        onVisibilityChange = null;
    }
    if (onPageHide) {
        window.removeEventListener('pagehide', onPageHide);
        onPageHide = null;
    }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (intersectObs) { intersectObs.disconnect(); intersectObs = null; }
    if (onTierChange) { window.removeEventListener('po-gfx-tier', onTierChange); onTierChange = null; }
    if (boundCanvas && onPointerMove) {
        boundCanvas.removeEventListener('pointermove', onPointerMove);
    }
    onPointerMove = null;
    boundCanvas = null;

    if (gl) {
        if (uniforms && uniforms.buffer) gl.deleteBuffer(uniforms.buffer);
        if (uniforms && uniforms.program) gl.deleteProgram(uniforms.program);
    }
    uniforms = null;
    gl = null;
}
