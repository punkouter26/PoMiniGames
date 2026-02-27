class AudioManager {
    private ctx: AudioContext | null = null;
    private enabled = true;

    private init() {
        if (!this.ctx && typeof window !== 'undefined') {
            this.ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        }
    }

    private playTone(freq: number, type: OscillatorType, duration: number, vol = 0.1) {
        if (!this.enabled) return;
        this.init();
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    }

    playCoin() {
        this.playTone(1200, 'sine', 0.1, 0.1);
        setTimeout(() => this.playTone(1600, 'sine', 0.2, 0.1), 50);
    }

    playBlip() {
        this.playTone(600, 'square', 0.05, 0.05);
    }

    playStart() {
        this.playTone(400, 'square', 0.1, 0.1);
        setTimeout(() => this.playTone(400, 'square', 0.1, 0.1), 1000);
        setTimeout(() => this.playTone(400, 'square', 0.1, 0.1), 2000);
        setTimeout(() => this.playTone(800, 'square', 0.3, 0.15), 3000);
    }

    playWin() {
        this.playTone(523, 'sine', 0.15, 0.1);
        setTimeout(() => this.playTone(659, 'sine', 0.15, 0.1), 100);
        setTimeout(() => this.playTone(784, 'sine', 0.15, 0.1), 200);
        setTimeout(() => this.playTone(1047, 'sine', 0.4, 0.15), 300);
    }

    playLose() {
        this.playTone(400, 'sawtooth', 0.3, 0.1);
        setTimeout(() => this.playTone(300, 'sawtooth', 0.4, 0.1), 200);
    }

    setEnabled(enabled: boolean) {
        this.enabled = enabled;
    }
}

export const audioManager = new AudioManager();
