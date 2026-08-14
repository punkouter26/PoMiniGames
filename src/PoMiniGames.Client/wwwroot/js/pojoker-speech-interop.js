/**
 * Web Speech API interop for PoJoker
 * Provides text-to-speech functionality with British male voice preference
 * FR-016: Voiced jester character for narration
 */

// Voice cache to avoid repeated lookups
let cachedVoice = null;
let voicesLoaded = false;

// Sequential utterance queue.
//
// Chromium has a well-known race (chromium bug 1133733 and friends) where
// `speechSynthesis.cancel()` followed by `speechSynthesis.speak()` drops the
// first few words of the new utterance — the call resolves `onend` almost
// immediately because Chrome treats the queue as already-empty. The previous
// implementation called cancel() at the start of every SpeakAsync, so whenever
// the orchestrator queued a second utterance within ~1s of the previous one
// (the AI-guess speech followed by the punchline, the punchline followed by
// the next show's setup, …) the new speech got cut off mid-sentence.
//
// The fix is to never cancel-and-replace; treat the synthesizer as a single
// sequential resource. Every SpeakAsync call queues an utterance; the queue
// advances when the previous utterance's `onend` fires. A `stop()` call drops
// the pending utterances AND sends `cancel()` to flush the live one.
const speechQueue = [];
let speechRunning = false;

function drainSpeechQueue() {
    if (speechRunning) return;
    const next = speechQueue.shift();
    if (!next) return;
    speechRunning = true;
    try {
        window.speechSynthesis.speak(next.utterance);
    } catch (ex) {
        // speak() can throw if the API is in a bad state; the queued utterance
        // never gets an `onend` so the caller would hang. Resolve and advance.
        speechRunning = false;
        next.resolve();
        drainSpeechQueue();
    }
}

/**
 * Get the preferred British male voice or best fallback
 * @returns {SpeechSynthesisVoice|null}
 */
function getPreferredVoice() {
    if (cachedVoice) return cachedVoice;
    
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return null;
    
    // Priority order for voice selection
    // 1. British English male voices
    // 2. Any British English voice
    // 3. Any English male voice
    // 4. Any English voice
    // 5. First available voice
    
    const britishMale = voices.find(v => 
        v.lang.startsWith('en-GB') && v.name.toLowerCase().includes('male'));
    if (britishMale) {
        cachedVoice = britishMale;
        return cachedVoice;
    }
    
    const british = voices.find(v => v.lang.startsWith('en-GB'));
    if (british) {
        cachedVoice = british;
        return cachedVoice;
    }
    
    const englishMale = voices.find(v => 
        v.lang.startsWith('en') && v.name.toLowerCase().includes('male'));
    if (englishMale) {
        cachedVoice = englishMale;
        return cachedVoice;
    }
    
    const english = voices.find(v => v.lang.startsWith('en'));
    if (english) {
        cachedVoice = english;
        return cachedVoice;
    }
    
    cachedVoice = voices[0];
    return cachedVoice;
}

/**
 * Initialize voices when they become available
 */
function initVoices() {
    if (voicesLoaded) return Promise.resolve();
    
    return new Promise((resolve) => {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
            voicesLoaded = true;
            resolve();
            return;
        }
        
        // Chrome loads voices asynchronously
        window.speechSynthesis.onvoiceschanged = () => {
            voicesLoaded = true;
            resolve();
        };
        
        // Fallback timeout
        setTimeout(() => {
            voicesLoaded = true;
            resolve();
        }, 1000);
    });
}

// Initialize on load
if (typeof window !== 'undefined' && window.speechSynthesis) {
    initVoices();
}

/**
 * Speak text with the jester voice
 * @param {string} text - The text to speak
 * @param {number} rate - Speech rate (0.1 to 10, default 1.0)
 * @param {number} pitch - Voice pitch (0 to 2, default 1.0)
 * @returns {Promise<void>}
 */
window.poJokerSpeech = {
    speak: async function(text, rate = 1.0, pitch = 1.0) {
        if (!window.speechSynthesis) {
            console.warn('Speech synthesis not supported');
            return;
        }

        if (!text || !text.trim()) return;
        await initVoices();

        return new Promise((resolve, reject) => {
            const utterance = new SpeechSynthesisUtterance(text);

            const voice = getPreferredVoice();
            if (voice) {
                utterance.voice = voice;
            }

            utterance.rate = Math.max(0.1, Math.min(10, rate));
            utterance.pitch = Math.max(0, Math.min(2, pitch));
            utterance.volume = 1.0;

            // Wire up the resolve hooks BEFORE pushing into the queue — if the
            // utterance is dequeued and `speak()` invoked synchronously, the
            // hooks must already be attached or the first utterance can fire
            // `onend` before listeners exist (Chromium's TTS queueing has that
            // happen across hot reloads / rapid remounts).
            utterance.onend = () => {
                speechRunning = false;
                resolve();
                drainSpeechQueue();
            };
            utterance.onerror = (event) => {
                speechRunning = false;
                if (event.error === 'canceled' || event.error === 'interrupted') {
                    // Caller asked us to stop, or replaced the queue with stop();
                    // either way, resolve so the orchestrator unblocks.
                    resolve();
                } else {
                    reject(new Error(`Speech error: ${event.error}`));
                }
                drainSpeechQueue();
            };

            speechQueue.push({ utterance, resolve, reject });
            drainSpeechQueue();
        });
    },

    /**
     * Stop any ongoing speech. Drops the pending utterances AND cancels the
     * live one so the in-flight SpeakAsync promise resolves immediately,
     * letting the orchestrator move on without waiting for Chrome to finish
     * a sentence nobody will hear.
     */
    stop: function() {
        if (!window.speechSynthesis) return;
        // Drain the queue first so callers waiting on those promises unblock.
        while (speechQueue.length > 0) {
            const queued = speechQueue.shift();
            // Resolution (not rejection) — `stop` is treated as success by
            // the orchestrator, which is just abandoning the line.
            queued.resolve();
        }
        if (speechRunning) {
            window.speechSynthesis.cancel();
            // The cancel() will fire `onerror` with 'canceled' on the live
            // utterance, which already clears `speechRunning` and resolves.
        }
    },
    
    /**
     * Check if speech synthesis is supported
     * @returns {boolean}
     */
    isSupported: function() {
        return !!window.speechSynthesis;
    },
    
    /**
     * Check if currently speaking
     * @returns {boolean}
     */
    isSpeaking: function() {
        return window.speechSynthesis?.speaking ?? false;
    },
    
    /**
     * Get available voices
     * @returns {Array<{name: string, lang: string}>}
     */
    getVoices: function() {
        if (!window.speechSynthesis) return [];
        return window.speechSynthesis.getVoices().map(v => ({
            name: v.name,
            lang: v.lang
        }));
    }
};
