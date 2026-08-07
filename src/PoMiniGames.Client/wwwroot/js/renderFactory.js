// renderFactory.js — one place that decides which GPU backend a scene runs on
// (§GFX-3).
//
// WebGPU is a real upgrade over WebGL2 where it applies: compute shaders,
// far cheaper draw-call submission, and render bundles that let a scene with
// many small meshes stop being CPU-bound. In a Blazor WASM app the last one
// matters more than usual, because the main thread is also running the .NET
// runtime and every saved millisecond of driver overhead is a millisecond the
// game logic gets back.
//
// WHAT THIS DOES *NOT* DO: silently migrate the whole app.
//
// PoBrawl and PoMarbleRace build their post-processing with EffectComposer,
// which in three r165 is WebGL-only — WebGPU postprocessing is a different API
// built on TSL nodes. Swapping their renderer would not "fall back gracefully",
// it would throw on the first composer.addPass(). Those two stay on WebGL2 by
// design — they call createRenderer({ preferWebGPU: false }) directly rather
// than asking whether the backend supports a composer.
//
// (A supportsEffectComposer(backend) predicate used to live here for that check.
// Removed 2026-08-07: nothing ever called it. The two composer games pin the
// backend at the call site instead, which is the check — a predicate that has to
// be remembered is weaker than a parameter that cannot be forgotten.)
//
// Scenes with no composer — the board games, and anything added later — get
// WebGPU when the browser has it and WebGL2 when it does not, from the same
// call, with no branching at the call site.
//
// DETECTION IS ASYNCHRONOUS AND MUST BE. `navigator.gpu` merely means the API
// is exposed; requestAdapter() can still resolve null (no compatible hardware,
// a blocklisted driver, a headless CI browser). Checking only for the namespace
// is the standard way to ship a WebGPU path that breaks on exactly the machines
// that needed the fallback.

/** @type {Promise<{supported: boolean, reason: string, info: object|null}>|null} */
let _probe = null;

/**
 * Is WebGPU actually usable here? Cached — requesting an adapter is not free
 * and the answer cannot change within a page lifetime.
 * @returns {Promise<{supported: boolean, reason: string, info: object|null}>}
 */
export function probeWebGPU() {
    if (_probe) return _probe;
    _probe = (async () => {
        try {
            if (typeof navigator === 'undefined' || !navigator.gpu) {
                return { supported: false, reason: 'no-navigator-gpu', info: null };
            }
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter) return { supported: false, reason: 'no-adapter', info: null };
            // requestAdapterInfo is not universally implemented; its absence is
            // not a reason to reject an adapter that exists.
            let info = null;
            try { info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null); } catch { /* optional */ }
            return { supported: true, reason: 'ok', info };
        } catch (e) {
            return { supported: false, reason: 'probe-threw', info: null };
        }
    })();
    return _probe;
}

/**
 * Create the best renderer available for a scene.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.preferWebGPU=true] set false for scenes that need
 *   EffectComposer; the factory then never even probes.
 * @param {boolean} [opts.antialias=true]
 * @param {boolean} [opts.alpha=false]
 * @param {number}  [opts.maxPixelRatio=2]
 * @returns {Promise<{renderer: object, backend: 'webgpu'|'webgl2', isWebGPU: boolean}>}
 */
export async function createRenderer(opts) {
    const o = opts || {};
    const THREE = await import('three');
    const antialias = o.antialias !== false;
    const alpha = !!o.alpha;
    // Render INTO the caller's canvas when it supplies one, rather than letting
    // three.js allocate its own and leaving the caller to swap the two.
    //
    // That swap is not a safe operation under Blazor. Scoped CSS is applied via a
    // generated `b-*` attribute that the framework stamps on the elements a
    // component renders; a canvas three.js created has no such attribute, so
    // every scoped rule silently stops matching it. Copying className across —
    // which is what the old swap did — preserves the selector but not the scope,
    // so the rule still cannot match. See boardGl.mount.
    const canvas = o.canvas || undefined;

    if (o.preferWebGPU !== false) {
        const probe = await probeWebGPU();
        if (probe.supported) {
            try {
                const mod = await import('three/addons/renderers/webgpu/WebGPURenderer.js');
                const WebGPURenderer = mod.default || mod.WebGPURenderer;
                const renderer = new WebGPURenderer({ antialias, alpha, canvas });
                // init() compiles the pipeline and acquires the device. It can
                // still reject after a successful adapter probe — a device is a
                // separate request and can fail on memory pressure — which is
                // why the WebGL2 path below is outside this try, not in an else.
                await renderer.init();
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, o.maxPixelRatio || 2));
                markBackend('webgpu');
                return { renderer, backend: 'webgpu', isWebGPU: true };
            } catch {
                // Fall through. Anything that goes wrong here — module fetch,
                // device request, pipeline creation — means WebGL2.
            }
        }
    }

    const renderer = new THREE.WebGLRenderer({ antialias, alpha, canvas });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, o.maxPixelRatio || 2));
    markBackend('webgl2');
    return { renderer, backend: 'webgl2', isWebGPU: false };
}

/**
 * Publish the chosen backend on <html> so the diagnostics page and any CSS that
 * cares can read it without asking the renderer.
 */
function markBackend(name) {
    try { document.documentElement.setAttribute('data-gfx-backend', name); } catch { /* no DOM */ }
}

/**
 * Render one frame, whichever backend is in play.
 *
 * WebGPURenderer.render() is asynchronous (it returns a promise that settles
 * when the command buffer is submitted) while WebGLRenderer.render() is not.
 * A game loop that awaited every frame would serialise itself against the GPU;
 * one that ignored the promise would get unhandled rejections on a device loss.
 * Calling through here does neither — it fires and swallows.
 *
 * @param {object} renderer
 * @param {object} scene
 * @param {object} camera
 */
export function renderFrame(renderer, scene, camera) {
    const r = renderer.render(scene, camera);
    if (r && typeof r.catch === 'function') r.catch(() => { /* device lost; next frame will fail too */ });
}

if (typeof window !== 'undefined') {
    window.PoRenderFactory = { probeWebGPU, createRenderer, renderFrame };
}
