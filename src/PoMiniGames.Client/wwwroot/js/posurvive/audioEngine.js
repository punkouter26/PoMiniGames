// audioEngine.js — Programmatic 8-bit audio via Web Audio API (T072)
// Enhanced with Soundtrack Composer: layered oscillators, ambient drones,
// heartbeat intensity, victory/defeat fanfares, and gain-node per-layer volume control.
// No audio files; all sounds synthesised from oscillators.
// Constitution Principle: zero audio file downloads.

window.audioEngine = (() => {
    let _ctx = null;
    let _masterGain = null;

    // ─── Soundtrack Composer: layered gain nodes ───────────────────────────
    let _ambientGain = null;
    let _combatGain  = null;
    let _fanfareGain = null;
    let _ambientOscillators = [];
    let _heartbeatOscillator = null;
    let _heartbeatLfo = null;
    let _isAmbientRunning = false;
    let _isHeartbeatRunning = false;
    let _currentIntensity = 0; // 0..1 for dynamic scaling
    let _currentTheme = 'tense'; // 'tense' | 'calm' | 'epic'

    // ─── Preset theme parameters ───────────────────────────────────────────
    const THEMES = {
        tense: {
            ambientBaseFreq: 55,      // A1 drone
            ambientOscType: 'sawtooth',
            ambientHarmonics: [1, 1.5, 2.01], // slightly detuned
            heartbeatBaseFreq: 40,
            heartbeatOscType: 'sine',
            fanfareScale: 'minor',
        },
        calm: {
            ambientBaseFreq: 65.41,   // C2
            ambientOscType: 'sine',
            ambientHarmonics: [1, 2, 3], // clean octaves
            heartbeatBaseFreq: 55,
            heartbeatOscType: 'sine',
            fanfareScale: 'major',
        },
        epic: {
            ambientBaseFreq: 41.2,    // E1
            ambientOscType: 'triangle',
            ambientHarmonics: [1, 1.25, 1.5, 2.0],
            heartbeatBaseFreq: 30,
            heartbeatOscType: 'square',
            fanfareScale: 'phrygian',
        },
    };

    function getContext() {
        if (!_ctx) {
            try {
        // 2026-07-29: adopt the app's single shared AudioContext (js/audioBus.js).
        // This module used to construct its own; five modules doing that meant no
        // global mix and no way to duck one under another. Falls back to a private
        // context only if audioBus is somehow unavailable.
                _ctx = (window.PoAudioBus && window.PoAudioBus.contextSync())
                    || new (window.AudioContext || window.webkitAudioContext)();
                _masterGain = _ctx.createGain();
                _masterGain.gain.setValueAtTime(0.5, _ctx.currentTime);
                _masterGain.connect(
                    (window.PoAudioBus && window.PoAudioBus.busSync('sfx')) || _ctx.destination);

                _ambientGain = _ctx.createGain();
                _ambientGain.gain.setValueAtTime(0.3, _ctx.currentTime);
                _ambientGain.connect(_masterGain);

                _combatGain = _ctx.createGain();
                _combatGain.gain.setValueAtTime(0.4, _ctx.currentTime);
                _combatGain.connect(_masterGain);

                _fanfareGain = _ctx.createGain();
                _fanfareGain.gain.setValueAtTime(0.5, _ctx.currentTime);
                _fanfareGain.connect(_masterGain);
            } catch {
                return null;
            }
        }
        return _ctx;
    }

    /**
     * Play a sound effect.
     * @param {string} eventType - "forage" | "combat" | "death"
     */
    function play(eventType) {
        const ctx = getContext();
        if (!ctx) return;

        // Resume if suspended by autoplay policy
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }

        switch (eventType) {
            case 'forage': playForage(ctx); break;
            case 'combat': playCombat(ctx); break;
            case 'death':  playDeath(ctx);  break;
        }
    }

    // High-frequency square wave chirp (forage / resource pickup)
    function playForage(ctx) {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type      = 'square';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.08);

        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

        osc.connect(gain);
        gain.connect(_masterGain || ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
    }

    // Sawtooth pulse (combat / attack)
    function playCombat(ctx) {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.12);

        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);

        osc.connect(gain);
        gain.connect(_masterGain || ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.18);
    }

    // Dissonant chord (death / elimination)
    function playDeath(ctx) {
        const freqs = [110, 155.6, 207.7]; // A2, Eb3, Ab3 — dissonant chord
        freqs.forEach(freq => {
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, ctx.currentTime);

            gain.gain.setValueAtTime(0.07, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);

            osc.connect(gain);
            gain.connect(_masterGain || ctx.destination);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.6);
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SOUNDTRACK COMPOSER: Ambient Tension Layer (oscillating drone)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Start the ambient tension drone.
     * Creates layered oscillators with slight detuning for a rich, evolving drone.
     */
    function startAmbient() {
        const ctx = getContext();
        if (!ctx || _isAmbientRunning) return;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});

        const theme = THEMES[_currentTheme] || THEMES['tense'];
        stopAmbientInternal();

        _ambientOscillators = [];
        _isAmbientRunning = true;

        theme.ambientHarmonics.forEach((harmonic, i) => {
            const osc  = ctx.createOscillator();
            const filt = ctx.createBiquadFilter();
            const gain = ctx.createGain();

            osc.type = theme.ambientOscType;
            const baseFreq = theme.ambientBaseFreq * harmonic;
            // Slight detune per oscillator for richness
            const detune = (i - (theme.ambientHarmonics.length - 1) / 2) * 5;
            osc.frequency.setValueAtTime(baseFreq, ctx.currentTime);
            osc.detune.setValueAtTime(detune, ctx.currentTime);

            // Low-pass filter to keep it atmospheric
            filt.type = 'lowpass';
            filt.frequency.setValueAtTime(400 + i * 100, ctx.currentTime);
            filt.Q.setValueAtTime(0.5, ctx.currentTime);

            // Individual oscillator gain (split evenly)
            gain.gain.setValueAtTime(1.0 / theme.ambientHarmonics.length, ctx.currentTime);

            // Slow LFO on filter cutoff for evolving texture
            const lfo = ctx.createOscillator();
            const lfoGain = ctx.createGain();
            lfo.type = 'sine';
            lfo.frequency.setValueAtTime(0.1 + i * 0.03, ctx.currentTime); // very slow
            lfoGain.gain.setValueAtTime(80, ctx.currentTime);
            lfo.connect(lfoGain);
            lfoGain.connect(filt.frequency);
            lfo.start(ctx.currentTime);
            lfo._stopRef = lfo;

            osc.connect(filt);
            filt.connect(gain);
            gain.connect(_ambientGain || ctx.destination);
            osc.start(ctx.currentTime);

            _ambientOscillators.push({ osc, filt, gain, lfo });
        });
    }

    function stopAmbientInternal() {
        _ambientOscillators.forEach(({ osc, lfo }) => {
            try { osc.stop(); } catch {}
            try { lfo.stop(); } catch {}
        });
        _ambientOscillators = [];
        _isAmbientRunning = false;
    }

    /** Stop the ambient drone. */
    function stopAmbient() {
        stopAmbientInternal();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SOUNDTRACK COMPOSER: Heartbeat Intensity Layer (combat proximity)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Start the heartbeat pulse oscillator.
     * Intensity (0..1) controls pulse speed and depth.
     * @param {number} intensity - 0 (calm) to 1 (max combat proximity)
     */
    function startHeartbeat(intensity) {
        const ctx = getContext();
        if (!ctx || _isHeartbeatRunning) return;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});

        const theme = THEMES[_currentTheme] || THEMES['tense'];
        stopHeartbeatInternal();

        _currentIntensity = Math.max(0, Math.min(1, intensity || 0));
        _isHeartbeatRunning = true;

        // Main heartbeat oscillator (low thump)
        _heartbeatOscillator = ctx.createOscillator();
        const heartbeatGain = ctx.createGain();

        _heartbeatOscillator.type = theme.heartbeatOscType;
        _heartbeatOscillator.frequency.setValueAtTime(theme.heartbeatBaseFreq, ctx.currentTime);

        // LFO modulates gain to create the "thump-thump" pulse
        _heartbeatLfo = ctx.createOscillator();
        const lfoDepth = ctx.createGain();

        // Heartbeat rate: 60 BPM at intensity=0, up to 180 BPM at intensity=1
        const bpm = 60 + _currentIntensity * 120;
        const hz = bpm / 60; // beats per second
        _heartbeatLfo.type = 'sine';
        _heartbeatLfo.frequency.setValueAtTime(hz, ctx.currentTime);

        // LFO depth: subtle at low intensity, pronounced at high
        lfoDepth.gain.setValueAtTime(0.3 + _currentIntensity * 0.5, ctx.currentTime);

        // Base gain scaled by intensity
        heartbeatGain.gain.setValueAtTime(0.1 + _currentIntensity * 0.6, ctx.currentTime);

        _heartbeatLfo.connect(lfoDepth);
        lfoDepth.connect(heartbeatGain.gain);
        _heartbeatOscillator.connect(heartbeatGain);
        heartbeatGain.connect(_combatGain || ctx.destination);
        _heartbeatOscillator.start(ctx.currentTime);
        _heartbeatLfo.start(ctx.currentTime);
    }

    function stopHeartbeatInternal() {
        if (_heartbeatOscillator) {
            try { _heartbeatOscillator.stop(); } catch {}
            _heartbeatOscillator = null;
        }
        if (_heartbeatLfo) {
            try { _heartbeatLfo.stop(); } catch {}
            _heartbeatLfo = null;
        }
        _isHeartbeatRunning = false;
    }

    /** Stop the heartbeat pulse. */
    function stopHeartbeat() {
        stopHeartbeatInternal();
    }

    /**
     * Update heartbeat intensity without restarting.
     * @param {number} intensity - 0..1
     */
    function setHeartbeatIntensity(intensity) {
        _currentIntensity = Math.max(0, Math.min(1, intensity || 0));
        if (_isHeartbeatRunning) {
            // Restart to apply new intensity
            stopHeartbeatInternal();
            startHeartbeat(_currentIntensity);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SOUNDTRACK COMPOSER: Victory / Defeat Fanfares
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Play a victory fanfare — ascending triumphant arpeggio.
     */
    function playVictoryFanfare() {
        const ctx = getContext();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});

        const theme = THEMES[_currentTheme] || THEMES['tense'];
        const now = ctx.currentTime;

        // Major triad arpeggio: C4, E4, G4, C5
        const notes = [261.63, 329.63, 392.00, 523.25];
        const noteDuration = 0.2;
        const totalDuration = notes.length * noteDuration + 0.4;

        notes.forEach((freq, i) => {
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, now + i * noteDuration);

            const startTime = now + i * noteDuration;
            gain.gain.setValueAtTime(0, startTime);
            gain.gain.linearRampToValueAtTime(0.15, startTime + 0.03);
            gain.gain.setValueAtTime(0.15, startTime + noteDuration - 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, startTime + noteDuration);

            osc.connect(gain);
            gain.connect(_fanfareGain || ctx.destination);
            osc.start(startTime);
            osc.stop(startTime + noteDuration);
        });

        // Sustain chord at the end
        [261.63, 329.63, 392.00, 523.25].forEach(freq => {
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, now + notes.length * noteDuration);
            const start = now + notes.length * noteDuration;
            gain.gain.setValueAtTime(0.12, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 1.0);
            osc.connect(gain);
            gain.connect(_fanfareGain || ctx.destination);
            osc.start(start);
            osc.stop(start + 1.0);
        });
    }

    /**
     * Play a defeat fanfare — descending mournful tones.
     */
    function playDefeatFanfare() {
        const ctx = getContext();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});

        const now = ctx.currentTime;

        // Descending minor: E4, C4, A3, E3
        const notes = [329.63, 261.63, 220.00, 164.81];
        const noteDuration = 0.35;

        notes.forEach((freq, i) => {
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, now + i * noteDuration);

            const startTime = now + i * noteDuration;
            gain.gain.setValueAtTime(0, startTime);
            gain.gain.linearRampToValueAtTime(0.1, startTime + 0.05);
            gain.gain.setValueAtTime(0.1, startTime + noteDuration - 0.1);
            gain.gain.exponentialRampToValueAtTime(0.001, startTime + noteDuration + 0.1);

            osc.connect(gain);
            gain.connect(_fanfareGain || ctx.destination);
            osc.start(startTime);
            osc.stop(startTime + noteDuration + 0.15);
        });
    }

    /**
     * Set dynamic intensity based on simulation state.
     * Scales heartbeat and ambient gain based on combat activity.
     * @param {number} intensity - 0 (calm) to 1 (intense combat)
     */
    function setDynamicIntensity(intensity) {
        const ctx = getContext();
        if (!ctx) return;
        const i = Math.max(0, Math.min(1, intensity));

        _currentIntensity = i;

        // Adjust ambient gain: louder when calm, quieter during combat
        if (_ambientGain) {
            const ambientTarget = 0.3 - i * 0.15;
            _ambientGain.gain.setValueAtTime(ambientTarget, ctx.currentTime);
        }

        // Adjust combat gain: louder during combat
        if (_combatGain) {
            const combatTarget = 0.2 + i * 0.5;
            _combatGain.gain.setValueAtTime(combatTarget, ctx.currentTime);
        }

        // Update heartbeat rate
        if (_isHeartbeatRunning) {
            setHeartbeatIntensity(i);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════

    // Exactly the surface AudioService calls. The mixer/theme API (setLayerVolume,
    // get/setTheme, getAvailableThemes, is*Running, setHeartbeatIntensity, unlockAudio)
    // went out with the SoundtrackControl panel; setHeartbeatIntensity stays as an
    // internal helper because setDynamicIntensity still drives it.
    return {
        play,

        // Ambient
        startAmbient,
        stopAmbient,

        // Heartbeat
        startHeartbeat,
        stopHeartbeat,

        // Fanfares
        playVictoryFanfare,
        playDefeatFanfare,

        // Dynamic intensity (scaled per turn from combat activity)
        setDynamicIntensity,
    };
})();

// Helper: trigger browser download of a text file (used by SessionLogService)
window.downloadTextFile = function (filename, content) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};