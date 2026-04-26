let _audioCtx: AudioContext | null = null;
export function getAudioCtx(): AudioContext {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    return _audioCtx;
}

// ── Theme management ─────────────────────────────────────────────────────────
const THEME_KEY = 'porunner_audio_theme';
const THEMES = ['default', 'jungle', 'retro', 'silent'] as const;
type Theme = typeof THEMES[number];

export const THEME_LABELS: Record<Theme, string> = {
    default: '🔊 Default',
    jungle:  '🍌 Jungle',
    retro:   '👾 Retro',
    silent:  '🔇 Silent',
};

function _isTheme(s: string | null): s is Theme {
    return !!s && THEMES.includes(s as Theme);
}

let _theme: Theme = (() => {
    try {
        const stored = localStorage.getItem(THEME_KEY);
        return _isTheme(stored) ? stored : 'default';
    }
    catch { return 'default'; }
})();

export function getTheme(): Theme { return _theme; }

export function setTheme(theme: Theme): void {
    if (!_isTheme(theme)) return;
    _theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
}

/** Cycle to the next theme and return the new theme key. */
export function cycleTheme(): Theme {
    const idx = THEMES.indexOf(_theme);
    const nextIdx = (idx + 1) % THEMES.length;
    const next = THEMES[nextIdx]!;
    setTheme(next);
    return next;
}

/** Pick a random audible (non-silent) theme per-race. */
export function setRandomTheme(): void {
    const audible: Theme[] = ['default', 'jungle', 'retro'];
    const picked = audible[Math.floor(Math.random() * audible.length)]!;
    setTheme(picked);
}

// ── Public playSound entry-point ─────────────────────────────────────────────
export type SoundType = 'beep' | 'gun' | 'fart' | 'wrong' | 'crowd';
export function playSound(type: SoundType): void {
    if (_theme === 'silent') return;
    const audioCtx = getAudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (_theme === 'retro') {
        _playSoundRetro(type);
    } else if (_theme === 'jungle') {
        _playSoundJungle(type);
    } else {
        _playSoundDefault(type);
    }
}

// ── Web Audio helpers ─────────────────────────────────────────────────────────

interface OscParams {
    oscType?: OscillatorType;
    freq: number;
    freqRamp?: [number, number];
    freqSteps?: [number, number][];
    gainStart: number;
    gainEnd: number;
    gainLinear?: boolean;
    duration: number;
}

function _osc(audioCtx: AudioContext, params: OscParams): void {
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = params.oscType ?? 'sine';
    osc.frequency.setValueAtTime(params.freq, audioCtx.currentTime);
    if (params.freqRamp)  osc.frequency.exponentialRampToValueAtTime(params.freqRamp[0], audioCtx.currentTime + params.freqRamp[1]);
    if (params.freqSteps) params.freqSteps.forEach(([f, t]) => osc.frequency.setValueAtTime(f, audioCtx.currentTime + t));
    gain.gain.setValueAtTime(params.gainStart, audioCtx.currentTime);
    (params.gainLinear ? gain.gain.linearRampToValueAtTime : gain.gain.exponentialRampToValueAtTime)
        .call(gain.gain, params.gainEnd, audioCtx.currentTime + params.duration);
    osc.start(); osc.stop(audioCtx.currentTime + params.duration);
}

interface NoiseParams {
    duration: number;
    filterType: BiquadFilterType;
    filterFreq: number;
    filterQ?: number;
    gainStart: number;
    gainPeak: number;
    swellTime?: number;
    gainEnd: number;
}

function _noise(audioCtx: AudioContext, params: NoiseParams): void {
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * params.duration, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource(); src.buffer = buf;
    const filter = audioCtx.createBiquadFilter();
    filter.type = params.filterType; filter.frequency.value = params.filterFreq;
    if (params.filterQ) filter.Q.value = params.filterQ;
    const gain = audioCtx.createGain();
    src.connect(filter); filter.connect(gain); gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(params.gainStart, now);
    if (params.swellTime && params.swellTime > 0) gain.gain.linearRampToValueAtTime(params.gainPeak, now + params.swellTime);
    gain.gain.exponentialRampToValueAtTime(params.gainEnd, now + params.duration);
    src.start();
}

function _arpeggio(audioCtx: AudioContext, params: { notes: number[]; noteDur: number; gainStart: number }): void {
    params.notes.forEach((freq, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.type = 'square';
        const t = audioCtx.currentTime + i * params.noteDur;
        o.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(params.gainStart, t);
        g.gain.exponentialRampToValueAtTime(0.01, t + params.noteDur);
        o.start(t); o.stop(t + params.noteDur);
    });
}

// ── Default theme ─────────────────────────────────────────────────────────────
function _playSoundDefault(type: SoundType): void {
    const ctx = getAudioCtx();
    if (type === 'beep')  return _osc(ctx, { freq: 800, gainStart: 0.5, gainEnd: 0.01, duration: 0.1 });
    if (type === 'gun')   return _osc(ctx, { oscType: 'square',   freq: 200, freqRamp: [10, 0.5],  gainStart: 1.0, gainEnd: 0.01, duration: 0.5 });
    if (type === 'fart')  return _osc(ctx, { oscType: 'sawtooth', freq: 80,                         gainStart: 1.0, gainEnd: 0.01, gainLinear: true, duration: 0.3 });
    if (type === 'wrong') return _osc(ctx, { oscType: 'sawtooth', freq: 320, freqRamp: [80, 0.18], gainStart: 0.7, gainEnd: 0.01, duration: 0.18 });
    if (type === 'crowd') return _noise(ctx, { duration: 4, filterType: 'lowpass',  filterFreq: 400,
        gainStart: 0, gainPeak: 0.6, swellTime: 1, gainEnd: 0.01 });
}

// ── Jungle theme ──────────────────────────────────────────────────────────────
function _playSoundJungle(type: SoundType): void {
    const ctx = getAudioCtx();
    if (type === 'beep')  return _osc(ctx, { freq: 1200, freqRamp: [600, 0.06], gainStart: 0.6, gainEnd: 0.01, duration: 0.28 });
    if (type === 'gun')   return _noise(ctx, { duration: 0.35, filterType: 'bandpass', filterFreq: 220, filterQ: 0.6,
        gainStart: 1.4, gainPeak: 1.4, gainEnd: 0.01 });
    if (type === 'fart')  return _osc(ctx, { freq: 130, freqRamp: [65, 0.22],   gainStart: 1.0, gainEnd: 0.01, duration: 0.22 });
    if (type === 'wrong') return _osc(ctx, { oscType: 'triangle', freq: 520, freqRamp: [200, 0.18], gainStart: 0.8, gainEnd: 0.01, duration: 0.18 });
    if (type === 'crowd') return _noise(ctx, { duration: 4, filterType: 'bandpass', filterFreq: 600, filterQ: 0.4,
        gainStart: 0, gainPeak: 0.7, swellTime: 0.8, gainEnd: 0.01 });
}

// ── Retro / 8-bit theme ───────────────────────────────────────────────────────
function _playSoundRetro(type: SoundType): void {
    const ctx = getAudioCtx();
    if (type === 'gun')   return _arpeggio(ctx, { notes: [523, 659, 784, 1046], noteDur: 0.07, gainStart: 0.3 });
    if (type === 'crowd') return _arpeggio(ctx, { notes: [523, 659, 784, 1046, 784, 659, 523], noteDur: 0.14, gainStart: 0.2 });
    if (type === 'beep')  return _osc(ctx, { oscType: 'square', freq: 1046, gainStart: 0.3, gainEnd: 0.01, duration: 0.12 });
    if (type === 'fart')  return _osc(ctx, { oscType: 'square', freq: 220,
        freqSteps: [[110, 0.05], [55, 0.10]], gainStart: 0.5, gainEnd: 0.01, gainLinear: true, duration: 0.2 });
    if (type === 'wrong') return _osc(ctx, { oscType: 'square', freq: 400,
        freqSteps: [[300, 0.05], [200, 0.10]], gainStart: 0.5, gainEnd: 0.01, duration: 0.15 });
}