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
    getSize
};
