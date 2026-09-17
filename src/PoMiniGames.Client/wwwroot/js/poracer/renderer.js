// Canvas scene renderer. Lifecycle is owned by index.js.
(function () {
    /** @type {Float32Array|null} */ let centerXY = null;
    /** @type {Float32Array|null} */ let wallsXY = null;
    let centerN = 0, wallsM = 0, trackWidth = 0;
    let currentTheme = 'circuit';
    let boostPadsData = [];
    let surfaceZonesData = [];
    let parallaxTheme = null;
    let grassTheme = null;

    let grassTex = null, grassW = 0, grassH = 0, grassDpr = 0;
    // Track is cached in WORLD space (origin = bbox min) at a given scale, then
    // blitted with a camera offset each frame. trackOriginX/Y is the world
    // coordinate that maps to the bitmap's TRACK_MARGIN,TRACK_MARGIN pixel.
    const TRACK_MARGIN = 64;
    let trackTex = null, trackTexW = 0, trackTexH = 0;
    let trackOriginX = 0, trackOriginY = 0, trackScale = 1;
    // trackTexCssW/H: the bitmap's size in CSS pixels, which is what the blit needs
    // now that its backing store is trackDpr times that. trackReqDpr is the dpr draw()
    // last asked for — the rebuild key, kept separate from the trackDpr actually
    // granted, because the area budget can hand back less and a key that never
    // matches would rebuild the whole track every frame.
    let trackTexCssW = 0, trackTexCssH = 0, trackDpr = 0, trackReqDpr = 0;

    // Cached canvas references (avoid getElementById every frame)
    let mainCanvasEl = null, mainCanvasId_ = null;
    let mainCtx_ = null; // cached 2D context
    let miniCanvasEl = null, miniCanvasId_ = null;
    // Cached vignette gradient (recreated only on resize)
    let vignetteTex = null, vignetteW = 0, vignetteH = 0, vignetteDpr = 0;
    // Cached fog texture (recreated only on resize)
    let fogTex = null, fogTexW = 0, fogTexH = 0, fogDpr = 0;

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
    let parallaxFar = null, parallaxMid = null, parallaxW = 0, parallaxH = 0, parallaxDpr = 0;

    // Feature 3: Screen shake
    let shakeX = 0, shakeY = 0, shakeDecay = 0;

    // Spectator follow-cam smoothing (demo/no-local-player). Tracks the race
    // leader; lerped so leadership changes and marshal rescues pan smoothly
    // instead of snapping. Reset to null on setStatic (new race geometry).
    let _specCamX = null, _specCamY = null;

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

    // 2026-08-10: full-screen layers (grass, both parallax planes, fog, vignette)
    // are cached as offscreen bitmaps and blitted with drawImage(tex, 0, 0, w, h).
    // `w`/`h` are CSS pixels — draw() takes them from PoRacer.getSize(), which
    // returns clientWidth/clientHeight — while the destination context carries a
    // setTransform(dpr, ...). So a bitmap built at the CSS size was stretched over
    // w*dpr x h*dpr device pixels and the browser upscaled it. Those layers cover
    // essentially the whole frame, so on any HiDPI screen the picture read as out
    // of focus even though the track and cars (vector-drawn straight into the
    // scaled context) stayed sharp. It was worst where it was most visible: the
    // spectator camera frames mostly background.
    //
    // Build them at the BACKING-STORE size and pre-apply the same dpr transform,
    // so every drawing call below still works in CSS units and the blit lands 1:1
    // on device pixels. dpr belongs in each layer's cache key too — a window
    // dragged between monitors of different scaling changes it without changing
    // the CSS size, which would otherwise keep a stale, wrong-resolution bitmap.
    function createLayer(w, h, dpr) {
        const c = createOffscreen(Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr)));
        const ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { canvas: c, ctx: ctx };
    }

    /** Backing-store pixels per CSS pixel for the context being drawn into. The
     *  canvas element is the single source of truth here, so this cannot drift
     *  from whatever resize() last decided (see PoCanvasDpr). */
    function dprOf(g, w) {
        const c = g && g.canvas;
        return (c && w > 0 && c.width > 0) ? c.width / w : 1;
    }
    function packColor(hex) {
        if (!hex || hex[0] !== '#' || hex.length < 7) return 0xffffff;
        return (parseInt(hex.substr(1, 2), 16) << 16)
             | (parseInt(hex.substr(3, 2), 16) << 8)
             |  parseInt(hex.substr(5, 2), 16);
    }
    function mulberry32(seed) {
        let a = seed;
        return function() { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    }

    // --- Feature 4: Parallax layers ---
    function ensureParallaxLayers(w, h, dpr) {
        if (parallaxW === w && parallaxH === h && parallaxDpr === dpr && parallaxFar && parallaxMid && parallaxTheme === currentTheme) return;
        parallaxW = w; parallaxH = h; parallaxDpr = dpr; parallaxTheme = currentTheme;
        const farLayer = createLayer(w, h, dpr);
        const farOff = farLayer.canvas;
        const farCtx = farLayer.ctx;

        if (currentTheme === 'neonskyline') {
            const farGrad = farCtx.createLinearGradient(0, 0, 0, h);
            farGrad.addColorStop(0, 'rgba(6, 8, 16, 0.9)'); farGrad.addColorStop(1, 'rgba(22, 10, 36, 0.95)');
            farCtx.fillStyle = farGrad; farCtx.fillRect(0, 0, w, h);
            const rng = mulberry32(101);
            for (let i = 0; i < 26; i++) {
                const bw = 24 + rng() * 50, bx = rng() * (w + 40) - 20, bh = 60 + rng() * 120, by = h - bh;
                farCtx.fillStyle = 'rgba(12, 16, 28, 0.85)'; farCtx.fillRect(bx, by, bw, bh);
                const neonCol = rng() > 0.5 ? 'rgba(0, 240, 255, 0.7)' : 'rgba(255, 0, 128, 0.7)';
                farCtx.fillStyle = neonCol; farCtx.fillRect(bx + bw * 0.45, by - 10, 3, 10);
                for (let wy = by + 8; wy < h - 10; wy += 12) {
                    for (let wx = bx + 4; wx < bx + bw - 4; wx += 9) {
                        if (rng() > 0.65) {
                            farCtx.fillStyle = rng() > 0.4 ? 'rgba(0, 240, 255, 0.4)' : 'rgba(255, 230, 100, 0.45)';
                            farCtx.fillRect(wx, wy, 3, 5);
                        }
                    }
                }
            }
            parallaxFar = farOff;

            const midLayer = createLayer(w, h, dpr);
            const midOff = midLayer.canvas;
            const midCtx = midLayer.ctx;
            const rng2 = mulberry32(202);
            for (let i = 0; i < 18; i++) {
                const mx = rng2() * w, my = h * 0.35 + rng2() * (h * 0.45), mw = 30 + rng2() * 50, mh = 12 + rng2() * 18;
                midCtx.fillStyle = 'rgba(18, 22, 38, 0.7)'; midCtx.fillRect(mx, my, mw, mh);
                midCtx.strokeStyle = rng2() > 0.5 ? 'rgba(0, 240, 255, 0.6)' : 'rgba(255, 0, 128, 0.6)';
                midCtx.lineWidth = 1.5; midCtx.strokeRect(mx, my, mw, mh);
            }
            parallaxMid = midOff;
        } else if (currentTheme === 'desertdustway') {
            const farGrad = farCtx.createLinearGradient(0, 0, 0, h);
            farGrad.addColorStop(0, 'rgba(90, 48, 20, 0.5)'); farGrad.addColorStop(0.5, 'rgba(145, 85, 38, 0.6)'); farGrad.addColorStop(1, 'rgba(185, 115, 55, 0.7)');
            farCtx.fillStyle = farGrad; farCtx.fillRect(0, 0, w, h);
            farCtx.fillStyle = 'rgba(100, 52, 22, 0.65)';
            const rng = mulberry32(303);
            for (let i = 0; i < 16; i++) {
                const tx = rng() * (w + 100) - 50, ty = h * 0.35 + rng() * (h * 0.35), tw = 60 + rng() * 100;
                farCtx.beginPath(); farCtx.moveTo(tx - tw * 0.5, h); farCtx.lineTo(tx - tw * 0.32, ty); farCtx.lineTo(tx + tw * 0.32, ty); farCtx.lineTo(tx + tw * 0.5, h); farCtx.closePath(); farCtx.fill();
            }
            parallaxFar = farOff;

            const midLayer = createLayer(w, h, dpr);
            const midOff = midLayer.canvas;
            const midCtx = midLayer.ctx;
            midCtx.fillStyle = 'rgba(125, 70, 30, 0.45)';
            const rng2 = mulberry32(404);
            for (let i = 0; i < 40; i++) { midCtx.beginPath(); midCtx.arc(rng2() * w, rng2() * h, 5 + rng2() * 15, 0, Math.PI * 2); midCtx.fill(); }
            parallaxMid = midOff;
        } else {
            const farGrad = farCtx.createLinearGradient(0, 0, 0, h);
            farGrad.addColorStop(0, 'rgba(8,20,12,0.3)'); farGrad.addColorStop(1, 'rgba(4,10,6,0.5)');
            farCtx.fillStyle = farGrad; farCtx.fillRect(0, 0, w, h);
            farCtx.fillStyle = 'rgba(15,35,20,0.4)';
            const rng = mulberry32(42);
            for (let i = 0; i < 40; i++) { const tx = rng() * w, ty = rng() * h * 0.6 + h * 0.2, th = 20 + rng() * 40, tw = 10 + rng() * 15; farCtx.beginPath(); farCtx.moveTo(tx, ty); farCtx.lineTo(tx - tw, ty + th); farCtx.lineTo(tx + tw, ty + th); farCtx.closePath(); farCtx.fill(); }
            parallaxFar = farOff;

            const midLayer = createLayer(w, h, dpr);
            const midOff = midLayer.canvas;
            const midCtx = midLayer.ctx;
            midCtx.fillStyle = 'rgba(20,50,30,0.25)';
            const rng2 = mulberry32(99);
            for (let i = 0; i < 60; i++) { midCtx.beginPath(); midCtx.arc(rng2() * w, rng2() * h, 4 + rng2() * 12, 0, Math.PI * 2); midCtx.fill(); }
            midCtx.fillStyle = 'rgba(60,65,70,0.2)';
            for (let i = 0; i < 25; i++) { midCtx.fillRect(rng2() * w, rng2() * h, 3 + rng2() * 5, 2 + rng2() * 3); }
            parallaxMid = midOff;
        }
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
    function drawVignette(g, w, h, dpr) {
        if (!vignetteTex || vignetteW !== w || vignetteH !== h || vignetteDpr !== dpr) {
            vignetteW = w; vignetteH = h; vignetteDpr = dpr;
            const layer = createLayer(w, h, dpr);
            vignetteTex = layer.canvas;
            const vc = layer.ctx;
            const vg = vc.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.8);
            vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.6)');
            vc.fillStyle = vg; vc.fillRect(0, 0, w, h);
        }
        g.drawImage(vignetteTex, 0, 0, w, h);
    }
    // Bloom: cached context and half-res offscreen to cut filter cost ~4x
    let bloomCtx = null;
    function drawBloom(g, w, h, dpr) {
        // Half of the BACKING-STORE size, not half the CSS size. At the CSS size the
        // surface was (w*dpr)/2 device pixels wide and then stretched back over w*dpr,
        // so the round trip cost a factor of 2*dpr rather than the intended 2. Bloom is
        // deliberately soft, so this mattered less than the layers above — but it is the
        // same mistake and it compounds with them. Still a quarter of the pixels of a
        // full-resolution pass, so the 4x saving the half-res trick buys is unchanged.
        const hw = Math.max(1, Math.round(w * dpr) >> 1), hh = Math.max(1, Math.round(h * dpr) >> 1);
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
    function drawFog(g, w, h, density, dpr) {
        if (density < 0.01) return;
        if (!fogTex || fogTexW !== w || fogTexH !== h || fogDpr !== dpr) {
            fogTexW = w; fogTexH = h; fogDpr = dpr;
            const layer = createLayer(w, h, dpr);
            fogTex = layer.canvas;
            const fc = layer.ctx;
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
    function ensureGrass(w, h, dpr) {
        if (grassTex && grassW === w && grassH === h && grassDpr === dpr && grassTheme === currentTheme) return;
        const layer = createLayer(w, h, dpr), off = layer.canvas, g = layer.ctx;
        grassDpr = dpr; grassTheme = currentTheme;

        if (currentTheme === 'neonskyline') {
            const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
            grad.addColorStop(0, '#0c0e18'); grad.addColorStop(0.5, '#07080f'); grad.addColorStop(1, '#030408');
            g.fillStyle = grad; g.fillRect(0, 0, w, h);

            g.strokeStyle = 'rgba(0, 240, 255, 0.08)'; g.lineWidth = 1;
            for (let x = 0; x < w; x += 36) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
            for (let y = 0; y < h; y += 36) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }

            g.fillStyle = 'rgba(255, 0, 128, 0.14)';
            for (let y = 0; y < h; y += 72) {
                for (let x = 0; x < w; x += 72) { g.fillRect(x - 1.5, y - 1.5, 3, 3); }
            }
        } else if (currentTheme === 'desertdustway') {
            const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
            grad.addColorStop(0, '#a3713f'); grad.addColorStop(0.5, '#82542a'); grad.addColorStop(1, '#573315');
            g.fillStyle = grad; g.fillRect(0, 0, w, h);

            g.fillStyle = 'rgba(240, 195, 130, 0.14)';
            for (let y = 0; y < h; y += 20) {
                for (let x = (y % 40 === 0 ? 0 : 10); x < w; x += 20) { g.fillRect(x, y, 2.5, 2.5); }
            }
        } else {
            const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
            grad.addColorStop(0, '#1f5a2f'); grad.addColorStop(0.5, '#163f20'); grad.addColorStop(1, '#0c2412');
            g.fillStyle = grad; g.fillRect(0, 0, w, h);
            g.fillStyle = 'rgba(140,200,120,0.08)';
            for (let y = 0; y < h; y += 22) for (let x = 0; x < w; x += 22) g.fillRect(x, y, 2, 2);
        }
        grassTex = off; grassW = w; grassH = h;
    }

    function getTrackHeadingAt(x, y) {
        if (!centerXY || centerN < 2) return 0;
        let bestDist = 1e9, bestIdx = 0;
        for (let i = 0; i < centerN; i++) {
            const dx = centerXY[i * 2] - x, dy = centerXY[i * 2 + 1] - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
        }
        const prev = (bestIdx - 1 + centerN) % centerN;
        const next = (bestIdx + 1) % centerN;
        return Math.atan2(centerXY[next * 2 + 1] - centerXY[prev * 2 + 1], centerXY[next * 2] - centerXY[prev * 2]);
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
    function buildTrackBitmap(scale, dpr) {
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

        // Same CSS-vs-device mismatch as the full-screen layers, and the one that hurt
        // most: the asphalt, curbs and rumble strips ARE the subject of the frame. The
        // blit below (see draw()) had no destination size, so one bitmap pixel became
        // one CSS pixel and the whole track was upscaled by dpr.
        //
        // Unlike those layers this bitmap is sized to the track's bounding box at the
        // current zoom, not to the viewport, so it can be far larger than the screen —
        // squaring dpr into it without a limit risks a canvas the browser refuses to
        // allocate, and a failed allocation here means no track at all. Cap the extra
        // resolution by area and fall back toward 1x rather than overshooting; the
        // texture keeps its CSS-space coordinate system either way, so nothing below
        // this line needs to know which happened.
        const TRACK_TEX_BUDGET = 24e6;   // ~24 Mpx, comfortably inside browser limits
        const reqDpr = Math.max(1, dpr || 1);
        let texDpr = reqDpr;
        const over = (texW * texH * texDpr * texDpr) / TRACK_TEX_BUDGET;
        if (over > 1) texDpr = Math.max(1, texDpr / Math.sqrt(over));
        trackDpr = texDpr;          // what we actually got
        trackReqDpr = reqDpr;       // what draw() asked for; the rebuild key
        trackTexCssW = texW; trackTexCssH = texH;

        const off = createOffscreen(Math.max(1, Math.round(texW * texDpr)), Math.max(1, Math.round(texH * texDpr)));
        const g = off.getContext('2d');
        g.setTransform(texDpr, 0, 0, texDpr, 0, 0);
        const wpx = trackWidth * scale;

        // Base asphalt
        g.beginPath();
        for (let i = 0; i <= centerN; i++) { const [sx, sy] = trackTx(centerXY[(i % centerN) * 2], centerXY[(i % centerN) * 2 + 1]); if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy); }
        g.closePath();
        const grad = g.createLinearGradient(0, 0, texW, texH);
        if (currentTheme === 'neonskyline') {
            grad.addColorStop(0, '#161922'); grad.addColorStop(0.5, '#10121a'); grad.addColorStop(1, '#090b10');
        } else if (currentTheme === 'desertdustway') {
            grad.addColorStop(0, '#554230'); grad.addColorStop(0.5, '#423324'); grad.addColorStop(1, '#2f2216');
        } else {
            grad.addColorStop(0, '#3d424a'); grad.addColorStop(0.5, '#2a2e36'); grad.addColorStop(1, '#1f242c');
        }
        g.fillStyle = grad; g.fill();

        // Feature 6: Rumble strips + curbs
        g.save();
        g.beginPath();
        for (let i = 0; i <= centerN; i++) { const [sx, sy] = trackTx(centerXY[(i % centerN) * 2], centerXY[(i % centerN) * 2 + 1]); if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy); }
        g.closePath();
        g.lineJoin = 'round'; g.lineCap = 'round';
        if (currentTheme === 'neonskyline') {
            g.strokeStyle = '#ff007f'; g.lineWidth = wpx + 14; g.stroke();
            g.strokeStyle = '#00f0ff'; g.lineWidth = wpx + 10; g.stroke();
            g.setLineDash([8, 8]); g.strokeStyle = 'rgba(0,240,255,0.75)'; g.lineWidth = wpx + 2; g.stroke(); g.setLineDash([]);
        } else if (currentTheme === 'desertdustway') {
            g.strokeStyle = '#b85d19'; g.lineWidth = wpx + 14; g.stroke();
            g.strokeStyle = '#f3cf7a'; g.lineWidth = wpx + 10; g.stroke();
            g.setLineDash([6, 6]); g.strokeStyle = 'rgba(180,100,30,0.6)'; g.lineWidth = wpx + 2; g.stroke(); g.setLineDash([]);
        } else {
            g.strokeStyle = '#cc2222'; g.lineWidth = wpx + 14; g.stroke();
            g.strokeStyle = '#ffffff'; g.lineWidth = wpx + 10; g.stroke();
            g.setLineDash([6, 6]); g.strokeStyle = 'rgba(200,60,60,0.5)'; g.lineWidth = wpx + 2; g.stroke(); g.setLineDash([]);
        }
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

        // Surface Zones (e.g. sand drift zones)
        if (surfaceZonesData && surfaceZonesData.length > 0) {
            for (let i = 0; i < surfaceZonesData.length; i++) {
                const zone = surfaceZonesData[i];
                if (!zone || !zone.radius) continue;
                const isSand = zone.surfaceType === 'sand' || (zone.name && zone.name.toLowerCase().includes('sand')) || (zone.name && zone.name.toLowerCase().includes('dune'));
                if (isSand) {
                    const [zx, zy] = trackTx(zone.x, zone.y);
                    const zr = zone.radius * scale;
                    const sandGrad = g.createRadialGradient(zx, zy, zr * 0.15, zx, zy, zr);
                    sandGrad.addColorStop(0, 'rgba(224, 182, 114, 0.85)');
                    sandGrad.addColorStop(0.65, 'rgba(196, 149, 82, 0.7)');
                    sandGrad.addColorStop(0.9, 'rgba(168, 122, 58, 0.35)');
                    sandGrad.addColorStop(1, 'rgba(140, 96, 40, 0)');
                    g.save();
                    g.fillStyle = sandGrad;
                    g.beginPath();
                    g.arc(zx, zy, zr, 0, Math.PI * 2);
                    g.fill();
                    g.strokeStyle = 'rgba(245, 210, 150, 0.3)';
                    g.lineWidth = 2.5;
                    for (let r = zr * 0.25; r < zr * 0.8; r += 16) {
                        g.beginPath();
                        g.arc(zx, zy, r, 0.2, Math.PI * 1.6);
                        g.stroke();
                    }
                    g.restore();
                }
            }
        }

        // Boost Pads
        if (boostPadsData && boostPadsData.length > 0) {
            for (let i = 0; i < boostPadsData.length; i++) {
                const pad = boostPadsData[i];
                if (!pad) continue;
                const [px, py] = trackTx(pad.x, pad.y);
                const pr = (pad.radius || 45) * scale;
                const angle = (pad.directionAngle && Math.abs(pad.directionAngle) > 0.001)
                    ? pad.directionAngle
                    : getTrackHeadingAt(pad.x, pad.y);

                g.save();
                g.translate(px, py);
                g.rotate(angle);

                const padGrad = g.createRadialGradient(0, 0, 2, 0, 0, pr);
                if (currentTheme === 'neonskyline') {
                    padGrad.addColorStop(0, 'rgba(0, 240, 255, 0.95)');
                    padGrad.addColorStop(0.6, 'rgba(0, 150, 255, 0.65)');
                    padGrad.addColorStop(1, 'rgba(0, 50, 120, 0)');
                } else if (currentTheme === 'desertdustway') {
                    padGrad.addColorStop(0, 'rgba(255, 180, 0, 0.95)');
                    padGrad.addColorStop(0.6, 'rgba(255, 120, 0, 0.65)');
                    padGrad.addColorStop(1, 'rgba(180, 50, 0, 0)');
                } else {
                    padGrad.addColorStop(0, 'rgba(0, 255, 180, 0.95)');
                    padGrad.addColorStop(0.6, 'rgba(0, 180, 220, 0.65)');
                    padGrad.addColorStop(1, 'rgba(0, 80, 100, 0)');
                }
                g.fillStyle = padGrad;
                g.beginPath();
                g.roundRect(-pr, -pr * 0.5, pr * 2, pr, 8);
                g.fill();

                const arrowCol = currentTheme === 'neonskyline' ? '#00ffff' : currentTheme === 'desertdustway' ? '#ffe066' : '#55ffff';
                g.strokeStyle = arrowCol;
                g.shadowColor = arrowCol;
                g.shadowBlur = 8;
                g.lineWidth = 3.5;
                g.lineCap = 'round';
                g.lineJoin = 'round';
                for (let c = -1; c <= 1; c++) {
                    const cx = c * (pr * 0.45);
                    g.beginPath();
                    g.moveTo(cx - 8, -pr * 0.32);
                    g.lineTo(cx + 8, 0);
                    g.lineTo(cx - 8, pr * 0.32);
                    g.stroke();
                }
                g.restore();
            }
        }

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
        g.setLineDash([14, 14]);
        if (currentTheme === 'neonskyline') {
            g.strokeStyle = 'rgba(0,240,255,0.7)'; g.shadowColor = '#00f0ff'; g.shadowBlur = 6; g.lineWidth = 2.5;
        } else if (currentTheme === 'desertdustway') {
            g.strokeStyle = 'rgba(240,225,180,0.5)'; g.shadowBlur = 0; g.lineWidth = 2;
        } else {
            g.strokeStyle = 'rgba(255,255,255,0.55)'; g.shadowBlur = 0; g.lineWidth = 2;
        }
        g.beginPath();
        for (let i = 0; i < centerN; i++) { const [sx, sy] = trackTx(centerXY[i * 2], centerXY[i * 2 + 1]); if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy); }
        g.closePath(); g.stroke(); g.setLineDash([]); g.shadowBlur = 0;

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
        g.clearRect(0, 0, w, h);
        if (currentTheme === 'neonskyline') {
            g.fillStyle = 'rgba(10,12,24,0.92)';
        } else if (currentTheme === 'desertdustway') {
            g.fillStyle = 'rgba(42,28,16,0.92)';
        } else {
            g.fillStyle = 'rgba(20,30,48,0.9)';
        }
        g.fillRect(0, 0, w, h);
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (let i = 0; i < centerN; i++) { const x = centerXY[i * 2], y = centerXY[i * 2 + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        const pad = trackWidth * 0.7; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
        const sx = (w - 12) / (maxX - minX), sy = (h - 12) / (maxY - minY), s = Math.min(sx, sy);
        const ox = (w - (maxX - minX) * s) / 2, oy = (h - (maxY - minY) * s) / 2;
        const toX = (x) => ox + (x - minX) * s, toY = (y) => oy + (y - minY) * s;
        g.strokeStyle = currentTheme === 'neonskyline' ? '#1c0828' : currentTheme === 'desertdustway' ? '#22150a' : '#0a1424';
        g.lineWidth = trackWidth * s + 4; g.lineJoin = 'round';
        g.beginPath(); for (let i = 0; i <= centerN; i++) { const [x, y] = [toX(centerXY[(i % centerN) * 2]), toY(centerXY[(i % centerN) * 2 + 1])]; if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); } g.closePath(); g.stroke();
        g.strokeStyle = currentTheme === 'neonskyline' ? '#00f0ff' : currentTheme === 'desertdustway' ? '#e0a860' : '#9bb1cc';
        g.lineWidth = 1.2;
        g.beginPath(); for (let i = 0; i < centerN; i++) { const x = toX(centerXY[i * 2]), y = toY(centerXY[i * 2 + 1]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); } g.closePath(); g.stroke();
        minimapTex = off; minimapBbox = { minX, minY, s, ox, oy };
    }

    // --- Feature 7: Enhanced car drawing ---
    function drawCar(g, c, cx, cy, color, colorDark, boost, isPlayer, speedRatio, skidInt, livery) {
        const [sx, sy] = project(cx, cy, c.camX, c.camY, c.scale, c.w, c.h);
        g.save(); g.translate(sx, sy); g.rotate(c.hdg); g.scale(c.scale, c.scale);

        // Feature 1: Soft shadow
        g.save(); g.translate(4, 6); g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(0, 0, 20, 12, 0, 0, Math.PI * 2); g.fill(); g.restore();

        // Car body — flat fill + dark overlay (no createLinearGradient)
        g.fillStyle = color; g.beginPath(); g.roundRect(-16, -9, 32, 18, 5); g.fill();
        g.fillStyle = colorDark; g.globalAlpha = 0.4; g.beginPath(); g.roundRect(0, -9, 16, 18, [0, 5, 5, 0]); g.fill(); g.globalAlpha = 1;
        g.shadowBlur = 0; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1.2;
        g.beginPath(); g.roundRect(-16, -9, 32, 18, 5); g.stroke();

        // Livery pattern
        const liv = livery || 'stripe';
        if (liv === 'dual') {
            g.fillStyle = 'rgba(255,255,255,0.85)';
            g.fillRect(-14, -4.5, 28, 1.8);
            g.fillRect(-14, 2.7, 28, 1.8);
        } else if (liv === 'carbon') {
            g.fillStyle = 'rgba(25,25,30,0.7)';
            g.fillRect(-14, -7, 10, 14);
            g.fillRect(8, -8, 6, 16);
            g.fillStyle = 'rgba(255,255,255,0.6)';
            g.fillRect(-14, -1, 28, 2);
        } else if (liv === 'neon') {
            g.strokeStyle = '#00ffff'; g.shadowColor = '#00ffff'; g.shadowBlur = 6; g.lineWidth = 1.5;
            g.strokeRect(-12, -7, 24, 14);
            g.shadowBlur = 0;
            g.fillStyle = '#ff007f';
            g.fillRect(-14, -1.2, 28, 2.4);
        } else {
            g.fillStyle = 'rgba(255,255,255,0.85)';
            g.fillRect(-14, -1.2, 28, 2.4);
        }

        // Windshield
        g.fillStyle = 'rgba(20,30,45,0.85)'; g.beginPath(); g.roundRect(2, -7, 8, 14, 2); g.fill();

        // Headlight/taillight glows, beam cones and exhaust flames removed
        // 2026-09-17 (user request): the cars should read as flat shapes, not
        // light sources. Skid marks still communicate drift and braking.
        g.restore();
    }

    // --- Feature 1: Ambient overlay ---
    function drawPlayerMarker(g, c, camX, camY, scale, w, h) {
        const [x, y] = project(c.x, c.y, camX, camY, scale, w, h);
        g.save();
        // Decorative ellipse ring removed 2026-09-17 (user request). The label
        // stays: it is the only thing that identifies your car in a full grid.
        g.fillStyle = '#06111f'; g.beginPath(); g.roundRect(x - 25, y - 53, 50, 24, 7); g.fill();
        g.fillStyle = '#ffffff'; g.font = 'bold 13px system-ui'; g.textAlign = 'center';
        g.fillText('YOU', x, y - 36);
        g.beginPath(); g.moveTo(x - 5, y - 27); g.lineTo(x + 5, y - 27); g.lineTo(x, y - 22); g.fill();
        g.restore();
    }

    // drawGhost removed 2026-09-17 (user request) along with the lapCoach that
    // fed it — the best-lap ghost car is gone entirely.

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
        dispose() {
            centerXY = wallsXY = null;
            mainCanvasEl = miniCanvasEl = mainCtx_ = null;
            mainCanvasId_ = miniCanvasId_ = null;
            trackTex = minimapTex = grassTex = parallaxFar = parallaxMid = null;
            _specCamX = _specCamY = null;
            bloomTex = bloomCtx = vignetteTex = fogTex = null;
            _colorCache.clear();
            sparkCount = 0;
        },
        setStatic(center, width, walls, boostPads, surfaceZones, theme) {
            centerXY = new Float32Array(center); centerN = centerXY.length / 2;
            wallsXY = new Float32Array(walls); wallsM = wallsXY.length / 4;
            trackWidth = width;
            boostPadsData = Array.isArray(boostPads) ? boostPads : [];
            surfaceZonesData = Array.isArray(surfaceZones) ? surfaceZones : [];
            currentTheme = (typeof theme === 'string' && theme) ? theme.toLowerCase() : 'circuit';
            window.PoRacerCurrentTheme = currentTheme;
            trackTex = null; minimapTex = null;
            grassTex = null; parallaxFar = null; parallaxMid = null;
            grassTheme = null; parallaxTheme = null;
            _specCamX = null; _specCamY = null;
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
        // Also clears the per-layer dpr keys. resize() calls this when the backing
        // store changes, which is exactly when those keys are stale.
        invalidateBitmaps() { grassTex=null; trackTex=null; trackReqDpr=0; trackDpr=0; minimapTex=null; parallaxFar=null; parallaxMid=null; bloomTex=null; bloomCtx=null; vignetteTex=null; fogTex=null; grassDpr=0; parallaxDpr=0; vignetteDpr=0; fogDpr=0; grassTheme=null; parallaxTheme=null; mainCtx_=null; mainCanvasEl=null; mainCanvasId_=null; miniCanvasEl=null; miniCanvasId_=null; },

        // drawSnapshot — multiplayer thin-client entry point. Server pushes
        // a snapshot every ~50ms; we compute the camera and render in one call.
        // `cars` is an array of { x, y, h, v, color, colorDark, isPlayer, name, lap, position, finished, boost, skid }.
        drawSnapshot(mainCanvasId, miniCanvasId, elapsedSec, weather, cars) {
            if (!mainCanvasId) return;
            if (mainCanvasId !== mainCanvasId_) { mainCanvasId_ = mainCanvasId; mainCanvasEl = document.getElementById(mainCanvasId); mainCtx_ = null; }
            const mainCanvas = mainCanvasEl;
            if (!mainCanvas) return;
            if (!mainCtx_) mainCtx_ = mainCanvas.getContext('2d');
            const g = mainCtx_;
            if (!g || !cars || cars.length === 0) return;
            if (miniCanvasId !== miniCanvasId_ || !miniCanvasEl) { miniCanvasId_ = miniCanvasId; miniCanvasEl = miniCanvasId ? document.getElementById(miniCanvasId) : null; }
            const miniCanvas = miniCanvasEl;
            const miniCtx = miniCanvas ? miniCanvas.getContext('2d') : null;

            // resize() + lastSize live in the sibling PoRacer IIFE (out of scope
            // here). Route through its public accessor, which resizes the shared
            // canvas backing store and returns the CSS size. Referencing the
            // private symbols directly threw ReferenceError, which OnSnapshot's
            // try/catch swallowed → blank canvas with a live HUD.
            const size = (window.PoRacer && window.PoRacer.getSize)
                ? window.PoRacer.getSize()
                : { w: mainCanvas.clientWidth, h: mainCanvas.clientHeight };
            const w = size.w, h = size.h;
            const player = cars.find(c => c.isPlayer);
            let camX, camY, scale;
            if (!player && centerXY && centerN > 0) {
                // Spectator / demo view: follow target car or leader
                const targetCar = cars.reduce((leader, car) => car.position < leader.position ? car : leader, cars[0]);
                let targetX = targetCar.x + Math.cos(targetCar.h) * 80;
                let targetY = targetCar.y + Math.sin(targetCar.h) * 80;

                if (_specCamX === null || Math.hypot(targetX - _specCamX, targetY - _specCamY) > 3000) {
                    _specCamX = targetX; _specCamY = targetY;
                } else {
                    _specCamX += (targetX - _specCamX) * 0.18;
                    _specCamY += (targetY - _specCamY) * 0.18;
                }
                camX = _specCamX; camY = _specCamY;

                const baseScale = Math.min(w, h) / 900;
                scale = Math.max(0.35, Math.min(1.2, baseScale * 1.1));
            } else {
                // Follow-cam on the local player: zoom in so their car and the cars
                // around them (for collisions) are clearly visible.
                const target = player || cars[0];
                const lookAhead = Math.cos(target.h) * 80;
                camX = target.x + lookAhead;
                camY = target.y + Math.sin(target.h) * 80;
                const baseScale = Math.min(w, h) / 900;
                scale = Math.max(0.25, Math.min(1.2, baseScale));
            }
            const dt = 0.05; // snapshot interval ≈ 50ms

            // Pack cars into Float32Arrays the existing draw() expects.
            const carBuf = new Float32Array(cars.length * 6);
            const carCols = new Int32Array(cars.length);
            const carDark = new Int32Array(cars.length);
            for (let i = 0; i < cars.length; i++) {
                const c = cars[i];
                const o = i * 6;
                carBuf[o] = c.x; carBuf[o + 1] = c.y; carBuf[o + 2] = c.h;
                carBuf[o + 3] = c.boost || 0;
                carBuf[o + 4] = c.isPlayer ? 1 : 0;
                carBuf[o + 5] = c.skid || 0;
                carCols[i] = packColor(c.color);
                carDark[i] = packColor(c.colorDark);
            }
            // Reuse the existing draw() implementation. The enclosing object
            // literal is mid-construction so referencing it by name would
            // throw — call through the window-scoped binding instead.
            window.PoRacerRender.draw(
                mainCanvasId, miniCanvasId,
                w, h, camX, camY, scale,
                carBuf, cars.length, carCols, carDark,
                new Float32Array(0), 0,
                new Float32Array(0), 0,
                new Float32Array(0), 0,
                dt,
                weather || 0,
                0, 0.5, 0,
                cars);
        },

        draw(mainCanvasId, miniCanvasId,
             w, h, camX, camY, scale,
             carBuf, carCount, carCols, carDark,
             trailBuf, trailN,
             smokeEvts, smokeEvtsN,
             skidEvts, skidEvtsN,
             dt,
             weatherType,
             shakeIntensity, tod, fogD,
             carsList)
        {
            // Cache canvas lookups — getElementById every frame is expensive
            if (mainCanvasId !== mainCanvasId_) { mainCanvasId_ = mainCanvasId; mainCanvasEl = document.getElementById(mainCanvasId); mainCtx_ = null; }
            const mainCanvas = mainCanvasEl;
            if (!mainCanvas) return;
            if (!mainCtx_) mainCtx_ = mainCanvas.getContext('2d'); // cache 2D context
            const g = mainCtx_;
            if (!g) return;
            if (miniCanvasId !== miniCanvasId_ || !miniCanvasEl) { miniCanvasId_ = miniCanvasId; miniCanvasEl = miniCanvasId ? document.getElementById(miniCanvasId) : null; }
            const miniCanvas = miniCanvasEl;
            const miniCtx = miniCanvas ? miniCanvas.getContext('2d') : null;

            if (tod !== undefined) timeOfDay = tod;
            if (fogD !== undefined) fogDensity = fogD;

            // Resolution of the cached full-screen layers below. Read off the canvas
            // rather than window.devicePixelRatio: resize() derives the backing store
            // through PoCanvasDpr, which lowers the ratio once the pixel budget is hit,
            // so the two are NOT the same number on a large window.
            const layerDpr = dprOf(g, w);

            const reducedEffects = window.PoRacer?.effectsReduced();
            if (reducedEffects) { shakeX = shakeY = 0; weatherType = 0; }
            if (!reducedEffects && shakeIntensity && shakeIntensity > 0.01) applyShake(shakeIntensity);
            updateShake(); updateSparks();

            // Process emission events from C# and update JS-owned pools
            if (smokeEvtsN > 0) for (let i=0; i<smokeEvtsN; i++) { const eo=i*6; addSmokeEvt(smokeEvts[eo],smokeEvts[eo+1],smokeEvts[eo+2],smokeEvts[eo+3],smokeEvts[eo+4],smokeEvts[eo+5]); }
            if (skidEvtsN > 0) for (let i=0; i<skidEvtsN; i++) { const eo=i*5; addSkidEvt(skidEvts[eo],skidEvts[eo+1],skidEvts[eo+2],skidEvts[eo+3],skidEvts[eo+4]); }
            updateSmoke(dt); updateSkids(dt); updateWeather(dt, weatherType, camX, camY, scale, w, h);

            if (Math.abs(shakeX) > 0.1 || Math.abs(shakeY) > 0.1) { g.save(); g.translate(shakeX, shakeY); }

            // Feature 4: Parallax backgrounds
            ensureParallaxLayers(w, h, layerDpr); ensureGrass(w, h, layerDpr);
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
            if (!trackTex || Math.abs(trackScale - scale) > 0.001 || trackReqDpr !== layerDpr)
                buildTrackBitmap(scale, layerDpr);
            const [tox, toy] = project(trackOriginX, trackOriginY, camX, camY, scale, w, h);
            // Explicit destination size: the bitmap is now backed by texDpr device pixels
            // per CSS pixel, so without it the track would be drawn at texDpr times its
            // intended size rather than at its intended size in higher resolution.
            g.drawImage(trackTex, tox - TRACK_MARGIN, toy - TRACK_MARGIN, trackTexCssW, trackTexCssH);

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
                const livery = (carsList && carsList[i]) ? carsList[i].livery : 'stripe';
                drawCar(g, { camX, camY, scale, w, h, hdg: carBuf[o + 2] },
                    carBuf[o], carBuf[o + 1], cachedColor(carCols[i]), cachedColor(carDark[i]),
                    carBuf[o + 3], carBuf[o + 4] !== 0, carBuf[o + 5], carBuf[o + 5], livery);
            }

            // Feature 1: Ambient
            drawAmbientOverlay(g, w, h, timeOfDay, weatherType);

            // Feature 10: Fog
            drawFog(g, w, h, fogDensity, layerDpr);

            // Feature 5: Speed lines
            if (!reducedEffects) for (let i = 0; i < carCount; i++) { const o = i * 6; if (carBuf[o + 4] !== 0) { drawSpeedLines(g, w, h, Math.abs(carsList?.[i]?.v || 0) * 1.2, 340); break; } }

            // Feature 8: Post-processing
            drawVignette(g, w, h, layerDpr);
            if (bloomEnabled && !reducedEffects) drawBloom(g, w, h, layerDpr);

            if (shakeX || shakeY) g.restore();

            for (const car of carsList || []) if (car.isPlayer) drawPlayerMarker(g, car, camX, camY, scale, w, h);

        }
    };

})();
