// particlesCore.js — shader + GL setup shared by the worker and the main-thread
// fallback. Extracted 2026-07-29 when the field moved to OffscreenCanvas (§7);
// keeping one copy means the two render paths can never drift visually.

export const POINT_COUNT = 200;

export const VERT_SRC = `#version 300 es
in vec2 aCorner;
in vec2 aSeed;
out vec2 vSeed;
out vec2 vCorner;
void main() {
    vSeed = aSeed;
    vCorner = aCorner;
    gl_Position = vec4(aCorner, 0.0, 1.0);
}`;

export const FRAG_SRC = `#version 300 es
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

function compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        gl.deleteShader(s);
        return null;
    }
    return s;
}

export function buildGeometry() {
    // Two-triangle quad per point, with a per-vertex seed for the drift/hue.
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
        for (const tri of [[0, 1, 2], [0, 2, 3]]) {
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

/**
 * Compile, link and bind everything. Works against a real canvas or an
 * OffscreenCanvas — the GL calls are identical either way, which is the whole
 * reason the worker port is cheap.
 * @returns {{program, buffer, uTime, uRes, uMouse}|null}
 */
export function initGl(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        return null;
    }

    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, buildGeometry(), gl.STATIC_DRAW);

    const stride = 4 * 4;
    const locCorner = gl.getAttribLocation(program, 'aCorner');
    const locSeed = gl.getAttribLocation(program, 'aSeed');
    gl.enableVertexAttribArray(locCorner);
    gl.vertexAttribPointer(locCorner, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(locSeed);
    gl.vertexAttribPointer(locSeed, 2, gl.FLOAT, false, stride, 8);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    return {
        program,
        buffer,
        uTime: gl.getUniformLocation(program, 'uTime'),
        uRes: gl.getUniformLocation(program, 'uResolution'),
        uMouse: gl.getUniformLocation(program, 'uMouse'),
    };
}

/** One draw. `count` is the live particle count (adaptive quality scales it). */
export function drawFrame(gl, u, w, h, elapsedMs, mouseX, mouseY, count) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(u.uTime, elapsedMs);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform2f(u.uMouse, mouseX, mouseY);
    gl.drawArrays(gl.TRIANGLES, 0, count * 6);
}
