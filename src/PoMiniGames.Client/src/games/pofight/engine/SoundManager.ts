
export class SoundManager {
    private ctx: AudioContext | null = null;
    private enabled: boolean = false;

    constructor() {
        // Init on first user interaction usually, but we can try straight away or lazy load
        try {
            this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            this.enabled = true;
        } catch (e) {
            console.warn("WebAudio not supported", e);
        }
    }

    public resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    // --- SFX GENERATORS ---

    public playPunch(type: 'JAB' | 'HEAVY') {
        if (!this.enabled || !this.ctx) return;
        this.resume();

        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        // Use triangle for punch "whoosh" body
        osc.type = 'triangle';
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        if (type === 'JAB') {
            // Snappy whoosh
            osc.frequency.setValueAtTime(300, t);
            osc.frequency.exponentialRampToValueAtTime(50, t + 0.15);
            gain.gain.setValueAtTime(0.3, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
            osc.start(t);
            osc.stop(t + 0.15);
        } else {
            // Heavy swing
            osc.frequency.setValueAtTime(200, t);
            osc.frequency.exponentialRampToValueAtTime(20, t + 0.3);
            gain.gain.setValueAtTime(0.5, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
            osc.start(t);
            osc.stop(t + 0.3);
        }
    }

    public playHit(heavy: boolean) {
        if (!this.enabled || !this.ctx) return;
        this.resume();

        const t = this.ctx.currentTime;

        // Oscillator 1: The 'Smack'
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square'; // Crunchier
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        // Oscillator 2: The 'Thud' (Low end)
        const osc2 = this.ctx.createOscillator();
        const gain2 = this.ctx.createGain();
        osc2.type = 'sine';
        osc2.connect(gain2);
        gain2.connect(this.ctx.destination);

        const duration = heavy ? 0.3 : 0.15;

        // High frequency smack
        osc.frequency.setValueAtTime(heavy ? 200 : 400, t);
        osc.frequency.exponentialRampToValueAtTime(50, t + duration);
        gain.gain.setValueAtTime(heavy ? 0.3 : 0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

        // Low frequency thud
        osc2.frequency.setValueAtTime(150, t);
        osc2.frequency.exponentialRampToValueAtTime(40, t + duration);
        gain2.gain.setValueAtTime(heavy ? 0.6 : 0.3, t);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + duration);

        osc.start(t);
        osc.stop(t + duration);
        osc2.start(t);
        osc2.stop(t + duration);
    }

    public playBlock() {
        if (!this.enabled || !this.ctx) return;
        this.resume();

        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'square';
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        // Metallic ting
        osc.frequency.setValueAtTime(800, t);
        osc.frequency.exponentialRampToValueAtTime(1200, t + 0.05);
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);

        osc.start(t);
        osc.stop(t + 0.1);
    }

    public playCharge() {
        if (!this.enabled || !this.ctx) return;
        this.resume();

        // Use a persistent oscillator or just a long swoosh? 
        // For now, simple short whoosh for start charge
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.frequency.setValueAtTime(200, t);
        osc.frequency.linearRampToValueAtTime(400, t + 0.5);
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.linearRampToValueAtTime(0, t + 0.5);

        osc.start(t);
        osc.stop(t + 0.5);
    }
}

export const soundManager = new SoundManager();
