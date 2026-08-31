// fxBootstrap.js — the always-on GFX/Sound bootstrap (§GFX-12…21).
//
// Loaded as a classic module script from index.html BEFORE Blazor boots, so
// the quality tier is decided before the first game asks for it, the palette
// follows the route from the first paint, and the music director's lazy
// AudioContext gesture kick is armed immediately.
//
// The heavier systems (glass captures, weather, WebGPU particles, prop
// registry, material audio) are lazy-imported from the games that use them —
// the catalog must never pay for Voxel Strike's prop library.

(function () {
    'use strict';

    function load(src) {
        return new Promise(function (res) {
            const s = document.createElement('script');
            s.src = src;
            s.onload = res; s.onerror = res;   // a failed module must not stall the rest
            document.head.appendChild(s);
        });
    }

    // Order matters: quality first (everyone reads it), palette second (writes
    // the vars readers consume), then the audio director.
    load('js/qualityTiers.js')
        .then(function () { return load('js/paletteBus.js'); })
        .then(function () { return load('js/impactFx.js'); })
        .then(function () { return load('js/spatialAudio.js'); })
        .then(function () { return load('js/materialAudio.js'); })
        .then(function () { return load('js/musicDirector.js'); })
        .then(function () {
            // WebGPU backend probes in the background; gpuFx consults it lazily
            // so the catalog pays zero for the probe.
            if (window.PoQuality.tier() !== 'low') {
                load('js/gpuFxWebGPU.js').then(function () {
                    window.PoGpuWebGPU && window.PoGpuWebGPU.probe();
                });
            }
        });
})();
