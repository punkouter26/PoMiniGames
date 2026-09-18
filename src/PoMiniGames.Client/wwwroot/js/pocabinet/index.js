// pocabinet/index.js
//
// Facade module. The trim-analyzer-friendly scene.js / cockpit.js / cars.js /
// dialogue.js use named ES module exports — Blazor's IJSRuntime can only invoke
// methods on `window.*` globals. We re-export the relevant functions under a
// single `window.PoCabinet` namespace so the page does the same `JS.InvokeAsync`
// dance as the other engines, and the loaded modules stay directly importable
// for unit tests / future code-splitting.
//
// Contract surface (called from src/PoMiniGames.Client/Games/PoCabinet/...):
//   PoCabinet.mount(canvas, atmosphere, centerline) -> handle
//   PoCabinet.unmount(handle)
//   PoCabinet.mountCockpit(sceneHandle)
//   PoCabinet.unmountCockpit(handle)
//   PoCabinet.mountCar(parent, opts) -> carHandle
//   PoCabinet.updateCar(handle, snap)
//   PoCabinet.unmountCar(handle)
//   PoCabinet.mountDialogue(parent, officialId) -> dialogueHandle
//   PoCabinet.showDialogue(handle, text, durationMs)
//   PoCabinet.hideDialogue(handle)
//   PoCabinet.unmountDialogue(handle)
//   PoCabinet.officialName(officialId)
//
//   PoCabinet.pauseSoloRace() / resumeSoloRace()          — solo pause (Esc)
//
//   PoCabinet.loadSettings() -> settings                   — persisted prefs
//   PoCabinet.saveSettings(patch) -> settings              — merge + persist
//   PoCabinet.applySettings(sceneHandle, settings)         — FOV + pixel ratio + audio
//   PoCabinet.getRecords(trackId) -> { bestLap, sectors }
//   PoCabinet.recordTrackResult(trackId, bestLap, sectors) -> { isPb, previousBest }
//
//   PoCabinet.initAudio()                                  — user-gesture gate
//   PoCabinet.setAudioSuspended(bool)                      — pause-menu duck
//   PoCabinet.updateEngineAudio(speedKmh)                  — per snapshot
//   PoCabinet.setSquealAudio(bool)                         — hard steering at speed
//   PoCabinet.countdownBeep(isFinal) / blip() / lapChime() / fanfare(podium)
//
//   PoCabinet.mountMinimap(canvas, centerline, opts) -> minimapHandle
//   PoCabinet.updateMinimap(handle, cars)
//   PoCabinet.unmountMinimap(handle)
//
//   PoCabinet.mountEnvironment(sceneHandle) -> envHandle   — night + rain + DC weather
//   PoCabinet.unmountEnvironment(handle)

import { mount as sceneMount, unmount as sceneUnmount } from './scene.js';
import { mountCockpit, unmountCockpit } from './cockpit.js';
import { mountCar, unmountCar } from './cars.js';
import { mount as mountDialogue, unmount as unmountDialogue, show, hide, officialName } from './dialogue.js';
import { startSoloRace, stopSoloRace, pauseSoloRace, resumeSoloRace } from './practice.js';
import { loadSettings, saveSettings, getRecords, recordTrackResult } from './settings.js';
import * as audio from './audio.js';
import { mountMinimap, unmountMinimap } from './minimap.js';
import { mountEnvironment, unmountEnvironment } from './environment.js';

const api = {
    mount: sceneMount,
    unmount: sceneUnmount,
    mountCockpit,
    unmountCockpit,
    mountCar,
    unmountCar,
    updateCar(handle, snap) { handle.update(snap); },
    updatePlayerView(sceneHandle, p) { if (sceneHandle && !sceneHandle.disposed) sceneHandle.updatePlayerView(p); },
    mountDialogue,
    showDialogue: (handle, text, durationMs) => show(handle, text, durationMs),
    hideDialogue: hide,
    unmountDialogue,
    officialName,
    startSoloRace,
    stopSoloRace,
    pauseSoloRace,
    resumeSoloRace,

    loadSettings,
    saveSettings,
    getRecords,
    recordTrackResult,

    initAudio: audio.init,
    setAudioSuspended: audio.setSuspended,
    updateEngineAudio: audio.updateEngine,
    setSquealAudio: audio.setSqueal,
    countdownBeep: audio.countdownBeep,
    blip: audio.blip,
    lapChime: audio.lapChime,
    fanfare: audio.fanfare,

    mountMinimap,
    updateMinimap: (handle, cars) => handle.update(cars),
    unmountMinimap,

    mountEnvironment,
    unmountEnvironment,

    /** Push persisted prefs into the live scene + audio graph. */
    applySettings(sceneHandle, settings) {
        if (sceneHandle && !sceneHandle.disposed) sceneHandle.applyView(settings);
        audio.setVolume(settings?.masterVolume);
        audio.setMuted(settings?.muted);
    },

    /**
     * Unlock the AudioContext on the first user gesture. Covers entry paths
     * that never click "Start race" (auto-starting demo, guests joining a
     * multiplayer race from a link).
     */
    armAudioOnGesture() {
        if (armAudioInstalled) return;
        armAudioInstalled = true;
        const unlock = () => {
            audio.init();
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
        };
        window.addEventListener('pointerdown', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });
    },

    /**
     * Render a 1200×630 shareable result card and hand it to the Web Share
     * API (when file sharing is available) or fall back to a download.
     * Returns 'shared' | 'downloaded' | 'unavailable' for the page's toast.
     */
    async shareResult(payload) {
        try {
            const p = payload && typeof payload === 'object' ? payload : {};
            const c = document.createElement('canvas');
            c.width = 1200;
            c.height = 630;
            const g = c.getContext('2d');
            if (!g) return 'unavailable';

            const accent = typeof p.accent === 'string' ? p.accent : '#c6a35a';
            g.fillStyle = '#101a2e';
            g.fillRect(0, 0, c.width, c.height);
            g.fillStyle = accent;
            g.fillRect(0, 0, c.width, 14);
            g.fillRect(0, c.height - 14, c.width, 14);

            g.fillStyle = '#ffffff';
            g.font = '700 64px system-ui, sans-serif';
            g.fillText('🏛️ Cabinet', 70, 150);
            g.fillStyle = accent;
            g.font = '600 40px system-ui, sans-serif';
            g.fillText(String(p.trackName || 'Race'), 70, 215);

            g.fillStyle = '#ffffff';
            g.font = '800 190px system-ui, sans-serif';
            const posText = `P${Number(p.position) || 1}`;
            g.fillText(posText, 70, 430);
            g.font = '500 44px system-ui, sans-serif';
            g.fillStyle = 'rgba(255,255,255,0.75)';
            g.fillText(`of ${Number(p.totalCars) || 1} cars  ·  ${String(p.playerName || 'Player')}`, 70, 490);

            const lap = Number(p.bestLapSeconds);
            g.fillStyle = '#ffffff';
            g.font = '700 56px system-ui, sans-serif';
            const mins = lap > 0 ? Math.floor(lap / 60) : 0;
            const rest = lap > 0 ? (lap - mins * 60).toFixed(1) : '0.0';
            g.fillText(`Best lap  ${mins}:${rest}`, 640, 430);
            if (p.isPb) {
                g.fillStyle = '#2ecc71';
                g.font = '800 48px system-ui, sans-serif';
                g.fillText('★ NEW PERSONAL BEST', 640, 490);
            }
            g.fillStyle = 'rgba(255,255,255,0.55)';
            g.font = '400 30px system-ui, sans-serif';
            g.fillText('PoMiniGames · Cabinet', 70, 575);

            const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
            if (!blob) return 'unavailable';
            const file = new File([blob], 'pocabinet-result.png', { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: 'Cabinet — race result' });
                return 'shared';
            }
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'pocabinet-result.png';
            a.click();
            window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            return 'downloaded';
        } catch (e) {
            // A user-cancelled share sheet (AbortError) is not a failure.
            if (e && e.name === 'AbortError') return 'shared';
            return 'unavailable';
        }
    },
};

let armAudioInstalled = false;

window.PoCabinet = api;
