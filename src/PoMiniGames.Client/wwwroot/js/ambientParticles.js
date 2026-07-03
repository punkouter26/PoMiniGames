// §4 WebGL ambient particle field. 200 GPU-resident points rendered with a
// single fragment shader that computes a soft-circle + slow drift. Zero JS
// per-frame allocations; runs only when the page is visible.

let gl = null;
let program = null;
let buffer = null;
let raf = 0;
let visible = true;
let inViewport = true;
let lastX = 0.5;
let lastY = 0.5;
let resizeObs = null;
let intersectObs = null;
let longFrames = 0;
let lastFrameMs = 0;
let currentPointCount = 200;

const POINT_COUNT = 200;
const VERT_SRC = `#version 300 es
in vec2 aCorner;
in vec2 aSeed;
out vec2 vSeed;
out vec2 vCorner;
void main() {
    vSeed = aSeed;
    vCorner = aCorner;
    gl_Position = vec4(aCorner, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
uniform float uTime;
uniform vec2 uResolution;
uniform vec2 uMouse;
in vec2 vSeed;
in vec2 vCorner;
out vec4 frag;
void main() {
    // Soft circle (constant falloff in [-1, 1] quad space).
    float r = length(vCorner);
    if (r > 1.0) discard;
    float falloff = smoothstep(1.0, 0.0, r);
    // Slow drift per-point.
    vec2 drift = vec2(sin(uTime * 0.0003 + vSeed.x * 6.28),
                      cos(uTime * 0.00027 + vSeed.y * 6.28));
    vec2 pos = vCorner + drift * 0.4;
    // Gentle mouse attractor.
    float mDist = distance(vCorner * 0.5 + 0.5, uMouse);
    float mInfluence = exp(-mDist * 6.0) * 0.4;
    vec3 hue = vec3(0.45 + vSeed.x * 0.15, 0.55 + vSeed.y * 0.2, 0.95);
    vec3 color = hue * falloff * (0.6 + mInfluence);
    frag = vec4(color, falloff * 0.5);
}`;

function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn('Shader compile failed:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
    }
    return s;
}

function linkProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.warn('Program link failed:', gl.getProgramInfoLog(p));
        gl.deleteProgram(p);
        return null;
    }
    return p;
}

function buildGeometry() {
    // Two-triangle quad with per-vertex seed.
    const data = new Float32Array(POINT_COUNT * 6 * 4);
    let i = 0;
    for (let p = 0; p < POINT_COUNT; p++) {
        const cx = (Math.random() * 2 - 1) * 0.95;
        const cy = (Math.random() * 2 - 1) * 0.95;
        const sx = Math.random();
        const sy = Math.random();
        const s = 0.025 + Math.random() * 0.04;
        const corners = [
            [cx - s, cy - s], [cx + s, cy - s],
            [cx + s, cy + s], [cx - s, cy + s],
        ];
        // Two triangles per quad: 0-1-2, 0-2-3
        const tris = [[0,1,2],[0,2,3]];
        for (const tri of tris) {
            for (const idx of tri) {
                data[i++] = corners[idx][0];
                data[i++] = corners[idx][1];
                data[i++] = sx;
                data[i++] = sy;
            }
        }
    }
    return data;
}

export function start(canvas) {
    gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) {
        // Fallback: leave the canvas blank. The CSS gradient behind it stays visible.
        return false;
    }
    const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return false;
    program = linkProgram(vs, fs);
    if (!program) return false;

    gl.useProgram(program);
    const data = buildGeometry();
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    const stride = 4 * 4; // 4 floats per vertex
    const locCorner = gl.getAttribLocation(program, 'aCorner');
    const locSeed = gl.getAttribLocation(program, 'aSeed');
    gl.enableVertexAttribArray(locCorner);
    gl.vertexAttribPointer(locCorner, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(locSeed);
    gl.vertexAttribPointer(locSeed, 2, gl.FLOAT, false, stride, 8);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    const uTime = gl.getUniformLocation(program, 'uTime');
    const uRes = gl.getUniformLocation(program, 'uResolution');
    const uMouse = gl.getUniformLocation(program, 'uMouse');

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const w = Math.floor(canvas.clientWidth * dpr);
        const h = Math.floor(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
    }

    resizeObs = new ResizeObserver(resize);
    resizeObs.observe(canvas);

    function pointerMove(e) {
        const rect = canvas.getBoundingClientRect();
        lastX = ((e.clientX - rect.left) / rect.width) || 0;
        lastY = 1 - ((e.clientY - rect.top) / rect.height) || 0;
    }
    canvas.addEventListener('pointermove', pointerMove, { passive: true });

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', stop);

    // §2 battery guard: pause the render loop when the canvas leaves the
    // viewport. IntersectionObserver fires once with the current state, then
    // toggles cheaply as the user scrolls. Saves a full GPU wake + draw call
    // per frame when the home page is off-screen.
    intersectObs = new IntersectionObserver((entries) => {
        for (const e of entries) {
            inViewport = e.isIntersecting;
        }
    }, { rootMargin: '50px' });
    intersectObs.observe(canvas);

    const startTime = performance.now();
    function tick(now) {
        if (!gl) return;

        // §2 thermal guard: if 60 consecutive frames take > 22 ms, halve the
        // particle count. This keeps the loop hitting 60 fps on phones that
        // thermal-throttle after a few minutes in landscape demo mode.
        if (lastFrameMs > 0) {
            const delta = now - lastFrameMs;
            if (delta > 22) {
                longFrames++;
                if (longFrames >= 60 && currentPointCount > 60) {
                    currentPointCount = Math.max(60, Math.floor(currentPointCount / 2));
                    longFrames = 0;
                }
            } else {
                longFrames = 0;
            }
        }
        lastFrameMs = now;

        if (visible && inViewport) {
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.uniform1f(uTime, now - startTime);
            gl.uniform2f(uRes, canvas.width, canvas.height);
            gl.uniform2f(uMouse, lastX, lastY);
            gl.drawArrays(gl.TRIANGLES, 0, currentPointCount * 6);
        }
        raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return true;
}

function onVisibility() {
    visible = !document.hidden;
}

export function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    document.removeEventListener('visibilitychange', onVisibility);
    if (resizeObs) {
        resizeObs.disconnect();
        resizeObs = null;
    }
    if (intersectObs) {
        intersectObs.disconnect();
        intersectObs = null;
    }
    if (gl && buffer) {
        gl.deleteBuffer(buffer);
        buffer = null;
    }
    if (gl && program) {
        gl.deleteProgram(program);
        program = null;
    }
    gl = null;
}