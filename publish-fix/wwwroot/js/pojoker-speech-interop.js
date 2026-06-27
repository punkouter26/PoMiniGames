/**
 * Web Speech API interop for PoJoker
 * Provides text-to-speech functionality with British male voice preference
 * FR-016: Voiced jester character for narration
 */

// Voice cache to avoid repeated lookups
let cachedVoice = null;
let voicesLoaded = false;

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
        
        await initVoices();
        
        // Cancel any ongoing speech
        window.speechSynthesis.cancel();
        
        return new Promise((resolve, reject) => {
            const utterance = new SpeechSynthesisUtterance(text);
            
            const voice = getPreferredVoice();
            if (voice) {
                utterance.voice = voice;
            }
            
            utterance.rate = Math.max(0.1, Math.min(10, rate));
            utterance.pitch = Math.max(0, Math.min(2, pitch));
            utterance.volume = 1.0;
            
            utterance.onend = () => resolve();
            utterance.onerror = (event) => {
                if (event.error === 'canceled' || event.error === 'interrupted') {
                    resolve(); // Treat cancellation/interruption as success
                } else {
                    reject(new Error(`Speech error: ${event.error}`));
                }
            };
            
            window.speechSynthesis.speak(utterance);
        });
    },
    
    /**
     * Stop any ongoing speech
     */
    stop: function() {
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
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
