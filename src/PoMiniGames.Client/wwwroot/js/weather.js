// weather.js — seed-derived weather for outdoor games (§GFX-17).
//
// One system, three consumers (Marble Race, Sports, Racer): the match seed
// hashes to clear / rain / snow / fog, so every client in a multiplayer match
// computes identical weather with zero network traffic. Visuals are a 2D
// canvas overlay (rain streaks / drifting flakes / fog banding) — deliberately
// independent of any 3D engine — plus a synthesised rain/wind noise bed built
// on the shared audioBus (no audio assets, per the §GFX-10 contract).
//
// Tier-aware: low tier reduces particle counts and skips the noise bed.
//
// Exposed as window.PoWeather.
(function () {
    'use strict';

    let _canvas = null, _ctx = null, _raf = 0;
    let _type = 'clear', _intensity = 1, _drops = [], _wind = 0;
    let _audio = null;   // { src, gain, filter, ctx }

    function hash(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }

    function weatherForSeed(seed) {
        const r = hash(String(seed)) % 100;
        if (r < 58) return 'clear';
        if (r < 83) return 'rain';
        if (r < 94) return 'snow';
        return 'fog';
    }

    function spawnDrop(w, h, initial) {
        const snow = _type === 'snow';
        return {
            x: Math.random() * w,
            y: initial ? Math.random() * h : -10,
            len: snow ? 2 + Math.random() * 2 : 9 + Math.random() * 12,
            spd: snow ? 0.5 + Math.random() * 0.7 : 11 + Math.random() * 7,
            drift: (Math.random() - 0.5) * (snow ? 1.4 : 0.4),
            o: 0.25 + Math.random() * 0.5
        };
    }

    function tick() {
        _raf = requestAnimationFrame(tick);
        if (!_ctx || _type === 'clear' || _type === 'fog') return;
        const w = _canvas.width, h = _canvas.height;
        _ctx.clearRect(0, 0, w, h);
        const snow = _type === 'snow';
        _ctx.strokeStyle = snow ? 'rgba(235,242,255,0.9)' : 'rgba(170,200,255,0.55)';
        _ctx.fillStyle = 'rgba(235,242,255,0.85)';
        _ctx.lineWidth = snow ? 2 : 1.2;
        for (const d of _drops) {
            d.y += d.spd * _intensity;
            d.x += d.drift + _wind;
            if (d.y > h + 12) { Object.assign(d, spawnDrop(w, h, false)); }
            if (snow) {
                _ctx.globalAlpha = d.o;
                _ctx.beginPath(); _ctx.arc(d.x, d.y, d.len * 0.6, 0, Math.PI * 2); _ctx.fill();
            } else {
                _ctx.globalAlpha = d.o;
                _ctx.beginPath(); _ctx.moveTo(d.x, d.y); _ctx.lineTo(d.x + _wind * 2, d.y + d.len); _ctx.stroke();
            }
        }
        _ctx.globalAlpha = 1;
    }

    // ── audio bed: filtered noise, zero assets ────────────────────────────
    async function startAudio(type) {
        try {
            const bus = window.PoAudioBus;
            if (!bus?.isAvailable?.() || bus.isMuted?.()) return;
            const ctx = await bus.contextSync();
            if (!ctx) return;
            stopAudio();
            const len = ctx.sampleRate * 2;
            const buf = ctx.createBuffer(1, len, ctx.sampleRate);
            const ch = buf.getChannelData(0);
            for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
            const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
            const filter = ctx.createBiquadFilter();
            if (type === 'rain') { filter.type = 'bandpass'; filter.frequency.value = 5200; filter.Q.value = 0.4; }
            else { filter.type = 'lowpass'; filter.frequency.value = 420; }   // wind
            const gain = ctx.createGain();
            gain.gain.value = 0;
            src.connect(filter).connect(gain);
            // Land on the app's ambient bus so the master chain (mute/reverb)
            // governs it like every other voice.
            const dest = await bus.busSync('ambient');
            if (dest) gain.connect(dest); else gain.connect(ctx.destination);
            src.start();
            gain.gain.linearRampToValueAtTime(type === 'rain' ? 0.05 : 0.035, ctx.currentTime + 2.5);
            _audio = { src: src, gain: gain };
        } catch { /* audio is garnish; weather is visual-first */ }
    }

    function stopAudio() {
        if (!_audio) return;
        try { _audio.gain.gain.linearRampToValueAtTime(0, (_audio.src.context?.currentTime) || 0); } catch { }
        const a = _audio; setTimeout(function () { try { a.src.stop(); } catch { } }, 600);
        _audio = null;
    }

    // apply({ seed, stage, three?, scene? }):
    //   seed   — match seed (any string); identical across clients
    //   stage  — the element the overlay canvas mounts into
    function apply(opts) {
        const o = opts || {};
        const type = o.type || weatherForSeed(o.seed || 'default');
        _type = type;
        const q = window.PoQuality;
        _intensity = q && q.tier() === 'low' ? 0.5 : 1;

        stop();
        if (type === 'clear') return type;

        // Overlay canvas over the stage, pointer-transparent.
        _canvas = document.createElement('canvas');
        _canvas.className = 'po-weather-canvas';
        _canvas.setAttribute('aria-hidden', 'true');
        Object.assign(_canvas.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '3' });
        (o.stage || document.body).appendChild(_canvas);
        const fit = function () { _canvas.width = _canvas.clientWidth; _canvas.height = _canvas.clientHeight; };
        fit();
        window.addEventListener('resize', fit);
        _ctx = _canvas.getContext('2d');

        const count = type === 'fog' ? 0 : Math.round((type === 'snow' ? 90 : 140) * _intensity * (Math.min(_canvas.width, 900) / 900 + 0.3));
        _drops = [];
        for (let i = 0; i < count; i++) _drops.push(spawnDrop(_canvas.width, _canvas.height, true));
        _wind = type === 'rain' ? 0.6 : 0.25;

        // Fog: no particles — a slow-banding translucent gradient overlay.
        if (type === 'fog') {
            _canvas.style.background = 'linear-gradient(180deg, rgba(210,220,235,0.20), rgba(210,220,235,0.34) 55%, rgba(210,220,235,0.22))';
            _canvas.style.backdropFilter = 'blur(1.5px)';
        }

        if (type === 'rain' || type === 'snow') startAudio(type);
        tick();
        return type;
    }

    function stop() {
        cancelAnimationFrame(_raf);
        if (_canvas) { _canvas.remove(); _canvas = null; _ctx = null; }
        stopAudio();
    }

    window.PoWeather = {
        apply: apply,
        stop: stop,
        weatherForSeed: weatherForSeed,
        current: function () { return _type; }
    };
})();
