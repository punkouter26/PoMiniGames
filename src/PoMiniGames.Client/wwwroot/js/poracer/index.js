import './renderer.js';
import { install, uninstall } from './compositor.js';
import { startInput, stopInput, setInputEnabled, getSize } from './input.js';

window.PoRacer = {
    start(canvasId, reference) {
        uninstall();
        window.PoRacerRender.dispose();
        startInput(canvasId, reference);
        install();
    },
    stop() {
        stopInput();
        uninstall();
        window.PoRacerRender.dispose();
    },
    setInputEnabled,
    effectsReduced() {
        // Always reduced 2026-09-17 (user request): the toggle UI is gone and
        // the calm path is the only path — no shake, no weather, no speed
        // lines, no bloom, no GL post pass (tierTaps() returns 0). Keep the
        // function: renderer.js and compositor.js gate their effects on it.
        return true;
    },
    getSize
};
