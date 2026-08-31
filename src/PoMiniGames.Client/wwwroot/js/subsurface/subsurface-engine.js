// Sub-Surface High-Performance WebGL 2.0 Simulation Engine
// Blazor WASM Interop Module

import { vsQuadSource, fsPhysicsSource } from './subsurface-physics.glsl.js';
import { fsRenderSource } from './subsurface-render.glsl.js';

export class SubSurfaceEngine {
    constructor(canvas, dotNetHelper) {
        this.canvas = canvas;
        this.dotNetHelper = dotNetHelper;
        this.width = 800;
        this.height = 600;

        this.gl = canvas.getContext('webgl2', {
            alpha: false,
            depth: false,
            stencil: false,
            antialias: false,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance'
        });

        if (!this.gl) {
            console.error('WebGL 2.0 is not supported on this browser.');
            return;
        }

        // State variables
        this.isPaused = false;
        this.currentTool = 0; // 0: DigVacuum, 1: Sand, 2: Concrete, 3: Water, 4: TNT, 5: WaterBalloon
        this.brushRadius = 8;
        this.isMouseDown = false;
        this.mousePos = { x: 0, y: 0 };
        this.isSlingshotAiming = false;
        this.slingshotOrigin = { x: 0, y: 0 };
        this.slingshotCurrent = { x: 0, y: 0 };

        // Ordnance & Projectile array
        this.projectiles = []; // { type, x, y, vx, vy, radius, timer, isExtinguished }
        this.shockwaves = [];  // { x, y, radius, maxRadius, intensity, decay }
        this.submergedTNTCount = 0;

        // Frame timing & diagnostics
        this.frame = 0;
        this.startTime = performance.now();
        this.lastFpsUpdate = performance.now();
        this.fpsFrames = 0;
        this.currentFps = 60.0;
        this.animationFrameId = null;

        this.initWebGL();
        this.initEventListeners();
        this.loadPreset('DefaultHorizon');
        this.startLoop();
    }

    createShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    createProgram(vsSource, fsSource) {
        const gl = this.gl;
        const vs = this.createShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.createShader(gl.FRAGMENT_SHADER, fsSource);
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Program link error:', gl.getProgramInfoLog(program));
            return null;
        }
        return program;
    }

    initWebGL() {
        const gl = this.gl;

        // Fullscreen quad
        this.quadVAO = gl.createVertexArray();
        gl.bindVertexArray(this.quadVAO);
        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,
             1, -1,
            -1,  1,
            -1,  1,
             1, -1,
             1,  1,
        ]), gl.STATIC_DRAW);

        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        // Compile Programs
        this.physicsProgram = this.createProgram(vsQuadSource, fsPhysicsSource);
        this.renderProgram = this.createProgram(vsQuadSource, fsRenderSource);

        // Textures & Framebuffers (Ping-Pong FBO A <-> B)
        this.textures = [gl.createTexture(), gl.createTexture()];
        this.fbos = [gl.createFramebuffer(), gl.createFramebuffer()];
        this.currentFboIndex = 0;

        for (let i = 0; i < 2; i++) {
            gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[i]);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.textures[i], 0);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    loadInitialScene(presetName) {
        const data = new Uint8Array(this.width * this.height * 4);

        // Coordinate space: WebGL Texture row 0 is bottom (Y=599 in DOM coordinates)
        // DOM Y=0 is Top (Row 599 in WebGL).
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const idx = (y * this.width + x) * 4;

                // 1. Bedrock (Bottom row in WebGL: y == 0 or 1)
                if (y <= 2) {
                    data[idx] = 4; // Bedrock
                    data[idx + 1] = 0;
                    data[idx + 2] = 0;
                    data[idx + 3] = 255;
                    continue;
                }

                // 2. Sub-surface Stratum (y from 3 to 299 in WebGL -> bottom half)
                if (y < 300) {
                    data[idx] = 1; // Cohesive Sand
                    data[idx + 1] = 0;
                    data[idx + 2] = 0;
                    data[idx + 3] = 255;

                    // Embedded Horizontal Concrete Bars
                    if ((y >= 100 && y <= 108 && x >= 150 && x <= 350) ||
                        (y >= 200 && y <= 208 && x >= 450 && x <= 650) ||
                        (y >= 50 && y <= 58 && x >= 300 && x <= 500)) {
                        data[idx] = 2; // Concrete
                    }

                    // Embedded Vertical Concrete Columns
                    if ((x >= 240 && x <= 248 && y >= 100 && y <= 160) ||
                        (x >= 550 && x <= 558 && y >= 200 && y <= 260)) {
                        data[idx] = 2; // Concrete
                    }

                    // Sealed Subterranean Water Pockets
                    if (presetName === 'DeepCaverns' || presetName === 'DefaultHorizon') {
                        // Pocket 1
                        const d1 = Math.hypot(x - 250, y - 60);
                        if (d1 < 30) data[idx] = 3; // Water

                        // Pocket 2
                        const d2 = Math.hypot(x - 550, y - 120);
                        if (d2 < 40) data[idx] = 3; // Water

                        // Pocket 3 (Cavern hollow void)
                        const d3 = Math.hypot(x - 400, y - 180);
                        if (d3 < 35) data[idx] = 0; // Air Cavern
                    }
                }
                // 3. Surface Horizon & Surface Lake (Around y = 300 in WebGL)
                else if (y >= 300 && y <= 315) {
                    if (x >= 320 && x <= 480) {
                        data[idx] = 3; // Surface Lake
                    } else {
                        data[idx] = 1; // Sand Horizon
                    }
                    data[idx + 3] = 255;
                }
                // 4. Sky / Atmosphere (y > 315)
                else {
                    data[idx] = 0; // Air
                    data[idx + 1] = 0;
                    data[idx + 2] = 0;
                    data[idx + 3] = 0;
                }
            }
        }

        // Upload initial scene texture to both FBO textures
        const gl = this.gl;
        for (let i = 0; i < 2; i++) {
            gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        }
        this.projectiles = [];
        this.shockwaves = [];
        this.submergedTNTCount = 0;
    }

    initEventListeners() {
        const getCanvasCoord = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const scaleX = this.width / rect.width;
            const scaleY = this.height / rect.height;
            const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
            const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
            const domX = (clientX - rect.left) * scaleX;
            const domY = (clientY - rect.top) * scaleY;
            // Convert DOM coordinates (0 at top) to WebGL texture coords (0 at bottom)
            return {
                x: Math.max(0, Math.min(this.width - 1, domX)),
                y: Math.max(0, Math.min(this.height - 1, this.height - 1 - domY)),
                domY: domY
            };
        };

        const onPointerDown = (e) => {
            e.preventDefault();
            this.isMouseDown = true;
            const pt = getCanvasCoord(e);
            this.mousePos = pt;

            // Slingshot Aim in Sky (domY <= 299 or WebGL y >= 300)
            if ((this.currentTool === 4 || this.currentTool === 5) && pt.domY <= 300) {
                this.isSlingshotAiming = true;
                this.slingshotOrigin = { x: pt.x, y: pt.y };
                this.slingshotCurrent = { x: pt.x, y: pt.y };
            }
        };

        const onPointerMove = (e) => {
            if (!this.isMouseDown) return;
            const pt = getCanvasCoord(e);
            this.mousePos = pt;
            if (this.isSlingshotAiming) {
                this.slingshotCurrent = { x: pt.x, y: pt.y };
            }
        };

        const onPointerUp = (e) => {
            if (this.isSlingshotAiming) {
                // Launch Projectile
                const pullX = this.slingshotOrigin.x - this.slingshotCurrent.x;
                const pullY = this.slingshotOrigin.y - this.slingshotCurrent.y;
                const power = 0.25;
                const vx = pullX * power;
                const vy = pullY * power;

                if (Math.hypot(vx, vy) > 1.0) {
                    this.projectiles.push({
                        type: this.currentTool === 4 ? 'TNT' : 'BALLOON',
                        x: this.slingshotOrigin.x,
                        y: this.slingshotOrigin.y,
                        vx: vx,
                        vy: vy,
                        radius: 6,
                        timer: 5.0,
                        isExtinguished: false
                    });
                }
                this.isSlingshotAiming = false;
            }
            this.isMouseDown = false;
        };

        this.canvas.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
    }

    startLoop() {
        const loop = (timestamp) => {
            this.updateAndRender(timestamp);
            this.animationFrameId = requestAnimationFrame(loop);
        };
        this.animationFrameId = requestAnimationFrame(loop);
    }

    updateAndRender(timestamp) {
        const gl = this.gl;
        if (!gl) return;

        const timeSeconds = (timestamp - this.startTime) / 1000.0;
        this.fpsFrames++;
        if (timestamp - this.lastFpsUpdate >= 1000.0) {
            this.currentFps = (this.fpsFrames * 1000.0) / (timestamp - this.lastFpsUpdate);
            this.fpsFrames = 0;
            this.lastFpsUpdate = timestamp;
            if (this.dotNetHelper) {
                this.dotNetHelper.invokeMethodAsync('OnEngineMetricsUpdate', {
                    fps: Math.round(this.currentFps),
                    subSteps: 2,
                    activeProjectiles: this.projectiles.length,
                    submergedTNTCount: this.submergedTNTCount,
                    activeFluidCells: 0,
                    activeSandCells: 0
                }).catch(() => {});
            }
        }

        // 1. Update Projectiles & Ordnance physics
        this.updateProjectiles(0.0166);

        // 2. Cellular Physics Sub-Steps
        const subSteps = this.isPaused ? 0 : 2;
        gl.useProgram(this.physicsProgram);
        gl.bindVertexArray(this.quadVAO);

        // Brush parameters: (x, y, radius, material)
        let brushUniform = [0, 0, 0, 0];
        if (this.isMouseDown && !this.isSlingshotAiming) {
            let brushMat = 0;
            if (this.currentTool === 0) brushMat = 0; // Dig Vacuum (erases sand/water)
            else if (this.currentTool === 1) brushMat = 1; // Sand
            else if (this.currentTool === 2) brushMat = 2; // Concrete
            else if (this.currentTool === 3) brushMat = 3; // Water
            brushUniform = [this.mousePos.x, this.mousePos.y, this.brushRadius, brushMat];
        }

        // Active Shockwave uniform (x, y, radius, intensity)
        let shockwaveUniform = [0, 0, 0, 0];
        if (this.shockwaves.length > 0) {
            const sw = this.shockwaves[0];
            shockwaveUniform = [sw.x, sw.y, sw.radius, sw.intensity];
        }

        gl.uniform2f(gl.getUniformLocation(this.physicsProgram, 'u_resolution'), this.width, this.height);
        gl.uniform1f(gl.getUniformLocation(this.physicsProgram, 'u_time'), timeSeconds);
        gl.uniform1i(gl.getUniformLocation(this.physicsProgram, 'u_frame'), this.frame);
        gl.uniform4fv(gl.getUniformLocation(this.physicsProgram, 'u_brush'), brushUniform);
        gl.uniform4fv(gl.getUniformLocation(this.physicsProgram, 'u_shockwave'), shockwaveUniform);

        gl.viewport(0, 0, this.width, this.height);

        for (let step = 0; step < (subSteps || (this.isMouseDown ? 1 : 0)); step++) {
            const readIndex = this.currentFboIndex;
            const writeIndex = 1 - this.currentFboIndex;

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[writeIndex]);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.textures[readIndex]);
            gl.uniform1i(gl.getUniformLocation(this.physicsProgram, 'u_stateTexture'), 0);
            gl.uniform1i(gl.getUniformLocation(this.physicsProgram, 'u_subStep'), step);

            gl.drawArrays(gl.TRIANGLES, 0, 6);
            this.currentFboIndex = writeIndex;
        }

        // 3. Render Pass to Canvas
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(this.renderProgram);
        gl.bindVertexArray(this.quadVAO);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[this.currentFboIndex]);
        gl.uniform1i(gl.getUniformLocation(this.renderProgram, 'u_stateTexture'), 0);
        gl.uniform2f(gl.getUniformLocation(this.renderProgram, 'u_resolution'), this.width, this.height);
        gl.uniform1f(gl.getUniformLocation(this.renderProgram, 'u_time'), timeSeconds);
        gl.uniform4fv(gl.getUniformLocation(this.renderProgram, 'u_shockwave'), shockwaveUniform);

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        this.frame++;
    }

    updateProjectiles(dt) {
        // Update Shockwave expansion & decay
        for (let i = this.shockwaves.length - 1; i >= 0; i--) {
            const sw = this.shockwaves[i];
            sw.radius += 180.0 * dt;
            sw.intensity -= 1.2 * dt;
            if (sw.intensity <= 0 || sw.radius >= sw.maxRadius) {
                this.shockwaves.splice(i, 1);
            }
        }

        // Update Projectiles
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];

            // Apply gravity
            p.vy -= 18.0 * dt;
            p.x += p.vx * dt * 10.0;
            p.y += p.vy * dt * 10.0;

            // Bounce on bottom bedrock
            if (p.y <= 6) {
                p.y = 6;
                p.vy = -p.vy * 0.4;
                p.vx *= 0.7;
            }

            // Water surface zone check (y <= 315 in center lake or underground pockets)
            const isInWaterZone = p.y <= 315 && p.x >= 320 && p.x <= 480;

            if (p.type === 'TNT') {
                if (isInWaterZone) {
                    // Contact with water extinguishes fuse immediately
                    if (!p.isExtinguished) {
                        p.isExtinguished = true;
                        this.submergedTNTCount++;
                    }
                    // Heavy fluid drag
                    p.vx *= 0.85;
                    p.vy *= 0.85;
                } else if (!p.isExtinguished) {
                    p.timer -= dt;
                    if (p.timer <= 0) {
                        // Detonate TNT Dry Blast
                        this.shockwaves.push({
                            x: p.x,
                            y: p.y,
                            radius: 10,
                            maxRadius: 110,
                            intensity: 1.0
                        });
                        this.projectiles.splice(i, 1);
                        continue;
                    }
                }
            } else if (p.type === 'BALLOON') {
                // Impact detonation with terrain or lake
                if (p.y <= 315) {
                    // Spawn pressurized water burst at impact point
                    this.sprayWaterBurst(p.x, p.y, 18);
                    this.projectiles.splice(i, 1);
                    continue;
                }
            }
        }
    }

    sprayWaterBurst(cx, cy, radius) {
        // Stamp fluid cells into current texture
        const gl = this.gl;
        const size = radius * 2;
        const waterData = new Uint8Array(size * size * 4);
        for (let dy = 0; dy < size; dy++) {
            for (let dx = 0; dx < size; dx++) {
                const dist = Math.hypot(dx - radius, dy - radius);
                const idx = (dy * size + dx) * 4;
                if (dist <= radius) {
                    waterData[idx] = 3; // Water
                    waterData[idx + 1] = 0;
                    waterData[idx + 2] = 0;
                    waterData[idx + 3] = 255;
                }
            }
        }
        gl.bindTexture(gl.TEXTURE_2D, this.textures[this.currentFboIndex]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, Math.max(0, Math.min(this.width - size, cx - radius)),
                         Math.max(0, Math.min(this.height - size, cy - radius)),
                         size, size, gl.RGBA, gl.UNSIGNED_BYTE, waterData);
    }

    setTool(toolId) {
        this.currentTool = toolId;
    }

    setBrushRadius(radius) {
        this.brushRadius = Math.max(1, Math.min(32, radius));
    }

    setPaused(isPaused) {
        this.isPaused = isPaused;
    }

    stepOnce() {
        if (!this.isPaused) return;
        this.updateAndRender(performance.now());
    }

    loadPreset(presetName) {
        this.loadInitialScene(presetName);
    }

    reset() {
        this.loadPreset('DefaultHorizon');
    }

    dispose() {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        const gl = this.gl;
        if (gl) {
            this.textures.forEach(t => gl.deleteTexture(t));
            this.fbos.forEach(f => gl.deleteFramebuffer(f));
            if (this.physicsProgram) gl.deleteProgram(this.physicsProgram);
            if (this.renderProgram) gl.deleteProgram(this.renderProgram);
            if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
        }
    }
}

// Module entry points for Blazor WASM interop
let activeEngine = null;

export function initSubSurface(canvas, dotNetHelper) {
    if (activeEngine) {
        activeEngine.dispose();
    }
    activeEngine = new SubSurfaceEngine(canvas, dotNetHelper);
    return true;
}

export function setSubSurfaceTool(toolId) {
    if (activeEngine) activeEngine.setTool(toolId);
}

export function setSubSurfaceBrushRadius(radius) {
    if (activeEngine) activeEngine.setBrushRadius(radius);
}

export function setSubSurfacePaused(isPaused) {
    if (activeEngine) activeEngine.setPaused(isPaused);
}

export function stepSubSurface() {
    if (activeEngine) activeEngine.stepOnce();
}

export function loadSubSurfacePreset(presetName) {
    if (activeEngine) activeEngine.loadPreset(presetName);
}

export function resetSubSurface() {
    if (activeEngine) activeEngine.reset();
}

export function disposeSubSurface() {
    if (activeEngine) {
        activeEngine.dispose();
        activeEngine = null;
    }
}
