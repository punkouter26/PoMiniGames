// engineLoader.js — route-gated loading for the per-game engines.
//
// ── Why ────────────────────────────────────────────────────────────────────
// index.html used to load every game engine eagerly on first paint: marblerace,
// pobrawl, posports, poracer and posurvive, plus their three.js / cannon-es
// imports. That is ~24,600 lines of JavaScript parsed and executed to render a
// menu — and the overwhelming majority of sessions never open more than one
// game, if any. On a mid-range phone it is the single largest cost between
// "navigation started" and "home page interactive".
//
// ── Contract preserved exactly ─────────────────────────────────────────────
// Each engine's index.js assigns a global (window.PoBrawl, window.PoMarbleRace,
// …) and every Blazor page calls through that global. Nothing about that
// changes. This module only defers WHEN the module is evaluated; the call sites
// stay `JS.InvokeVoidAsync("PoBrawl.init", …)`.
//
// A page awaits `loadEngine('pobrawl')` once, before its first interop call.
// After that the global is present and behaves identically to the eager build.
//
// Concurrency: the promise is cached per engine, so two components racing to
// load the same engine share one network fetch and one module evaluation.
// A failed load is NOT cached — the entry is dropped so a later retry (e.g.
// after the player reconnects) can genuinely re-attempt instead of replaying a
// rejected promise forever.

// Paths are relative to the DOCUMENT base (index.html's <base href>), never to
// this module. See resolve() for why that distinction is load-bearing.
const REGISTRY = {
    // key            module entry                  global it registers
    marblerace: ['js/marblerace/index.js', 'PoMarbleRace'],
    pobrawl: ['js/pobrawl/index.js', 'PoBrawl'],
    posports: ['js/posports/index.js', 'PoSports'],
    poracer: ['js/poracerGl.js', 'PoRacerRender'],
};

/**
 * Resolve an engine asset path against the document base.
 *
 * A bare or './'-prefixed specifier passed to `import()` resolves against the
 * URL of the MODULE DOING THE IMPORTING — not against the document — while the
 * same string on a <script src> resolves against the document base. This module
 * is served from /js/, so the two conventions silently disagree by one path
 * segment: './js/pobrawl/index.js' imported from /js/engineLoader.js requests
 * /js/js/pobrawl/index.js and 404s, taking every engine down with it while the
 * classic-script deps beside it loaded fine.
 *
 * Resolving explicitly against document.baseURI makes both tables mean the same
 * thing, and keeps working if the app is ever served from a sub-path.
 */
function resolve(path) {
    return new URL(path, document.baseURI).href;
}

// Classic (non-module) scripts an engine also needs. These assign their globals
// as a side effect of executing, so they are injected as <script> and awaited on
// load rather than imported.
const CLASSIC_DEPS = {
    poracer: ['js/racingInterop.js'],
};

const _pending = new Map();

// The settle callback is named `ok` rather than `resolve` so it cannot shadow
// the module-level resolve() used for the src below.
function loadClassic(src) {
    return new Promise((ok, reject) => {
        // Idempotent: a second request for the same file resolves immediately
        // rather than re-executing it and clobbering live engine state.
        const existing = document.querySelector(`script[data-engine-dep="${src}"]`);
        if (existing) {
            if (existing.dataset.loaded === '1') ok();
            else existing.addEventListener('load', () => ok(), { once: true });
            return;
        }
        const el = document.createElement('script');
        el.src = resolve(src);
        el.dataset.engineDep = src;
        el.addEventListener('load', () => { el.dataset.loaded = '1'; ok(); }, { once: true });
        el.addEventListener('error', () => reject(new Error(`failed to load ${src}`)), { once: true });
        document.head.appendChild(el);
    });
}

/**
 * Ensure a game engine is loaded and its global registered.
 *
 * @param {string} name key from REGISTRY
 * @returns {Promise<boolean>} true once the global is available; false if the
 *   engine could not be loaded. Callers should treat false as "show the error
 *   state", not as a reason to throw — a failed engine load is a broken network
 *   or a missing asset, and the page above it is still navigable.
 */
export async function loadEngine(name) {
    const entry = REGISTRY[name];
    if (!entry) {
        console.error('[engineLoader] unknown engine:', name);
        return false;
    }

    const [modulePath, globalName] = entry;

    // Already up — either a previous load, or a page that was re-entered.
    if (window[globalName]) return true;

    if (!_pending.has(name)) {
        const p = (async () => {
            for (const dep of CLASSIC_DEPS[name] ?? []) {
                await loadClassic(dep);
            }
            await import(resolve(modulePath));
            if (!window[globalName]) {
                throw new Error(`${modulePath} did not register window.${globalName}`);
            }
            return true;
        })().catch((err) => {
            console.error(`[engineLoader] ${name} failed to load:`, err);
            // Drop the rejected promise so a retry is a real retry.
            _pending.delete(name);
            return false;
        });
        _pending.set(name, p);
    }

    return _pending.get(name);
}

// Blazor's IJSRuntime resolves dotted paths off `window`, and this module is
// loaded with type="module" (so it has its own scope). Publish the one entry
// point the pages call.
window.loadEngine = loadEngine;
