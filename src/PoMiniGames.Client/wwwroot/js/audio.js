let audioCtx = null;
let metronomeIntervalId = null;
let nextBeatTime = 0;
let beatDuration = 0;
let currentBeatIndex = 0;
let isPlaying = false;
let dotNetReference = null;

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
                // Schedule the audio thread click
                window.poclickAudio.playClick(nextBeatTime, 750, 0.06, 0.45);
                
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
                window.poclickAudio.playClick(next, 600, 0.055, 0.25);
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
