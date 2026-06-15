// =============================================================
//  PoRacer — JS Interop Shim
//  Handles canvas creation, input polling, and the rAF loop.
//  Game logic lives entirely in C#; this file is the "thin glue".
// =============================================================

const PoRacer = (() => {
    /** @type {HTMLCanvasElement|null} */
    let canvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    let ctx = null;
    /** @type {DotNetObjectReference|null} */
    let dotnetRef = null;
    let rafId = 0;
    let lastTs = 0;
    let lastSize = { w: 0, h: 0 };
    let tabHidden = false;

    const input = {
        up: false, down: false, left: false, right: false,
        w: false, a: false, s: false, d: false,
        space: false, r: false
    };

    function setKey(e, down) {
        const k = e.key.toLowerCase();
        switch (k) {
            case 'arrowup': case 'w': input.up = down; if (k === 'w') input.w = down; e.preventDefault(); break;
            case 'arrowdown': case 's': input.down = down; if (k === 's') input.s = down; e.preventDefault(); break;
            case 'arrowleft': case 'a': input.left = down; if (k === 'a') input.a = down; e.preventDefault(); break;
            case 'arrowright': case 'd': input.right = down; if (k === 'd') input.d = down; e.preventDefault(); break;
            case ' ': input.space = down; e.preventDefault(); break;
            case 'r': input.r = down; break;
        }
    }

    window.addEventListener('keydown', (e) => setKey(e, true));
    window.addEventListener('keyup', (e) => setKey(e, false));
    window.addEventListener('blur', () => { for (const k in input) input[k] = false; });

    // ----- Touch / pointer controls (mobile) -----
    // Buttons carry data-po-input="up|down|left|right|space". Event delegation
    // keeps the bindings alive across Blazor re-renders. Pointer capture means
    // sliding a finger off a button still releases it on pointerup.
    const TOUCH_KEYS = ['up', 'down', 'left', 'right', 'space'];
    function touchTarget(e) {
        const el = e.target instanceof Element ? e.target.closest('[data-po-input]') : null;
        const key = el?.getAttribute('data-po-input');
        return TOUCH_KEYS.includes(key) ? { el, key } : null;
    }
    document.addEventListener('pointerdown', (e) => {
        const t = touchTarget(e);
        if (!t) return;
        e.preventDefault();
        try { t.el.setPointerCapture(e.pointerId); } catch { }
        input[t.key] = true;
        t.el.classList.add('is-pressed');
    }, { passive: false });
    function releaseTouch(e) {
        const t = touchTarget(e);
        if (!t) return;
        input[t.key] = false;
        t.el.classList.remove('is-pressed');
    }
    document.addEventListener('pointerup', releaseTouch);
    document.addEventListener('pointercancel', releaseTouch);
    document.addEventListener('visibilitychange', () => {
        tabHidden = document.hidden;
        if (!tabHidden && dotnetRef && !rafId) { lastTs = 0; rafId = requestAnimationFrame(frame); }
    });

    const MAX_DPR = 1.25;
    const MAX_CSS_W = 1600;
    const MAX_CSS_H = 900;

    function resize() {
        if (!canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const w = Math.min(canvas.clientWidth, MAX_CSS_W);
        const h = Math.min(canvas.clientHeight, MAX_CSS_H);
        lastSize = { w, h };
        const bw = Math.max(1, Math.floor(w * dpr));
        const bh = Math.max(1, Math.floor(h * dpr));
        if (canvas.width !== bw || canvas.height !== bh) {
            canvas.width = bw; canvas.height = bh;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            PoRacerRender.invalidateBitmaps();
        }
    }
    window.addEventListener('resize', resize);

    function frame(ts) {
        if (!dotnetRef) { rafId = 0; return; }
        if (tabHidden) { rafId = 0; return; }
        const now = ts || performance.now();
        const dtMs = lastTs === 0 ? 16.0 : (now - lastTs);
        lastTs = now;
        const dt = Math.min(dtMs, 50) / 1000.0;
        resize();
        try { dotnetRef.invokeMethodAsync('Tick', dt, lastSize.w, lastSize.h, input); }
        catch (e) { console.error('Tick failed', e); rafId = 0; return; }
        rafId = requestAnimationFrame(frame);
    }

    return {
        start(canvasId, dotnetObj) {
            canvas = document.getElementById(canvasId);
            if (!canvas) { console.error('Canvas not found:', canvasId); return; }
            ctx = canvas.getContext('2d');
            dotnetRef = dotnetObj; resize(); lastTs = 0;
            rafId = requestAnimationFrame(frame);
        },
        stop() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; dotnetRef = null; },
        getSize() { resize(); return lastSize; }
    };
})();

window.PoRacer = PoRacer;


// =============================================================
//  PoRacerRender — Enhanced 2D renderer with all 10 visual FX
// =============================================================
(function () {
    /** @type {Float32Array|null} */ let centerXY = null;
    /** @type {Float32Array|null} */ let wallsXY = null;
    let centerN = 0, wallsM = 0, trackWidth = 0;

    let grassTex = null, grassW = 0, grassH = 0;
    // Track is cached in WORLD space (origin = bbox min) at a given scale, then
    // blitted with a camera offset each frame. trackOriginX/Y is the world
    // coordinate that maps to the bitmap's TRACK_MARGIN,TRACK_MARGIN pixel.
    const TRACK_MARGIN = 64;
    let trackTex = null, trackTexW = 0, trackTexH = 0;
    let trackOriginX = 0, trackOriginY = 0, trackScale = 1;

    // Cached canvas references (avoid getElementById every frame)
    let mainCanvasEl = null, mainCanvasId_ = null;
    let mainCtx_ = null; // cached 2D context
    let miniCanvasEl = null, miniCanvasId_ = null;
    // Cached vignette gradient (recreated only on resize)
    let vignetteTex = null, vignetteW = 0, vignetteH = 0;
    // Cached fog texture (recreated only on resize)
    let fogTex = null, fogTexW = 0, fogTexH = 0;

    // Pre-computed skid bucket color strings (8 buckets, never change)
    const SKID_BUCKETS = 8;
    const _skidColors = Array.from({length: SKID_BUCKETS}, (_, b) =>
        'rgba(20,20,20,' + ((b + 0.5) / SKID_BUCKETS).toFixed(2) + ')');

    // Packed-int → rgb() string cache (car colors are fixed 8 values)
    const _colorCache = new Map();
    function cachedColor(packed) {
        let s = _colorCache.get(packed);
        if (!s) {
            s = 'rgb(' + ((packed >> 16) & 0xff) + ',' + ((packed >> 8) & 0xff) + ',' + (packed & 0xff) + ')';
            _colorCache.set(packed, s);
        }
        return s;
    }

    // Bloom toggle
    let bloomEnabled = true;
    let minimapTex = null, minimapBbox = null;

    // Feature 4: Parallax
    let parallaxFar = null, parallaxMid = null, parallaxW = 0, parallaxH = 0;

    // Feature 3: Screen shake
    let shakeX = 0, shakeY = 0, shakeDecay = 0;

    // Feature 8+10: Time-of-day / ambient
    let timeOfDay = 0.5;
    let fogDensity = 0;

    // Feature 2: Sparks
    const MAX_SPARKS = 200;
    let sparkData = new Float32Array(MAX_SPARKS * 6);
    let sparkCount = 0;

    // Feature 8: Bloom
    let bloomTex = null, bloomW = 0, bloomH = 0;

    // JS-owned particle pools — never marshalled to/from C#
    const MAX_JS_SMOKE = 400;
    const _jsSmoke = new Float32Array(MAX_JS_SMOKE * 6); // x,y,vx,vy,size,life
    let _jsSmokeHead = 0;
    const MAX_JS_SKIDS = 800;
    const _jsSkids = new Float32Array(MAX_JS_SKIDS * 5); // x1,y1,x2,y2,alpha
    let _jsSkidHead = 0;
    const MAX_JS_WEATHER = 150;
    const _jsWeather = new Float32Array(MAX_JS_WEATHER * 6); // x,y,vx,vy,life,size
    let _jsWeatherHead = 0;

    function project(x, y, camX, camY, scale, w, h) {
        return [w * 0.5 + (x - camX) * scale, h * 0.5 + (y - camY) * scale];
    }
    function createOffscreen(w, h) {
        if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
        const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
    }
    function unpackColor(p) {
        return 'rgb(' + ((p >> 16) & 0xff) + ',' + ((p >> 8) & 0xff) + ',' + (p & 0xff) + ')';
    }
    function mulberry32(seed) {
        let a = seed;
        return function() { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    }

    // --- Feature 4: Parallax layers ---
    function ensureParallaxLayers(w, h) {
        if (parallaxW === w && parallaxH === h && parallaxFar && parallaxMid) return;
        parallaxW = w; parallaxH = h;
        const farOff = createOffscreen(w, h);
        const farCtx = farOff.getContext('2d');
        const farGrad = farCtx.createLinearGradient(0, 0, 0, h);
        farGrad.addColorStop(0, 'rgba(8,20,12,0.3)'); farGrad.addColorStop(1, 'rgba(4,10,6,0.5)');
        farCtx.fillStyle = farGrad; farCtx.fillRect(0, 0, w, h);
        farCtx.fillStyle = 'rgba(15,35,20,0.4)';
        const rng = mulberry32(42);
        for (let i = 0; i < 40; i++) { const tx = rng() * w, ty = rng() * h * 0.6 + h * 0.2, th = 20 + rng() * 40, tw = 10 + rng() * 15; farCtx.beginPath(); farCtx.moveTo(tx, ty); farCtx.lineTo(tx - tw, ty + th); farCtx.lineTo(tx + tw, ty + th); farCtx.closePath(); farCtx.fill(); }
        parallaxFar = farOff;
        const midOff = createOffscreen(w, h);
        const midCtx = midOff.getContext('2d');
        midCtx.fillStyle = 'rgba(20,50,30,0.25)';
        const rng2 = mulberry32(99);
        for (let i = 0; i < 60; i++) { midCtx.beginPath(); midCtx.arc(rng2() * w, rng2() * h, 4 + rng2() * 12, 0, Math.PI * 2); midCtx.fill(); }
        midCtx.fillStyle = 'rgba(60,65,70,0.2)';
        for (let i = 0; i < 25; i++) { midCtx.fillRect(rng2() * w, rng2() * h, 3 + rng2() * 5, 2 + rng2() * 3); }
        parallaxMid = midOff;
    }

    // --- Feature 3: Screen shake ---
    function applyShake(intensity) {
        if (intensity <= 0) return;
        shakeX = (Math.random() - 0.5) * intensity * 14;
        shakeY = (Math.random() - 0.5) * intensity * 14;
        shakeDecay = Math.max(shakeDecay, intensity);
    }
    function updateShake() {
        if (shakeDecay > 0.01) { shakeX *= 0.82; shakeY *= 0.82; shakeDecay *= 0.88; }
        else { shakeX = 0; shakeY = 0; shakeDecay = 0; }
    }

    // --- Feature 2: Spark particles ---
    function emitSparks(x, y, count) {
        for (let i = 0; i < count; i++) {
            const idx = (sparkCount % MAX_SPARKS) * 6;
            sparkData[idx] = x; sparkData[idx + 1] = y;
            sparkData[idx + 2] = (Math.random() - 0.5) * 220;
            sparkData[idx + 3] = (Math.random() - 0.5) * 220;
            sparkData[idx + 4] = 0.3 + Math.random() * 0.5;
            sparkData[idx + 5] = 1 + Math.random() * 2;
            sparkCount++;
        }
        if (sparkCount > MAX_SPARKS) sparkCount = MAX_SPARKS;
    }
    function updateSparks() {
        let w = 0, total = Math.min(sparkCount, MAX_SPARKS);
        for (let i = 0; i < total; i++) {
            const idx = i * 6;
            sparkData[idx + 4] -= 0.016;
            if (sparkData[idx + 4] > 0) {
                sparkData[idx] += sparkData[idx + 2] * 0.016;
                sparkData[idx + 1] += sparkData[idx + 3] * 0.016;
                sparkData[idx + 3] += 180 * 0.016;
                if (w !== i) { const wi = w * 6; sparkData[wi] = sparkData[idx]; sparkData[wi+1] = sparkData[idx+1]; sparkData[wi+2] = sparkData[idx+2]; sparkData[wi+3] = sparkData[idx+3]; sparkData[wi+4] = sparkData[idx+4]; sparkData[wi+5] = sparkData[idx+5]; }
                w++;
            }
        }
        sparkCount = w;
    }
    function drawSparks(g, camX, camY, scale, w, h) {
        const total = Math.min(sparkCount, MAX_SPARKS);
        for (let i = 0; i < total; i++) {
            const idx = i * 6;
            const p = project(sparkData[idx], sparkData[idx + 1], camX, camY, scale, w, h);
            const alpha = Math.max(0, sparkData[idx + 4] / 0.5);
            g.fillStyle = 'rgba(255,' + Math.min(255, (1 - alpha) * 400) + ',' + Math.min(255, (1 - alpha) * 600) + ',' + alpha + ')';
            g.shadowColor = 'rgba(255,150,50,' + alpha * 0.8 + ')'; g.shadowBlur = 6;
            g.beginPath(); g.arc(p[0], p[1], sparkData[idx + 5] * scale * 0.15, 0, Math.PI * 2); g.fill();
        }
        g.shadowBlur = 0;
    }

    // --- Feature 8: Post-processing ---
    function drawVignette(g, w, h) {
        if (!vignetteTex || vignetteW !== w || vignetteH !== h) {
            vignetteW = w; vignetteH = h;
            vignetteTex = createOffscreen(w, h);
            const vc = vignetteTex.getContext('2d');
            const vg = vc.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.8);
            vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.6)');
            vc.fillStyle = vg; vc.fillRect(0, 0, w, h);
        }
        g.drawImage(vignetteTex, 0, 0, w, h);
    }
    // Bloom: cached context and half-res offscreen to cut filter cost ~4x
    let bloomCtx = null;
    function drawBloom(g, w, h) {
        const hw = w >> 1, hh = h >> 1; // half-res: blur on smaller surface is 4x cheaper
        if (!bloomTex || bloomW !== hw || bloomH !== hh) {
            bloomTex = createOffscreen(hw, hh); bloomW = hw; bloomH = hh;
            bloomCtx = bloomTex.getContext('2d');
        }
        bloomCtx.clearRect(0, 0, hw, hh);
        bloomCtx.filter = 'blur(3px) brightness(1.4)'; // blur radius halved with resolution
        bloomCtx.drawImage(g.canvas, 0, 0, hw, hh);
        bloomCtx.filter = 'none';
        g.globalCompositeOperation = 'screen'; g.globalAlpha = 0.18;
        g.drawImage(bloomTex, 0, 0, w, h); // upscale back — GPU bilinear hides the seam
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    }
    function drawSpeedLines(g, w, h, speedKph, maxKph) {
        const ratio = speedKph / Math.max(1, maxKph);
        if (ratio < 0.6) return;
        const intensity = (ratio - 0.6) / 0.4;
        const cx = w / 2, cy = h / 2, lineCount = Math.floor(intensity * 24);
        g.save(); g.globalAlpha = intensity * 0.4; g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1.2;
        for (let i = 0; i < lineCount; i++) {
            const angle = (i / lineCount) * Math.PI * 2;
            const innerR = 40 + Math.random() * 80, outerR = Math.max(w, h) * 0.7;
            g.beginPath(); g.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR); g.lineTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR); g.stroke();
        }
        g.restore();
    }
    function drawFog(g, w, h, density) {
        if (density < 0.01) return;
        if (!fogTex || fogTexW !== w || fogTexH !== h) {
            fogTexW = w; fogTexH = h;
            fogTex = createOffscreen(w, h);
            const fc = fogTex.getContext('2d');
            const fg = fc.createRadialGradient(w/2, h/2, Math.min(w,h)*0.15, w/2, h/2, Math.max(w,h)*0.65);
            fg.addColorStop(0, 'rgba(180,190,200,0)');
            fg.addColorStop(1, 'rgba(180,190,200,1)');
            fc.fillStyle = fg; fc.fillRect(0, 0, w, h);
        }
        g.globalAlpha = density * 0.5;
        g.drawImage(fogTex, 0, 0, w, h);
        g.globalAlpha = 1;
    }

    // --- JS particle system (smoke, skids, weather) ---
    function addSmokeEvt(x, y, vx, vy, size, life) {
        const s = (_jsSmokeHead % MAX_JS_SMOKE) * 6;
        _jsSmoke[s]=x; _jsSmoke[s+1]=y; _jsSmoke[s+2]=vx; _jsSmoke[s+3]=vy;
        _jsSmoke[s+4]=size; _jsSmoke[s+5]=life;
        _jsSmokeHead++;
    }
    function addSkidEvt(x1, y1, x2, y2, alpha) {
        const s = (_jsSkidHead % MAX_JS_SKIDS) * 5;
        _jsSkids[s]=x1; _jsSkids[s+1]=y1; _jsSkids[s+2]=x2; _jsSkids[s+3]=y2; _jsSkids[s+4]=alpha;
        _jsSkidHead++;
    }
    function updateSmoke(dt) {
        for (let i = 0; i < MAX_JS_SMOKE; i++) {
            const o = i * 6;
            if (_jsSmoke[o+5] <= 0) continue;
            _jsSmoke[o+5] -= dt;
            _jsSmoke[o]   += _jsSmoke[o+2] * dt;
            _jsSmoke[o+1] += _jsSmoke[o+3] * dt;
            _jsSmoke[o+2] *= Math.max(0, 1 - 0.8 * dt);
            _jsSmoke[o+3] *= Math.max(0, 1 - 0.8 * dt);
            _jsSmoke[o+4] += 8 * dt;
        }
    }
    function drawSmoke(g, camX, camY, scale, w, h) {
        if (!window._smokeSprite) {
            const sz = 64, sp = createOffscreen(sz, sz), sc = sp.getContext('2d');
            const gr = sc.createRadialGradient(sz/2,sz/2,0,sz/2,sz/2,sz/2);
            gr.addColorStop(0,'rgba(220,225,235,1)'); gr.addColorStop(1,'rgba(220,225,235,0)');
            sc.fillStyle = gr; sc.fillRect(0,0,sz,sz);
            window._smokeSprite = sp;
        }
        const sp = window._smokeSprite, hw = w*0.5, hh = h*0.5;
        for (let i = 0; i < MAX_JS_SMOKE; i++) {
            const o = i * 6;
            if (_jsSmoke[o+5] <= 0) continue;
            const r = _jsSmoke[o+4] * scale;
            if (r < 0.5) continue;
            g.globalAlpha = Math.max(0, _jsSmoke[o+5] * 0.393); // 0.55/1.4
            g.drawImage(sp, hw+(_jsSmoke[o]-camX)*scale-r, hh+(_jsSmoke[o+1]-camY)*scale-r, r*2, r*2);
        }
        g.globalAlpha = 1;
    }
    function updateSkids(dt) {
        for (let i = 0; i < MAX_JS_SKIDS; i++) {
            const o = i * 5;
            if (_jsSkids[o+4] <= 0) continue;
            _jsSkids[o+4] *= Math.max(0, 1 - 0.05 * dt);
            if (_jsSkids[o+4] < 0.01) _jsSkids[o+4] = 0;
        }
    }
    function drawSkids(g, camX, camY, scale, w, h) {
        g.lineCap = 'round'; g.lineWidth = 3.5;
        const paths = new Array(SKID_BUCKETS);
        for (let b = 0; b < SKID_BUCKETS; b++) paths[b] = [];
        const hw = w*0.5, hh = h*0.5;
        for (let i = 0; i < MAX_JS_SKIDS; i++) {
            const o = i * 5;
            const alpha = _jsSkids[o+4];
            if (alpha < 0.02) continue;
            const b = Math.min(SKID_BUCKETS-1, Math.floor(alpha * SKID_BUCKETS));
            paths[b].push(hw+(_jsSkids[o]-camX)*scale, hh+(_jsSkids[o+1]-camY)*scale,
                          hw+(_jsSkids[o+2]-camX)*scale, hh+(_jsSkids[o+3]-camY)*scale);
        }
        for (let b = 0; b < SKID_BUCKETS; b++) {
            const pts = paths[b]; if (!pts.length) continue;
            g.strokeStyle = _skidColors[b]; g.beginPath();
            for (let j = 0; j < pts.length; j+=4) { g.moveTo(pts[j],pts[j+1]); g.lineTo(pts[j+2],pts[j+3]); }
            g.stroke();
        }
    }
    function updateWeather(dt, weatherType, camX, camY, scale, w, h) {
        if (weatherType > 0) {
            const cnt = weatherType===1?2:weatherType===2?5:3;
            const worldW=w/scale, worldH=h/scale;
            for (let i=0; i<cnt; i++) {
                const s = (_jsWeatherHead % MAX_JS_WEATHER) * 6;
                _jsWeather[s+0] = (Math.random()-0.5)*worldW + camX;
                _jsWeather[s+1] = camY - worldH*0.5;
                _jsWeather[s+2] = weatherType===3 ? (Math.random()-0.5)*20 : 0;
                _jsWeather[s+3] = weatherType===3 ? 30+Math.random()*20 : 120+Math.random()*60;
                _jsWeather[s+4] = 2+Math.random()*2;
                _jsWeather[s+5] = weatherType===3 ? 2+Math.random()*3 : 0.5+Math.random();
                _jsWeatherHead++;
            }
        }
        for (let i=0; i<MAX_JS_WEATHER; i++) {
            const o=i*6; if (_jsWeather[o+4]<=0) continue;
            _jsWeather[o+4]-=dt; _jsWeather[o]+=_jsWeather[o+2]*dt; _jsWeather[o+1]+=_jsWeather[o+3]*dt;
        }
    }
    function drawWeather(g, camX, camY, scale, w, h, weatherType) {
        if (!weatherType) return;
        for (let i=0; i<MAX_JS_WEATHER; i++) {
            const o=i*6; if (_jsWeather[o+4]<=0) continue;
            const r=_jsWeather[o+5]*scale, p=project(_jsWeather[o],_jsWeather[o+1],camX,camY,scale,w,h);
            const lr=_jsWeather[o+4]/4;
            if (weatherType===3) { g.fillStyle='rgba(255,255,255,'+(lr*0.8)+')'; g.shadowColor='rgba(200,220,255,0.3)'; g.shadowBlur=3; g.beginPath(); g.arc(p[0],p[1],r,0,Math.PI*2); g.fill(); g.shadowBlur=0; }
            else { g.strokeStyle='rgba(180,210,255,'+(lr*0.6)+')'; g.lineWidth=1.5; g.beginPath(); g.moveTo(p[0],p[1]); g.lineTo(p[0]-1,p[1]+r*8); g.stroke(); }
        }
    }

    // --- Grass ---
    function ensureGrass(w, h) {
        if (grassTex && grassW === w && grassH === h) return;
        const off = createOffscreen(w, h), g = off.getContext('2d');
        const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
        grad.addColorStop(0, '#1f5a2f'); grad.addColorStop(0.5, '#163f20'); grad.addColorStop(1, '#0c2412');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(140,200,120,0.08)';
        for (let y = 0; y < h; y += 22) for (let x = 0; x < w; x += 22) g.fillRect(x, y, 2, 2);
        grassTex = off; grassW = w; grassH = h;
    }

    // --- Feature 6: Enhanced track with surface variety ---
    //
    // PERF: The track is rasterized ONCE into a world-space offscreen bitmap
    // (sized to the track bounding box + margin, at the current `scale`). The
    // camera no longer invalidates it; each frame we just blit the bitmap with
    // a camera-relative offset (see draw()). Previously this redrew ~156-point
    // polylines every frame because the follow-camera pans continuously, which
    // defeated the cache entirely. Now it only rebuilds when geometry or zoom
    // (scale) changes.
    function trackTx(x, y) {
        // World -> track-texture pixel space (fixed origin at the bbox min).
        return [(x - trackOriginX) * trackScale + TRACK_MARGIN, (y - trackOriginY) * trackScale + TRACK_MARGIN];
    }
    function buildTrackBitmap(scale) {
        if (!centerXY) return;

        // World bounding box of the centerline (+0.92 inset used by patches).
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (let i = 0; i < centerN; i++) {
            const x = centerXY[i * 2], y = centerXY[i * 2 + 1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        // Pad by half track width so curbs/rumble strips fit inside the bitmap.
        const pad = trackWidth;
        minX -= pad; minY -= pad; maxX += pad; maxY += pad;

        trackOriginX = minX; trackOriginY = minY; trackScale = scale;
        const texW = Math.max(1, Math.ceil((maxX - minX) * scale + TRACK_MARGIN * 2));
        const texH = Math.max(1, Math.ceil((maxY - minY) * scale + TRACK_MARGIN * 2));

        const off = createOffscreen(texW, texH), g = off.getContext('2d');
        const wpx = trackWidth * scale;

        // Base asphalt
        g.beginPath();
        for (let i = 0; i <= centerN; i++) { const [sx, sy] = trackTx(centerXY[(i % centerN) * 2], centerXY[(i % centerN) * 2 + 1]); if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy); }
        g.closePath();
        const grad = g.createLinearGradient(0, 0, texW, texH);
        grad.addColorStop(0, '#3d424a'); grad.addColorStop(0.5, '#2a2e36'); grad.addColorStop(1, '#1f242c');
        g.fillStyle = grad; g.fill();

        // Feature 6: Rumble strips + curbs
        g.save();
        g.beginPath();
        for (let i = 0; i <= centerN; i++) { const [sx, sy] = trackTx(centerXY[(i % centerN) * 2], centerXY[(i % centerN) * 2 + 1]); if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy); }
        g.closePath();
        g.lineJoin = 'round'; g.lineCap = 'round';
        g.strokeStyle = '#cc2222'; g.lineWidth = wpx + 14; g.stroke();
        g.strokeStyle = '#ffffff'; g.lineWidth = wpx + 10; g.stroke();
        g.setLineDash([6, 6]); g.strokeStyle = 'rgba(200,60,60,0.5)'; g.lineWidth = wpx + 2; g.stroke(); g.setLineDash([]);
        g.restore();

        // Feature 6: Surface color patches
        g.globalAlpha = 0.06;
        const patchColors = ['#4a6080', '#604a4a', '#4a5a4a', '#5a5040'];
        for (let p = 0; p < 4; p++) {
            const startSeg = Math.floor(centerN * p / 4), endSeg = Math.floor(centerN * (p + 1) / 4);
            g.fillStyle = patchColors[p]; g.beginPath();
            for (let i = startSeg; i <= endSeg; i++) { const idx = i % centerN; const [sx, sy] = trackTx(centerXY[idx * 2], centerXY[idx * 2 + 1]); if (i === startSeg) g.moveTo(sx, sy); else g.lineTo(sx, sy); }
            for (let i = endSeg; i >= startSeg; i--) { const idx = i % centerN; const [sx, sy] = trackTx(centerXY[idx * 2] * 0.92, centerXY[idx * 2 + 1] * 0.92); g.lineTo(sx, sy); }
            g.closePath(); g.fill();
        }
        g.globalAlpha = 1.0;

        // Feature 6: Apex markers
        for (let i = 0; i < centerN; i += Math.max(1, Math.floor(centerN / 12))) {
            const prev = { x: centerXY[((i - 1 + centerN) % centerN) * 2], y: centerXY[((i - 1 + centerN) % centerN) * 2 + 1] };
            const curr = { x: centerXY[i * 2], y: centerXY[i * 2 + 1] };
            const next = { x: centerXY[((i + 1) % centerN) * 2], y: centerXY[((i + 1) % centerN) * 2 + 1] };
            const a1 = Math.atan2(curr.y - prev.y, curr.x - prev.x), a2 = Math.atan2(next.y - curr.y, next.x - curr.x);
            let curv = Math.abs(a2 - a1); if (curv > Math.PI) curv = 2 * Math.PI - curv;
            if (curv > 0.15) {
                const [mx, my] = trackTx(curr.x, curr.y);
                const ms = 4 * scale * 0.1;
                g.fillStyle = 'rgba(255,200,50,0.6)';
                g.beginPath(); g.moveTo(mx + Math.cos(a1) * ms * 3, my + Math.sin(a1) * ms * 3); g.lineTo(mx - Math.cos(a1 + 0.5) * ms, my - Math.sin(a1 + 0.5) * ms); g.lineTo(mx - Math.cos(a1 - 0.5) * ms, my - Math.sin(a1 - 0.5) * ms); g.closePath(); g.fill();
            }
        }

        // Centerline
        g.setLineDash([14, 14]); g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 2;
        g.beginPath();
        for (let i = 0; i < centerN; i++) { const [sx, sy] = trackTx(centerXY[i * 2], centerXY[i * 2 + 1]); if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy); }
        g.closePath(); g.stroke(); g.setLineDash([]);

        // Start/finish
        const [ax, ay] = trackTx(centerXY[0], centerXY[1]);
        const [bx, by] = trackTx(centerXY[2], centerXY[3]);
        const ddx = bx - ax, ddy = by - ay, llen = Math.hypot(ddx, ddy) || 1;
        const nx = -ddy / llen, ny = ddx / llen, half = wpx * 0.5;
        for (let i = 0; i < 10; i++) { const t0 = i / 10, t1 = (i + 1) / 10; g.fillStyle = (i % 2 === 0) ? '#fff' : '#111'; g.beginPath(); g.moveTo(ax + nx * (-half + t0 * wpx), ay + ny * (-half + t0 * wpx)); g.lineTo(bx + nx * (-half + t0 * wpx), by + ny * (-half + t0 * wpx)); g.lineTo(bx + nx * (-half + t1 * wpx), by + ny * (-half + t1 * wpx)); g.lineTo(ax + nx * (-half + t1 * wpx), ay + ny * (-half + t1 * wpx)); g.closePath(); g.fill(); }

        trackTex = off; trackTexW = texW; trackTexH = texH;
    }

    function buildMinimapBitmap() {
        if (!centerXY) return;
        const w = 180, h = 180, off = createOffscreen(w, h), g = off.getContext('2d');
        g.clearRect(0, 0, w, h); g.fillStyle = 'rgba(20,30,48,0.9)'; g.fillRect(0, 0, w, h);
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (let i = 0; i < centerN; i++) { const x = centerXY[i * 2], y = centerXY[i * 2 + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        const pad = trackWidth * 0.7; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
        const sx = (w - 12) / (maxX - minX), sy = (h - 12) / (maxY - minY), s = Math.min(sx, sy);
        const ox = (w - (maxX - minX) * s) / 2, oy = (h - (maxY - minY) * s) / 2;
        const toX = (x) => ox + (x - minX) * s, toY = (y) => oy + (y - minY) * s;
        g.strokeStyle = '#0a1424'; g.lineWidth = trackWidth * s + 4; g.lineJoin = 'round';
        g.beginPath(); for (let i = 0; i <= centerN; i++) { const [x, y] = [toX(centerXY[(i % centerN) * 2]), toY(centerXY[(i % centerN) * 2 + 1])]; if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); } g.closePath(); g.stroke();
        g.strokeStyle = '#9bb1cc'; g.lineWidth = 1.2;
        g.beginPath(); for (let i = 0; i < centerN; i++) { const x = toX(centerXY[i * 2]), y = toY(centerXY[i * 2 + 1]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); } g.closePath(); g.stroke();
        minimapTex = off; minimapBbox = { minX, minY, s, ox, oy };
    }

    // --- Feature 7: Enhanced car drawing ---
    function drawCar(g, c, cx, cy, color, colorDark, boost, isPlayer, speedRatio, damage, skidInt) {
        const [sx, sy] = project(cx, cy, c.camX, c.camY, c.scale, c.w, c.h);
        g.save(); g.translate(sx, sy); g.rotate(c.hdg); g.scale(c.scale, c.scale);

        // Feature 1: Soft shadow
        g.save(); g.translate(4, 6); g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(0, 0, 20, 12, 0, 0, Math.PI * 2); g.fill(); g.restore();

        // Feature 7: Damage darkening
        let bodyColor = color, bodyDark = colorDark;
        if (damage > 0.3) { bodyColor = colorDark; }

        // Boost glow
        if (boost > 0.05) { g.shadowColor = '#7fd4ff'; g.shadowBlur = 30 * boost; }

        // Car body — flat fill + dark overlay (no createLinearGradient)
        g.fillStyle = bodyColor; g.beginPath(); g.roundRect(-16, -9, 32, 18, 5); g.fill();
        g.fillStyle = bodyDark; g.globalAlpha = 0.4; g.beginPath(); g.roundRect(0, -9, 16, 18, [0, 5, 5, 0]); g.fill(); g.globalAlpha = 1;
        g.shadowBlur = 0; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1.2;
        g.beginPath(); g.roundRect(-16, -9, 32, 18, 5); g.stroke();

        // Windshield + stripe
        g.fillStyle = 'rgba(20,30,45,0.85)'; g.beginPath(); g.roundRect(2, -7, 8, 14, 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(-14, -1.2, 28, 2.4);

        // Feature 7: Headlight glow
        g.fillStyle = '#fffbe0'; g.shadowColor = '#fff7a0'; g.shadowBlur = 10;
        g.beginPath(); g.arc(14, -5, 1.8, 0, Math.PI * 2); g.arc(14, 5, 1.8, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;

        // Feature 1+7: Headlight beam cone — simple globalAlpha triangle (no radial gradient)
        if (speedRatio > 0.1) {
            g.save();
            g.globalAlpha = 0.13 * speedRatio;
            g.fillStyle = 'rgb(255,255,220)';
            g.beginPath(); g.moveTo(16, -4); g.lineTo(16 + 60 * speedRatio, -18); g.lineTo(16 + 60 * speedRatio, 18); g.lineTo(16, 4); g.closePath(); g.fill();
            g.restore();
        }

        // Feature 7: Taillights
        g.fillStyle = '#ff3030'; g.shadowColor = '#ff0000'; g.shadowBlur = 12;
        g.beginPath(); g.arc(-15, -5, 1.6, 0, Math.PI * 2); g.arc(-15, 5, 1.6, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;

        // Feature 7: Brake lights (brighter when skidding/slowing)
        if (skidInt > 0.3) {
            g.fillStyle = '#ff0000'; g.shadowColor = '#ff0000'; g.shadowBlur = 20;
            g.beginPath(); g.arc(-15, -5, 2.5, 0, Math.PI * 2); g.arc(-15, 5, 2.5, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
        }

        // Feature 7: Damage scratches
        if (damage > 0.3) {
            g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 0.8;
            for (let i = 0; i < Math.floor(damage * 4); i++) { const lx = -10 + (i * 7) % 20, ly = -6 + (i * 3) % 12; g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx + 4, ly + 3); g.stroke(); }
        }

        // Feature 7: Exhaust flame
        if (speedRatio > 0.85) {
            const fs = (speedRatio - 0.85) * 15;
            g.fillStyle = 'rgba(255,150,50,' + fs * 0.3 + ')'; g.beginPath(); g.moveTo(-16, -3); g.lineTo(-16 - fs, 0); g.lineTo(-16, 3); g.closePath(); g.fill();
            g.fillStyle = 'rgba(255,220,100,' + fs * 0.2 + ')'; g.beginPath(); g.moveTo(-16, -1.5); g.lineTo(-16 - fs * 0.6, 0); g.lineTo(-16, 1.5); g.closePath(); g.fill();
        }

        // Player ring
        if (isPlayer) { g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1.2; g.setLineDash([3, 3]); g.beginPath(); g.arc(0, 0, 22, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }

        g.restore();
    }

    // --- Feature 1: Ambient overlay ---
    function drawAmbientOverlay(g, w, h, tod, weatherType) {
        const dayBrightness = Math.sin(tod * Math.PI);
        let dark = 0.35 * (1 - dayBrightness * 0.7);
        if (weatherType === 1 || weatherType === 2) dark += 0.1;
        if (weatherType === 3) dark += 0.05;
        dark = Math.min(0.7, dark);
        if (dark < 0.01) return;
        const r = weatherType === 3 ? 8 : 0;
        g.fillStyle = 'rgba(' + r + ',' + r + ',' + (weatherType === 3 ? 12 : 0) + ',' + dark + ')';
        g.fillRect(0, 0, w, h);
    }

    // --- Public API ---
    window.PoRacerRender = {
        setStatic(center, width, walls) {
            centerXY = new Float32Array(center); centerN = centerXY.length / 2;
            wallsXY = new Float32Array(walls); wallsM = wallsXY.length / 4;
            trackWidth = width; trackTex = null; minimapTex = null;
            parallaxFar = null; parallaxMid = null;
        },
        shake(intensity) { applyShake(intensity); },
        sparks(x, y, count) { emitSparks(x, y, count); },
        sparksBatch(buf, n) {
            for (let i = 0; i < n; i++) {
                const o = i * 3;
                emitSparks(buf[o], buf[o + 1], buf[o + 2]);
            }
        },
        setTimeOfDay(tod) { timeOfDay = tod; },
        setFogDensity(d) { fogDensity = d; },
        setBloom(enabled) { bloomEnabled = !!enabled; },
        clearParticles() { _jsSmoke.fill(0); _jsSmokeHead=0; _jsSkids.fill(0); _jsSkidHead=0; _jsWeather.fill(0); _jsWeatherHead=0; window._smokeSprite=null; },
        invalidateBitmaps() { grassTex=null; trackTex=null; minimapTex=null; parallaxFar=null; parallaxMid=null; bloomTex=null; bloomCtx=null; vignetteTex=null; fogTex=null; mainCtx_=null; mainCanvasEl=null; mainCanvasId_=null; miniCanvasEl=null; miniCanvasId_=null; },

        draw(mainCanvasId, miniCanvasId,
             w, h, camX, camY, scale,
             carBuf, carCount, carCols, carDark,
             trailBuf, trailN,
             smokeEvts, smokeEvtsN,
             skidEvts, skidEvtsN,
             dt,
             weatherType,
             shakeIntensity, tod, fogD)
        {
            // Cache canvas lookups — getElementById every frame is expensive
            if (mainCanvasId !== mainCanvasId_) { mainCanvasId_ = mainCanvasId; mainCanvasEl = document.getElementById(mainCanvasId); mainCtx_ = null; }
            const mainCanvas = mainCanvasEl;
            if (!mainCanvas) return;
            if (!mainCtx_) mainCtx_ = mainCanvas.getContext('2d'); // cache 2D context
            const g = mainCtx_;
            if (!g) return;
            if (miniCanvasId !== miniCanvasId_) { miniCanvasId_ = miniCanvasId; miniCanvasEl = miniCanvasId ? document.getElementById(miniCanvasId) : null; }
            const miniCanvas = miniCanvasEl;
            const miniCtx = miniCanvas ? miniCanvas.getContext('2d') : null;

            if (tod !== undefined) timeOfDay = tod;
            if (fogD !== undefined) fogDensity = fogD;

            if (shakeIntensity && shakeIntensity > 0.01) applyShake(shakeIntensity);
            updateShake(); updateSparks();

            // Process emission events from C# and update JS-owned pools
            if (smokeEvtsN > 0) for (let i=0; i<smokeEvtsN; i++) { const eo=i*6; addSmokeEvt(smokeEvts[eo],smokeEvts[eo+1],smokeEvts[eo+2],smokeEvts[eo+3],smokeEvts[eo+4],smokeEvts[eo+5]); }
            if (skidEvtsN > 0) for (let i=0; i<skidEvtsN; i++) { const eo=i*5; addSkidEvt(skidEvts[eo],skidEvts[eo+1],skidEvts[eo+2],skidEvts[eo+3],skidEvts[eo+4]); }
            updateSmoke(dt); updateSkids(dt); updateWeather(dt, weatherType, camX, camY, scale, w, h);

            if (Math.abs(shakeX) > 0.1 || Math.abs(shakeY) > 0.1) { g.save(); g.translate(shakeX, shakeY); }

            // Feature 4: Parallax backgrounds
            ensureParallaxLayers(w, h); ensureGrass(w, h);
            g.drawImage(grassTex, 0, 0, w, h);
            const farOffX = (camX * 0.3) % w, farOffY = (camY * 0.3) % h;
            g.globalAlpha = 0.5;
            g.drawImage(parallaxFar, -farOffX, -farOffY, w, h); g.drawImage(parallaxFar, w - farOffX, -farOffY, w, h);
            g.drawImage(parallaxFar, -farOffX, h - farOffY, w, h); g.drawImage(parallaxFar, w - farOffX, h - farOffY, w, h);
            const midOffX = (camX * 0.6) % w, midOffY = (camY * 0.6) % h;
            g.globalAlpha = 0.6;
            g.drawImage(parallaxMid, -midOffX, -midOffY, w, h); g.drawImage(parallaxMid, w - midOffX, -midOffY, w, h);
            g.drawImage(parallaxMid, -midOffX, h - midOffY, w, h); g.drawImage(parallaxMid, w -midOffX, h - midOffY, w, h);
            g.globalAlpha = 1.0;

            if (!centerXY) { if (miniCtx) miniCtx.clearRect(0, 0, miniCanvas.width, miniCanvas.height); if (shakeX || shakeY) g.restore(); return; }

            // Track — cached in world space, rebuilt only when zoom (scale)
            // changes (not when the camera pans). Blit at the camera-relative
            // position: the bitmap's (TRACK_MARGIN,TRACK_MARGIN) pixel is the
            // world point (trackOriginX, trackOriginY).
            if (!trackTex || Math.abs(trackScale - scale) > 0.001)
                buildTrackBitmap(scale);
            const [tox, toy] = project(trackOriginX, trackOriginY, camX, camY, scale, w, h);
            g.drawImage(trackTex, tox - TRACK_MARGIN, toy - TRACK_MARGIN);

            // Feature 6: Wall outlines — single batched path (was 312 stroke calls)
            if (wallsM > 0) {
                g.strokeStyle = 'rgba(255,80,80,0.3)'; g.lineWidth = 2; g.lineCap = 'round';
                g.beginPath();
                for (let i = 0; i < wallsM; i++) {
                    const idx = i * 4;
                    const hw = w * 0.5, hh = h * 0.5;
                    g.moveTo(hw + (wallsXY[idx]     - camX) * scale, hh + (wallsXY[idx + 1] - camY) * scale);
                    g.lineTo(hw + (wallsXY[idx + 2] - camX) * scale, hh + (wallsXY[idx + 3] - camY) * scale);
                }
                g.stroke();
            }

            // Skid marks — drawn from JS-owned pool
            drawSkids(g, camX, camY, scale, w, h);

            // Smoke — drawn from JS-owned pool
            drawSmoke(g, camX, camY, scale, w, h);

            // Feature 2: Sparks
            drawSparks(g, camX, camY, scale, w, h);

            // Weather — drawn from JS-owned pool
            drawWeather(g, camX, camY, scale, w, h, weatherType);

            // Trails — 1 batched path per car (was 1 stroke per segment)
            if (trailN > 0) {
                g.lineWidth = 2; g.globalAlpha = 0.3; g.setLineDash([5, 5]);
                const hw = w * 0.5, hh = h * 0.5;
                let offset = 0;
                for (let i = 0; i < carCount; i++) {
                    const end = Math.min(offset + 20, trailN);
                    g.strokeStyle = cachedColor(carCols[i]);
                    g.beginPath();
                    for (let j = offset; j + 3 < end; j += 2) {
                        g.moveTo(hw + (trailBuf[j]     - camX) * scale, hh + (trailBuf[j + 1] - camY) * scale);
                        g.lineTo(hw + (trailBuf[j + 2] - camX) * scale, hh + (trailBuf[j + 3] - camY) * scale);
                    }
                    g.stroke();
                    offset += 20; if (offset >= trailN) break;
                }
                g.setLineDash([]); g.globalAlpha = 1.0;
            }

            // Cars — cachedColor avoids rgb() string allocation per car
            for (let i = 0; i < carCount; i++) {
                const o = i * 6;
                drawCar(g, { camX, camY, scale, w, h, hdg: carBuf[o + 2] },
                    carBuf[o], carBuf[o + 1], cachedColor(carCols[i]), cachedColor(carDark[i]),
                    carBuf[o + 3], carBuf[o + 4] !== 0, carBuf[o + 5], 0, carBuf[o + 5]);
            }

            // Feature 1: Ambient
            drawAmbientOverlay(g, w, h, timeOfDay, weatherType);

            // Feature 10: Fog
            drawFog(g, w, h, fogDensity);

            // Feature 5: Speed lines
            for (let i = 0; i < carCount; i++) { const o = i * 6; if (carBuf[o + 4] !== 0) { drawSpeedLines(g, w, h, Math.abs(carBuf[o + 3]) * 1.2, 340); break; } }

            // Feature 8: Post-processing
            drawVignette(g, w, h);
            if (bloomEnabled) drawBloom(g, w, h);

            if (shakeX || shakeY) g.restore();

            // Minimap
            if (miniCtx) {
                if (!minimapTex) buildMinimapBitmap();
                miniCtx.clearRect(0, 0, miniCanvas.width, miniCanvas.height); miniCtx.drawImage(minimapTex, 0, 0, 180, 180);
                if (minimapBbox) { const { minX, minY, s, ox, oy } = minimapBbox; const toX = (x) => ox + (x - minX) * s, toY = (y) => oy + (y - minY) * s; for (let i = 0; i < carCount; i++) { const o = i * 6; const col = cachedColor(carCols[i]); miniCtx.fillStyle = col; miniCtx.shadowColor = col; miniCtx.shadowBlur = 6; miniCtx.beginPath(); miniCtx.arc(toX(carBuf[o]), toY(carBuf[o + 1]), carBuf[o + 4] !== 0 ? 4 : 3, 0, Math.PI * 2); miniCtx.fill(); } miniCtx.shadowBlur = 0; }
            }
        }
    };

    // Polyfill
    if (CanvasRenderingContext2D.prototype.roundRect == null) {
        CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
            if (typeof r === 'number') r = [r, r, r, r];
            this.beginPath(); this.moveTo(x + r[0], y); this.lineTo(x + w - r[1], y); this.quadraticCurveTo(x + w, y, x + w, y + r[1]); this.lineTo(x + w, y + h - r[2]); this.quadraticCurveTo(x + w, y + h, x + w - r[2], y + h); this.lineTo(x + r[3], y + h); this.quadraticCurveTo(x, y + h, x, y + h - r[3]); this.lineTo(x, y + r[0]); this.quadraticCurveTo(x, y, x + r[0], y); this.closePath(); return this;
        };
    }
})();
