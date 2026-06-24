let audioCtx = null;
let metronomeIntervalId = null;
// Tracks every oscillator scheduled by the metronome so we can stop them
// when the page is disposed (e.g. by the kiosk auto-rotation advancing to
// the next demo). Without this, ~100ms of future-scheduled clicks continue
// to play through the audio thread after clearTimeout cancels the
// scheduler — producing the "ghost metronome" that bleeds into the next
// demo. (Regression: kiosk auto-rotation left metronome audio running.)
let scheduledOscillators = [];
let nextBeatTime = 0;
let beatDuration = 0;
let currentBeatIndex = 0;
let isPlaying = false;
let dotNetReference = null;

function trackScheduledOsc(osc) {
    scheduledOscillators.push(osc);
    osc.onended = () => {
        const i = scheduledOscillators.indexOf(osc);
        if (i >= 0) scheduledOscillators.splice(i, 1);
    };
}

window.poclickAudio = {
    init: function() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    },
    playClick: function(time, frequency = 800, duration = 0.05, volume = 0.4) {
        if (!audioCtx) return;

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(frequency, time);
        osc.frequency.exponentialRampToValueAtTime(120, time + duration);

        gain.gain.setValueAtTime(volume, time);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

        osc.start(time);
        osc.stop(time + duration);
        // Only metronome clicks need cancellation tracking; one-off
        // playClick callers (used in tests/preview) self-clean via onended.
    },
    playPlayerTap: function() {
        this.init();
        if (!audioCtx) return;

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        // snappier high pitched snare click
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1400, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(400, audioCtx.currentTime + 0.03);

        gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.03);

        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.03);
    },
    startMetronome: function(bpm, dotNetHelper) {
        this.init();
        this.stopMetronome();

        isPlaying = true;
        dotNetReference = dotNetHelper;
        currentBeatIndex = 0;
        beatDuration = 60.0 / bpm; // duration in seconds

        // Start scheduling 250ms from now to allow C# state setups
        nextBeatTime = audioCtx.currentTime + 0.25;

        const scheduleAheadTime = 0.1; // lookahead window (100ms)
        const lookaheadInterval = 25.0; // scheduler run rate (25ms)

        function scheduler() {
            if (!isPlaying) return;

            while (nextBeatTime < audioCtx.currentTime + scheduleAheadTime) {
                // Schedule the audio thread click AND register the
                // oscillator so stopMetronome() can silence it. Without
                // this, ~100ms of pre-scheduled clicks survive past
                // clearTimeout and bleed into whatever demo follows.
                const osc = window.poclickAudio._playMetronomeClick(nextBeatTime);
                if (osc) trackScheduledOsc(osc);

                // Calculate the precise performance.now() equivalent for this future beat
                const timeOffset = performance.now() - (audioCtx.currentTime * 1000);
                const beatPerfTimeMs = (nextBeatTime * 1000) + timeOffset;

                // Dispatch event to C#
                dotNetReference.invokeMethodAsync('OnMetronomeBeat', currentBeatIndex, beatPerfTimeMs);

                currentBeatIndex++;
                nextBeatTime += beatDuration;
            }
            metronomeIntervalId = setTimeout(scheduler, lookaheadInterval);
        }

        scheduler();
    },
    stopMetronome: function() {
        isPlaying = false;
        if (metronomeIntervalId) {
            clearTimeout(metronomeIntervalId);
            metronomeIntervalId = null;
        }
        // Cancel every metronome click that was queued on the audio
        // thread. clearTimeout only stops the *next* scheduler tick —
        // any oscillator already scheduled at a future audio-clock time
        // (up to 100ms ahead) would otherwise play through to the end of
        // its envelope (~750ms) and bleed into the next demo. (Bug: ghost
        // metronome audible after kiosk auto-rotation advanced past PoClick.)
        const now = audioCtx ? audioCtx.currentTime : 0;
        for (const osc of scheduledOscillators) {
            try { osc.stop(now); } catch { /* already stopped */ }
        }
        scheduledOscillators = [];
    },
    // Internal: schedule a single metronome click at audio-clock `time`
    // and return the oscillator so callers can register it for cleanup.
    // (Internal helper, not part of the JS-interop surface.)
    _playMetronomeClick: function(time) {
        if (!audioCtx) return null;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(750, time);
        osc.frequency.exponentialRampToValueAtTime(120, time + 0.06);
        gain.gain.setValueAtTime(0.45, time);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
        osc.start(time);
        osc.stop(time + 0.06);
        return osc;
    },
    registerSpaceListener: function(dotNetHelper) {
        // Remove existing to avoid duplicates
        this.unregisterSpaceListener();

        window.poclickAudio.spaceHandler = function(e) {
            if (e.code === 'Space') {
                e.preventDefault();
                // Play tap sound instantly
                window.poclickAudio.playPlayerTap();
                // Dispatch high-resolution tap time
                dotNetHelper.invokeMethodAsync('OnSpacePressed', performance.now());
            }
        };

        window.addEventListener('keydown', window.poclickAudio.spaceHandler);
    },
    unregisterSpaceListener: function() {
        if (window.poclickAudio.spaceHandler) {
            window.removeEventListener('keydown', window.poclickAudio.spaceHandler);
            window.poclickAudio.spaceHandler = null;
        }
    },
    // UX-8: get high-res tap timestamp for click/touch events
    getTapTime: function() {
        return performance.now();
    },
    // UX-9: preview metronome (no C# callback, just audio)
    startPreview: function(bpm) {
        this.init();
        this.stopPreview();
        window.poclickAudio._previewPlaying = true;
        let dur = 60.0 / bpm;
        let next = audioCtx.currentTime + 0.1;
        function schedulePreview() {
            if (!window.poclickAudio._previewPlaying) return;
            while (next < audioCtx.currentTime + 0.15) {
                // Use the trackable internal helper so stopPreview can
                // cancel these too — kiosk auto-rotation can otherwise
                // leave preview clicks ringing out after navigation.
                const osc = window.poclickAudio._playMetronomeClick(next);
                if (osc) {
                    osc.frequency.setValueAtTime(600, next);
                    osc.frequency.exponentialRampToValueAtTime(120, next + 0.055);
                    osc.stop(next + 0.055);
                    trackScheduledOsc(osc);
                }
                next += dur;
            }
            window.poclickAudio._previewTimer = setTimeout(schedulePreview, 25);
        }
        schedulePreview();
    },
    stopPreview: function() {
        window.poclickAudio._previewPlaying = false;
        if (window.poclickAudio._previewTimer) {
            clearTimeout(window.poclickAudio._previewTimer);
            window.poclickAudio._previewTimer = null;
        }
    }
};
