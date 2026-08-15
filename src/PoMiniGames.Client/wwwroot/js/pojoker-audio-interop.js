/**
 * Web Audio API interop for PoJoker
 * Programmatic generation of drum roll and trombone sound effects
 * FR-017: Audio cues for punchline reveal and AI failure states
 */

// Audio context singleton (created on first user interaction)
let audioContext = null;

// Live AudioBufferSourceNodes (drum roll, cymbal) — these can be cancelled.
// Oscillators (fanfare, trombone) auto-stop on their envelope, but buffer
// sources would otherwise run to completion. A Set keeps both stoppable and
// lets stopAll() tear the current cue down on demand when the orchestrator
// advances to the next state or the player hits Stop — without this, a drum
// roll started 1.9s before Stop would ring over the idle screen.
const liveSources = new Set();

/**
 * Get or create the audio context
 * Must be called after user interaction due to browser autoplay policies
 * @returns {AudioContext}
 */
function getAudioContext() {
    if (!audioContext) {
        // Shared context (js/audioBus.js) — see note in posurvive/audioEngine.js.
        audioContext = (window.PoAudioBus && window.PoAudioBus.contextSync())
            || new (window.AudioContext || window.webkitAudioContext)();
    }

    // Resume if suspended (happens after page load before user interaction)
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    return audioContext;
}

/**
 * Connect a generated node graph to the shared audio bus instead of the raw
 * `ctx.destination`. The bus carries per-category gain and the master mute/volume
 * from the player's settings, so a muted player hears silence whether the cue
 * is the Jester's fanfare, the narrator's drum roll, or anything else.
 * @param {AudioNode} tail the last node in the source graph
 * @returns {AudioNode} the tail node (for chaining) or `destination` fallback
 */
function connectToBus(tail) {
    const bus = window.PoAudioBus && window.PoAudioBus.busSync('sfx');
    if (bus) {
        tail.connect(bus);
    } else {
        tail.connect(audioContext.destination);
    }
    return tail;
}

/**
 * Register a BufferSourceNode so stopAll() can interrupt it. The nodes are
 * one-shot — once they finish naturally they're removed from the Set so the
 * Set doesn't grow across a full 10-joke show.
 * @param {AudioBufferSourceNode} node
 */
function trackSource(node) {
    liveSources.add(node);
    node.onended = () => liveSources.delete(node);
}

/**
 * Generate a drum roll sound using noise and filtering
 * Creates a realistic snare drum roll effect
 * @param {number} duration - Duration in seconds (default 2.0)
 * @param {number} volume - Volume 0-1 (default 0.5)
 * @returns {Promise<void>}
 */
async function playDrumRoll(duration = 2.0, volume = 0.5) {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    
    // Create noise buffer for drum texture
    const bufferSize = ctx.sampleRate * duration;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    
    // Fill with shaped noise (drum roll pattern)
    const rollFrequency = 20; // Rolls per second
    for (let i = 0; i < bufferSize; i++) {
        const t = i / ctx.sampleRate;
        // Create roll envelope with tremolo
        const rollEnvelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * rollFrequency * t);
        // Add some randomness for natural feel
        const noise = (Math.random() * 2 - 1) * rollEnvelope;
        output[i] = noise;
    }
    
    // Noise source
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    
    // Bandpass filter for snare-like sound
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 1000;
    bandpass.Q.value = 0.5;
    
    // Highpass to remove muddiness
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 200;
    
    // Gain envelope - crescendo to build tension
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(volume * 0.3, now);
    gainNode.gain.linearRampToValueAtTime(volume, now + duration * 0.8);
    gainNode.gain.linearRampToValueAtTime(volume * 1.2, now + duration);
    
    // Connect nodes — through the shared sfx bus so master mute/volume apply.
    noiseSource.connect(bandpass);
    bandpass.connect(highpass);
    highpass.connect(gainNode);
    connectToBus(gainNode);

    // Play
    noiseSource.start(now);
    noiseSource.stop(now + duration);
    trackSource(noiseSource);
    
    return new Promise(resolve => {
        setTimeout(resolve, duration * 1000);
    });
}

/**
 * Generate a sad trombone (wah-wah) sound
 * Classic comedy failure sound effect
 * @param {number} volume - Volume 0-1 (default 0.6)
 * @returns {Promise<void>}
 */
async function playTrombone(volume = 0.6) {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    
    // Sad trombone: descending notes with vibrato
    // Notes: Bb4 → F4 → D4 → Bb3 (descending)
    const notes = [466.16, 349.23, 293.66, 233.08]; // Frequencies in Hz
    const noteDuration = 0.4;
    const totalDuration = notes.length * noteDuration;
    
    // Create oscillator for each note
    notes.forEach((freq, index) => {
        const startTime = now + index * noteDuration;
        
        // Main oscillator (sawtooth for brass-like tone)
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, startTime);
        
        // Add vibrato
        const vibrato = ctx.createOscillator();
        vibrato.frequency.value = 5; // 5 Hz vibrato
        const vibratoGain = ctx.createGain();
        vibratoGain.gain.value = freq * 0.02; // 2% pitch variation
        vibrato.connect(vibratoGain);
        vibratoGain.connect(osc.frequency);
        
        // Add slight pitch bend down for wah effect
        osc.frequency.linearRampToValueAtTime(freq * 0.95, startTime + noteDuration);
        
        // Lowpass filter for muted trombone sound
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(2000, startTime);
        filter.frequency.linearRampToValueAtTime(800, startTime + noteDuration);
        
        // Gain envelope
        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(volume, startTime + 0.05);
        gainNode.gain.setValueAtTime(volume, startTime + noteDuration * 0.7);
        gainNode.gain.linearRampToValueAtTime(0, startTime + noteDuration);
        
        // Connect — through the shared sfx bus so master mute/volume apply.
        osc.connect(filter);
        filter.connect(gainNode);
        connectToBus(gainNode);

        // Play
        osc.start(startTime);
        osc.stop(startTime + noteDuration);
        vibrato.start(startTime);
        vibrato.stop(startTime + noteDuration);
    });

    return new Promise(resolve => {
        setTimeout(resolve, totalDuration * 1000);
    });
}

/**
 * Play a triumphant fanfare sound
 * For when the AI correctly guesses the punchline
 * @param {number} volume - Volume 0-1 (default 0.5)
 * @returns {Promise<void>}
 */
async function playFanfare(volume = 0.5) {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    
    // Triumphant ascending notes: C5 → E5 → G5 → C6
    const notes = [523.25, 659.25, 783.99, 1046.50];
    const noteDuration = 0.2;
    const totalDuration = notes.length * noteDuration + 0.3;
    
    notes.forEach((freq, index) => {
        const startTime = now + index * noteDuration;
        
        // Brass-like oscillator
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;
        
        // Bright filter for fanfare
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 3000;
        
        // Envelope
        const gainNode = ctx.createGain();
        const attack = 0.02;
        const sustain = noteDuration - 0.05;
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(volume, startTime + attack);
        gainNode.gain.setValueAtTime(volume * 0.8, startTime + sustain);
        gainNode.gain.linearRampToValueAtTime(0, startTime + noteDuration);
        
        osc.connect(filter);
        filter.connect(gainNode);
        connectToBus(gainNode);

        osc.start(startTime);
        osc.stop(startTime + noteDuration + 0.1);
    });
    
    return new Promise(resolve => {
        setTimeout(resolve, totalDuration * 1000);
    });
}

/**
 * Play a cymbal crash
 * @param {number} volume - Volume 0-1 (default 0.4)
 * @returns {Promise<void>}
 */
async function playCymbal(volume = 0.4) {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const duration = 1.5;
    
    // Create noise for cymbal
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    
    // Highpass for cymbal brightness
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 5000;
    
    // Decay envelope
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(volume, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);
    
    source.connect(highpass);
    highpass.connect(gainNode);
    connectToBus(gainNode);

    source.start(now);
    source.stop(now + duration);
    trackSource(source);
    
    return new Promise(resolve => {
        setTimeout(resolve, duration * 1000);
    });
}

/**
 * Play procedural audience laughter
 * @param {number} volume - Volume 0-1 (default 0.45)
 */
async function playLaughter(volume = 0.45) {
    if (window.PoCue) {
        window.PoCue.fire('pojoker', 'laugh', { gain: volume });
    }
}

/**
 * Play a classic comedic rimshot (snare hit + punch + cymbal tap)
 * @param {number} volume - Volume 0-1 (default 0.5)
 */
async function playRimshot(volume = 0.5) {
    if (window.PoCue) {
        window.PoCue.fire('pojoker', 'rimshot', { gain: volume });
    }
}

// Expose to global scope for Blazor interop
window.poJokerAudio = {
    playDrumRoll,
    playTrombone,
    playFanfare,
    playCymbal,
    playLaughter,
    playRimshot,

    /**
     * Initialize audio context (call on user interaction)
     */
    init: function() {
        getAudioContext();
    },

    /**
     * Stop every currently-playing cue. Safe to call repeatedly — the Set is
     * the source of truth and `stop()` on an already-ended source is a no-op.
     * Oscillator-based cues (fanfare, trombone) finish their envelope on their
     * own and don't need this; buffer-based cues (drum roll, cymbal) would
     * otherwise ring out across state transitions or after Stop.
     */
    stopAll: function() {
        for (const node of liveSources) {
            try { node.stop(); } catch { /* already ended */ }
            liveSources.delete(node);
        }
    },

    /**
     * How many buffer-source cues are currently live (drum roll / cymbal).
     * Exposed for browser-side tests verifying the audio boundary; not used
     * by production code.
     */
    _liveCount: function() {
        return liveSources.size;
    },

    /**
     * Check if Web Audio API is supported
     * @returns {boolean}
     */
    isSupported: function() {
        return !!(window.AudioContext || window.webkitAudioContext);
    }
};
