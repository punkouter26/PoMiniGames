// quality.js — PoBrawl's adaptive-quality policy.
//
// WHY THIS EXISTS (2026-08-11 PoBrawl audit #1/#2/#3/#4):
// visualRuntime.js has measured frame rate and published a high/medium/low tier on
// <html data-gfx> since it was written, and PoMarbleRace gates its heavy pass on it
// (PostFx.allowHeavy). PoBrawl consumed that tier for exactly ONE thing — the KO
// rack-focus blur in postFx.js — while GTAO, bloom, MSAA×4, a 4096² shadow map and
// the device pixel ratio all ran unconditionally. A machine the tier system had
// already demoted to 'low' rendered a byte-identical frame to a workstation. The
// most expensive game in the app was the one ignoring the throttle.
//
// Everything the renderer can cheaply retune therefore lives in one table here,
// and game.js applies it at boot and again whenever the tier moves.
//
// ── STATIC vs DYNAMIC, and why the split is load-bearing ────────────────────
// Some of these settings are free to change on a live renderer and some force
// three.js to recompile every material in the scene, which is a multi-frame hitch
// on rigs carrying ~40 meshes each — precisely the stall you must not introduce on
// a machine that is already dropping frames.
//
//   DYNAMIC (re-applied on every tier change):
//     • pixelRatio      — a renderer property; costs one canvas resize.
//     • pass.enabled    — EffectComposer skips a disabled pass entirely, so
//                         toggling GTAO/bloom off is genuinely free.
//     • shadow.mapSize  — disposes and reallocates the depth target. No #define
//                         changes, so no material touches its shader.
//     • msaaSamples     — a render-target property. Changing it rebuilds the
//                         composer (new targets) but recompiles no materials, so
//                         it is applied only when the value actually moves.
//
//   STATIC (read at build time, never re-applied to live objects):
//     • rectAreaLights     — the scene's light counts are #defines. Removing one
//                            mid-fight recompiles every lit material at once. The
//                            win is real but not worth the stall, so the count is
//                            fixed by whatever tier the machine booted at.
//     • physicalMaterials  — swapping a material's class means new shader programs
//                            for every mesh wearing it. Read per fighter build, so
//                            unlike the light count this one DOES pick up a tier
//                            change — at the next spawn, which is every round.
//
// Set POBRAWL_QUALITY_OVERRIDE on window to pin a tier while profiling.

import * as VisualRuntime from '../visualRuntime.js';

/**
 * Per-tier renderer settings.
 *
 * `maxDpr` is a CEILING applied on top of PoCanvasDpr.resolve(), never instead of
 * it — resolve() already enforces the shared ~1.44 Mpx backing-store budget that
 * protects large desktop windows, and this only tightens it further.
 */
const PRESETS = {
  high: {
    maxDpr: 2,
    msaaSamples: 4,
    // GTAO is the single most expensive pass in three's addons: a depth+normal
    // prepass, a multi-sample AO pass and a denoise, all at full resolution every
    // frame. Kept at the top tier only, and even there at half the stock sample
    // count — the term it produces is a broad contact darkening, not a detail
    // feature, so 8 samples is visually indistinguishable from 16 at this camera
    // distance while costing half.
    gtao: true,
    gtaoSamples: 8,
    bloom: true,
    // 2048, not the 4096 this used to be. A 4096² PCFSoft map is a ~64 MB depth
    // target re-rendering the whole scene every frame; over the tight ±6.5 shadow
    // frustum here 2048 still puts ~157 texels per world metre under the fighters'
    // feet, which is past the point PCFSoft's fixed kernel can resolve.
    keyShadow: 2048,
    // The overhead spot's shadow only reads during the KO push-in. 1024 is enough
    // for that framing and a quarter of the 2048 it was paying during every frame
    // of every fight.
    spotShadow: 1024,
    rectAreaLights: 2,
    physicalMaterials: true,
  },
  medium: {
    maxDpr: 1.5,
    msaaSamples: 2,
    gtao: false,
    gtaoSamples: 8,
    bloom: true,
    keyShadow: 1024,
    // Below the top tier the spot stops casting entirely: the key light already
    // grounds the fighters, and this removes a whole second shadow render.
    spotShadow: 0,
    rectAreaLights: 1,
    // Sheen and clearcoat are what make the wardrobe read as fabric rather than
    // plastic, so they survive one tier below the top. See buildFighter's `dress`.
    physicalMaterials: true,
  },
  low: {
    maxDpr: 1,
    msaaSamples: 0,
    gtao: false,
    gtaoSamples: 8,
    bloom: false,
    keyShadow: 512,
    spotShadow: 0,
    // RectAreaLight adds an LTC texture lookup to every lit fragment of every
    // MeshPhysicalMaterial in the scene. At this tier the rig look is not worth it.
    rectAreaLights: 0,
    // The fighters are the most-drawn objects in the frame and every material on
    // them was physical. Dropping the extra BRDF lobes is the largest per-pixel
    // saving available at this tier.
    physicalMaterials: false,
  },
};

/** Current tier name, honouring a profiling override. */
export function tier() {
  const forced = typeof window !== 'undefined' && window.POBRAWL_QUALITY_OVERRIDE;
  if (forced && PRESETS[forced]) return forced;
  try {
    const t = VisualRuntime.getTier();
    return PRESETS[t] ? t : 'high';
  } catch {
    // visualRuntime is chrome; never let it decide whether the game runs.
    return 'high';
  }
}

/** Settings for the current tier. Always a valid preset. */
export function settings() {
  return PRESETS[tier()];
}

/**
 * Device pixel ratio for the given CSS size at the current tier.
 *
 * Uses PoCanvasDpr.resolve(), NOT .ceiling(). That distinction was the whole of
 * audit #2: ceiling() is `min(devicePixelRatio, 2)` with no total-pixel cap, so on
 * a maximised 2560×1440 window at DPR 2 PoBrawl allocated a 14.7 Mpx backing store
 * and ran a six-pass chain across it — roughly ten times the fill rate of PoSports
 * and PoRacer, which both call resolve(). Both call sites carried a comment
 * claiming to follow the "shared policy"; they followed the half of it that
 * protects nothing.
 */
export function pixelRatio(cssWidth, cssHeight) {
  const cap = settings().maxDpr;
  try {
    return window.PoCanvasDpr.resolve(cssWidth, cssHeight, { maxDpr: cap });
  } catch {
    return Math.min(window.devicePixelRatio || 1, cap);
  }
}

/**
 * Subscribe to tier changes. Returns an unsubscribe function.
 * visualRuntime dispatches `po-gfx-tier` on window when the measured tier moves.
 */
export function onTierChange(handler) {
  const fn = () => handler(tier(), settings());
  window.addEventListener('po-gfx-tier', fn);
  return () => window.removeEventListener('po-gfx-tier', fn);
}
