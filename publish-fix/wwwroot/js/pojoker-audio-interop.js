/**
 * Web Audio API interop for PoJoker
 * Programmatic generation of drum roll and trombone sound effects
 * FR-017: Audio cues for punchline reveal and AI failure states
 */

// Audio context singleton (created on first user interaction)
let audioContext = null;

/**
 * Get or create the audio context
 * Must be called after user interaction due to browser autoplay policies
 * @returns {AudioContext}
 */
function getAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    // Resume if suspended (happens after page load before user interaction)
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    
    return audioContext;
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
    
    // Connect nodes
    noiseSource.connect(bandpass);
    bandpass.connect(highpass);
    highpass.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    // Play
    noiseSource.start(now);
    noiseSource.stop(now + duration);
    
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
        
        // Connect
        osc.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(ctx.destination);
        
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
        gainNode.connect(ctx.destination);
        
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
    gainNode.connect(ctx.destination);
    
    source.start(now);
    source.stop(now + duration);
    
    return new Promise(resolve => {
        setTimeout(resolve, duration * 1000);
    });
}

// Expose to global scope for Blazor interop
window.poJokerAudio = {
    playDrumRoll,
    playTrombone,
    playFanfare,
    playCymbal,
    
    /**
     * Initialize audio context (call on user interaction)
     */
    init: function() {
        getAudioContext();
    },
    
    /**
     * Check if Web Audio API is supported
     * @returns {boolean}
     */
    isSupported: function() {
        return !!(window.AudioContext || window.webkitAudioContext);
    }
};
