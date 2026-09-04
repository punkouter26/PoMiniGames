// Sand High-Performance WebGL 2.0 Simulation Engine
// Blazor WASM Interop Module
//
// Split of responsibilities:
//  - GPU (subsurface-physics.glsl.js): per-cell cellular automata for sand
//    cohesion / water flow / blast pulverization on the ping-pong FBO pair.
//  - CPU (this file): everything that needs global knowledge — the
//    connected-component rigid island solver for concrete bars, ballistic
//    projectiles colliding against the real grid, and ordnance state machines.
//    Both share the grid through a periodic readPixels snapshot.

import { vsQuadSource, physicsSource, REALISM_LOW, REALISM_MEDIUM, REALISM_HIGH } from './subsurface-physics.glsl.js';
import {
    fsRenderSource, vsGrainSource, fsGrainSource,
    fsExtractSource, fsBlurSource, fsCompositeSource,
    vsFxSource, fsFxSource
} from './subsurface-render.glsl.js';
import { SubSurfaceAudio } from './subsurface-audio.js';

const MAT = { AIR: 0, SAND: 1, CONCRETE: 2, WATER: 3, BEDROCK: 4, DEBRIS: 5, LAVA: 6, OIL: 7, FIRE: 8, OBSIDIAN: 9 };
const MAX_SHOCKWAVES = 4;
const MAX_PROJECTILES = 24;
const SNAPSHOT_INTERVAL = 4;   // frames between grid readbacks (~15 Hz)
const ISLAND_FALL_STEP = 4;    // px an unsupported concrete island drops per solver tick
const GRAVITY = 350.0;         // px/s^2
const LAUNCH_POWER = 2.5;      // px/s of launch velocity per px of slingshot pull

// Blast ejecta: explosions displace matter, they never destroy it. Every
// sand/water cell inside the crater becomes one ballistic grain (1 cell = 1
// grain) that arcs under gravity and stamps back into the grid on landing, so
// total matter is invariant except for grains leaving the lateral edges.
const CRATER_RADIUS = 145;        // px excavation radius (10x yield: r scales with sqrt(energy))
const BLAST_SOLID_BUDGET = 90;    // px of solid a blast ray can chew through
const EJECTA_SPEED = 680;         // px/s peak radial ejection speed
const MAX_RENDER_GRAINS = 262144; // draw cap only; physics always integrates all
const MAX_FX = 4096;              // cosmetic smoke/ember/spark particle cap

function isSolidMat(m) {
    return m === MAT.SAND || m === MAT.CONCRETE || m === MAT.BEDROCK || m === MAT.DEBRIS || m === MAT.OBSIDIAN;
}

function isLiquidMat(m) {
    return m === MAT.WATER || m === MAT.LAVA || m === MAT.OIL;
}

// Ordnance catalogue. Tool ids 4/5/8-11 are slingshot ordnance; the shader
// renders each `kind`. BOMBLET is spawn-only (cluster payload).
// scale multiplies the blast crater/shockwave; budget is the drill's solid
// chew allowance in cell-cost units (concrete/obsidian cost 3x sand).
const ORDNANCE_SPECS = {
    TNT:     { radius: 6, timer: 5.0, kind: 0, scale: 1.0 },
    BALLOON: { radius: 6, timer: Infinity, kind: 2 },
    DRILL:   { radius: 5, timer: 6.0, kind: 3, scale: 1.0, budget: 1500 },
    CLUSTER: { radius: 7, timer: 3.0, kind: 4, scale: 0.25 },
    // Nuke crater worst case is ~140k ejecta grains (pi * 210^2), under the
    // MAX_RENDER_GRAINS cap; heavy for a few seconds but transient.
    NUKE:    { radius: 9, timer: 5.0, kind: 5, scale: 1.45 },
    STICKY:  { radius: 5, timer: 4.0, kind: 6, scale: 1.0 },
    BOMBLET: { radius: 3, timer: 1.0, kind: 0, scale: 0.4 },
};
const TOOL_ORDNANCE = { 4: 'TNT', 5: 'BALLOON', 8: 'DRILL', 9: 'CLUSTER', 10: 'NUKE', 11: 'STICKY' };
// Brush tools paint the material with the same id (0 vacuum/air, 1 sand,
// 2 concrete, 3 water, 6 lava, 7 oil).
const BRUSH_TOOLS = new Set([0, 1, 2, 3, 6, 7]);

const REALISM_NAMES = { [REALISM_LOW]: 'Low', [REALISM_MEDIUM]: 'Medium', [REALISM_HIGH]: 'High' };
function clampRealism(level) {
    return Math.min(REALISM_HIGH, Math.max(REALISM_LOW, level | 0));
}
function realismName(level) {
    return REALISM_NAMES[level] ?? 'None';
}

export class SubSurfaceEngine {
    constructor(canvas, dotNetHelper, realism = REALISM_MEDIUM) {
        this.canvas = canvas;
        this.dotNetHelper = dotNetHelper;

        // Physics realism tier (see subsurface-physics.glsl.js). A tier is a
        // compile-time shader variant, so changing it means a relink. Startup
        // bootstraps on Low (links in ~1 s everywhere) and then chases the
        // requested tier in the background; the linked program keeps stepping
        // until its replacement links, and a failed link (ANGLE/D3D11 hangs
        // ~100 s on the High chain, then fails with an empty log) keeps the
        // working tier — the page never dies on it.
        this.realism = 0;                  // effective (linked) tier; 0 until the first link
        this.requestedRealism = clampRealism(realism);
        this.physicsBuild = null;          // in-flight { level, program, vs, fs, startedAt, valid }
        this.parallelCompile = null;       // KHR_parallel_shader_compile, when present
        this.lastCompileMs = 0;
        this.physicsProgram = null;
        this.physicsLocs = null;
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

        // Enable float render targets so material IDs (0-4) are stored exactly.
        // An 8-bit normalized texture clamps any ID > 1.0, collapsing concrete,
        // water and bedrock into sand. RGBA32F stores the exact float ID.
        if (!this.gl.getExtension('EXT_color_buffer_float')) {
            console.warn('EXT_color_buffer_float is unavailable; Sand materials may render incorrectly.');
        }

        // State variables
        this.isPaused = false;
        this.pendingStep = false;
        this.currentTool = 0; // 0 DigVacuum, 1 Sand, 2 Concrete, 3 Water, 4 TNT, 5 Balloon, 6 Lava, 7 Oil, 8 Drill, 9 Cluster, 10 Nuke, 11 Sticky
        this.brushRadius = 8;
        this.isMouseDown = false;
        this.mousePos = { x: 0, y: 0 };
        this.isSlingshotAiming = false;
        this.slingshotOrigin = { x: 0, y: 0 };
        this.slingshotCurrent = { x: 0, y: 0 };

        // Ordnance & Projectile array
        this.projectiles = []; // { type, x, y, vx, vy, radius, timer }
        this.shockwaves = [];  // { x, y, radius, maxRadius, intensity, decay }
        this.submergedTNTCount = 0;

        // Ballistic ejecta grains { x, y, vx, vy, mat } displaced by blasts
        this.grains = [];
        this.grainBuffer = new Float32Array(MAX_RENDER_GRAINS * 3);

        // Cosmetic FX particles (smoke/embers/sparks) — render-only, never
        // enter the conservation grid. Types: 0 smoke, 1 ember, 2 spark.
        this.fx = [];
        this.fxBuffer = new Float32Array(MAX_FX * 4);
        this.lavaSurface = [];   // sampled lava-with-air-above cells (ember sources)
        this.firePositions = []; // sampled burning cells (smoke sources)
        this.fireCellCount = 0;
        this.lastObsidianCount = 0;

        // Camera shake (applied as a CSS transform so sim coords stay exact)
        this.shakeAmp = 0;

        // Procedural audio (context unlocks on the first pointer gesture)
        this.audio = new SubSurfaceAudio();

        // Demo auto-drop ordnance
        this.autoDropEnabled = false;
        this.autoDropTimer = 0;

        // CPU-side grid snapshot (RGBA32F mirror of the current state texture).
        // Refreshed every SNAPSHOT_INTERVAL frames; the island solver and the
        // projectile collision code both read it, the island solver writes it
        // back through texSubImage2D.
        this.gridData = new Float32Array(this.width * this.height * 4);
        this.islandVisited = new Uint8Array(this.width * this.height);
        this.islandsActive = false;
        this.activeSandCells = 0;
        this.activeFluidCells = 0;

        // Frame timing & diagnostics
        this.frame = 0;
        this.startTime = performance.now();
        this.lastFrameTimestamp = 0;
        this.frameDeltaEma = 16.7;
        this.currentSubSteps = 2;
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

        // Compile Programs. The physics program is tier-dependent and links
        // through beginPhysicsBuild (asynchronously where the driver allows);
        // render/grain link synchronously here.
        this.parallelCompile = gl.getExtension('KHR_parallel_shader_compile');
        this.renderProgram = this.createProgram(vsQuadSource, fsRenderSource);
        this.grainProgram = this.createProgram(vsGrainSource, fsGrainSource);

        // Ejecta grain point buffer (positions streamed per frame)
        this.grainVAO = gl.createVertexArray();
        gl.bindVertexArray(this.grainVAO);
        this.grainVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.grainVBO);
        gl.bufferData(gl.ARRAY_BUFFER, this.grainBuffer.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        this.grainResolutionLoc = gl.getUniformLocation(this.grainProgram, 'u_resolution');

        // Cache uniform locations (looked up once; set every frame)
        const locs = (prog, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(prog, n)]));
        this.renderLocs = locs(this.renderProgram, [
            'u_stateTexture', 'u_resolution', 'u_time',
            'u_shockwaves', 'u_shockwaveCount',
            'u_projectiles', 'u_projectileCount', 'u_aim', 'u_aimActive'
        ]);

        // Textures & Framebuffers (Ping-Pong FBO A <-> B)
        this.textures = [gl.createTexture(), gl.createTexture()];
        this.fbos = [gl.createFramebuffer(), gl.createFramebuffer()];
        this.currentFboIndex = 0;

        for (let i = 0; i < 2; i++) {
            gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.width, this.height, 0, gl.RGBA, gl.FLOAT, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[i]);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.textures[i], 0);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        this.initPostFx();

        // Bootstrap on Low so the grid moves at once; finishPhysicsBuild then
        // chases requestedRealism and hot-swaps the program when it links.
        this.beginPhysicsBuild(REALISM_LOW, true);
    }

    // ---- Physics realism tier ---------------------------------------------

    beginPhysicsBuild(level, bootstrap = false) {
        const gl = this.gl;
        level = clampRealism(level);
        if (this.physicsBuild) this.discardPhysicsBuild();
        if (!bootstrap) this.requestedRealism = level;
        const vs = this.createShader(gl.VERTEX_SHADER, vsQuadSource);
        const fs = this.createShader(gl.FRAGMENT_SHADER, physicsSource(level));
        const program = gl.createProgram();
        if (vs) gl.attachShader(program, vs);
        if (fs) gl.attachShader(program, fs);
        gl.linkProgram(program);
        this.physicsBuild = { level, program, vs, fs, startedAt: performance.now(), valid: !!(vs && fs) };
        this.reportRealism(`Compiling ${realismName(level)} physics…`);
        // Without the parallel-compile extension linkProgram already blocked;
        // resolve now. With it, pollPhysicsBuild resolves from the frame loop.
        if (!this.parallelCompile) this.finishPhysicsBuild();
    }

    pollPhysicsBuild() {
        const b = this.physicsBuild;
        if (!b) return;
        if (this.parallelCompile &&
            !this.gl.getProgramParameter(b.program, this.parallelCompile.COMPLETION_STATUS_KHR)) {
            return; // still linking on the driver's worker; keep stepping the old tier
        }
        this.finishPhysicsBuild();
    }

    finishPhysicsBuild() {
        const gl = this.gl;
        const b = this.physicsBuild;
        this.physicsBuild = null;
        const ms = performance.now() - b.startedAt;
        const linked = b.valid && gl.getProgramParameter(b.program, gl.LINK_STATUS);
        if (b.vs) gl.deleteShader(b.vs);
        if (b.fs) gl.deleteShader(b.fs);
        if (linked) {
            if (this.physicsProgram) gl.deleteProgram(this.physicsProgram);
            this.physicsProgram = b.program;
            this.physicsLocs = Object.fromEntries([
                'u_stateTexture', 'u_resolution', 'u_time', 'u_frame', 'u_subStep',
                'u_brush', 'u_shockwaves', 'u_shockwaveCount'
            ].map(n => [n, gl.getUniformLocation(b.program, n)]));
            this.realism = b.level;
            this.lastCompileMs = ms;
            this.reportRealism(`${realismName(b.level)} physics linked in ${Math.round(ms)} ms`);
            if (this.requestedRealism !== this.realism) {
                this.beginPhysicsBuild(this.requestedRealism);
            }
            return;
        }
        const log = gl.getProgramInfoLog(b.program) || '(empty log)';
        gl.deleteProgram(b.program);
        console.warn(`Sand: ${realismName(b.level)} physics failed to link after ${Math.round(ms)} ms: ${log}`);
        if (this.physicsProgram) {
            // A working tier is still bound: keep it and surface the failure.
            this.requestedRealism = this.realism;
            this.reportRealism(`${realismName(b.level)} failed to link on this GPU after ${Math.round(ms / 1000)} s; staying on ${realismName(this.realism)}`, true);
            return;
        }
        this.reportRealism(`${realismName(b.level)} physics failed to link; the grid cannot advance`, true);
    }

    discardPhysicsBuild() {
        const gl = this.gl;
        const b = this.physicsBuild;
        this.physicsBuild = null;
        if (b.vs) gl.deleteShader(b.vs);
        if (b.fs) gl.deleteShader(b.fs);
        gl.deleteProgram(b.program);
    }

    setRealism(level) {
        if (!this.gl) return;
        level = clampRealism(level);
        if (this.physicsBuild) {
            if (this.physicsBuild.level === level) return;
            this.discardPhysicsBuild();
        }
        if (level === this.realism) {
            this.requestedRealism = level;
            this.reportRealism(`${realismName(level)} physics active`);
            return;
        }
        this.beginPhysicsBuild(level);
    }

    reportRealism(message, failed = false) {
        if (!this.dotNetHelper) return;
        this.dotNetHelper.invokeMethodAsync('OnRealismStatus', {
            requested: this.requestedRealism,
            effective: this.realism,
            pending: !!this.physicsBuild,
            failed,
            compileMs: Math.round(this.lastCompileMs),
            message
        }).catch(() => {});
    }

    // Post-processing chain: scene FBO -> bright extract -> blurred bloom ->
    // composite (lighting, heat haze, god rays, vignette). Any failure here
    // falls back to the original direct-to-canvas render path.
    initPostFx() {
        this.postFx = false;
        const gl = this.gl;
        try {
            this.extractProgram = this.createProgram(vsQuadSource, fsExtractSource);
            this.blurProgram = this.createProgram(vsQuadSource, fsBlurSource);
            this.compositeProgram = this.createProgram(vsQuadSource, fsCompositeSource);
            this.fxProgram = this.createProgram(vsFxSource, fsFxSource);
            if (!this.extractProgram || !this.blurProgram || !this.compositeProgram || !this.fxProgram) {
                return;
            }

            const locs = (prog, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(prog, n)]));
            this.extractLocs = locs(this.extractProgram, ['u_scene']);
            this.blurLocs = locs(this.blurProgram, ['u_tex', 'u_dir']);
            this.compositeLocs = locs(this.compositeProgram, ['u_scene', 'u_bloom', 'u_state', 'u_resolution', 'u_time']);
            this.fxLocs = locs(this.fxProgram, ['u_resolution']);

            const makeTarget = (w, h) => {
                const tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                const fbo = gl.createFramebuffer();
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
                const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                return ok ? { tex, fbo, w, h } : null;
            };

            this.sceneTarget = makeTarget(this.width, this.height);
            this.bloomA = makeTarget(this.width / 2, this.height / 2);
            this.bloomB = makeTarget(this.width / 2, this.height / 2);
            if (!this.sceneTarget || !this.bloomA || !this.bloomB) return;

            // FX particle point buffer
            this.fxVAO = gl.createVertexArray();
            gl.bindVertexArray(this.fxVAO);
            this.fxVBO = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVBO);
            gl.bufferData(gl.ARRAY_BUFFER, this.fxBuffer.byteLength, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
            gl.bindVertexArray(null);

            this.postFx = true;
        } catch (e) {
            console.warn('SubSurface post-FX unavailable, falling back to direct render.', e);
            this.postFx = false;
        }
    }

    loadInitialScene(presetName) {
        const data = new Float32Array(this.width * this.height * 4);
        const demolition = presetName === 'SlingshotDemolition';
        const deepCaverns = presetName === 'DeepCaverns';

        // Coordinate space: WebGL Texture row 0 is bottom (Y=599 in DOM coordinates)
        // DOM Y=0 is Top (Row 599 in WebGL).
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const idx = (y * this.width + x) * 4;

                // 1. Bedrock (bottom rows in WebGL, matching the shader's y <= 2 clamp)
                if (y <= 2) {
                    data[idx] = MAT.BEDROCK;
                    continue;
                }

                // 2. Sub-surface Stratum (y from 3 to 299 in WebGL -> bottom half)
                if (y < 300) {
                    data[idx] = MAT.SAND;

                    // Embedded Horizontal Concrete Bars
                    if ((y >= 100 && y <= 108 && x >= 150 && x <= 350) ||
                        (y >= 200 && y <= 208 && x >= 450 && x <= 650) ||
                        (y >= 50 && y <= 58 && x >= 300 && x <= 500)) {
                        data[idx] = MAT.CONCRETE;
                    }

                    // Embedded Vertical Concrete Columns
                    if ((x >= 240 && x <= 248 && y >= 100 && y <= 160) ||
                        (x >= 550 && x <= 558 && y >= 200 && y <= 260)) {
                        data[idx] = MAT.CONCRETE;
                    }

                    // Sealed subterranean water pockets (PRD: 3-5 at varying depths)
                    if (!demolition) {
                        if (Math.hypot(x - 250, y - 60) < 30) data[idx] = MAT.WATER;
                        if (Math.hypot(x - 550, y - 120) < 40) data[idx] = MAT.WATER;
                        if (Math.hypot(x - 650, y - 80) < 22) data[idx] = MAT.WATER;
                        if (Math.hypot(x - 150, y - 150) < 26) data[idx] = MAT.WATER;
                        if (deepCaverns && Math.hypot(x - 400, y - 100) < 28) data[idx] = MAT.WATER;

                        // Hollow cavern void (breach target under the lake)
                        if (Math.hypot(x - 400, y - 180) < 35) data[idx] = MAT.AIR;

                        // Big central lake: a deep V-shaped basin carved into
                        // the stratum. Its bed sits ~25px above the ant-maze
                        // feeder galleries — breach the membrane and the lake
                        // floods the maze all the way to the bottom of the map.
                        if (y >= 240 && Math.abs(x - 400) < 30 + (y - 240) * 1.05) {
                            data[idx] = MAT.WATER;
                        }
                    }
                }
                // 3. Surface Horizon & the big lake's mouth (rows 300-315)
                else if (y >= 300 && y <= 315) {
                    if (!demolition && Math.abs(x - 400) < 30 + (y - 240) * 1.05) {
                        data[idx] = MAT.WATER;
                    } else {
                        data[idx] = MAT.SAND; // Sand Horizon
                    }
                }
                // 4. Sky / Atmosphere (y > 315)
                else {
                    data[idx] = MAT.AIR;

                    // Above-ground demolition targets: concrete towers with a lintel
                    if (demolition && y <= 430) {
                        if ((x >= 200 && x <= 214) || (x >= 300 && x <= 314) ||
                            (y >= 418 && x >= 200 && x <= 314) ||
                            (x >= 560 && x <= 574 && y <= 400) || (x >= 640 && x <= 654 && y <= 400) ||
                            (y >= 388 && y <= 400 && x >= 560 && x <= 654)) {
                            data[idx] = MAT.CONCRETE;
                        }
                    }
                }
            }
        }

        // Ant-farm maze: winding, mostly-diagonal galleries with chambers,
        // carved through the stratum. Corridors stay ~6px wide so cohesive
        // roofs hold; a protected membrane under the lake bed keeps the maze
        // dry until the player breaches it (dig or bomb the lake bottom) —
        // then the lake drains through the maze to the bottom of the map.
        if (!demolition) {
            const pockets = [[250, 60, 30], [550, 120, 40], [650, 80, 22], [150, 150, 26]];
            if (deepCaverns) pockets.push([400, 100, 28]);
            const canCarve = (x, y) => {
                if (y < 8 || y > 290) return false;
                if (y >= 220 && Math.abs(x - 400) <= 145) return false; // lake-bed membrane
                for (const [px, py, pr] of pockets) {
                    if (Math.hypot(x - px, y - py) < pr + 9) return false;
                }
                return true;
            };
            const carve = (cx, cy, r) => {
                for (let yy = cy - r; yy <= cy + r; yy++) {
                    for (let xx = cx - r; xx <= cx + r; xx++) {
                        if (xx < 12 || xx > this.width - 13) continue;
                        if (Math.hypot(xx - cx, yy - cy) > r || !canCarve(xx, yy)) continue;
                        const ii = (yy * this.width + xx) * 4;
                        if (data[ii] === MAT.SAND) {
                            data[ii] = MAT.AIR;
                            data[ii + 1] = 0;
                            data[ii + 2] = 0;
                            data[ii + 3] = 0;
                        }
                    }
                }
            };
            for (const start of [80, 170, 250, 560, 650, 730]) {
                let x = start + Math.floor(Math.random() * 30) - 15;
                let y = 285;
                let dir = Math.random() < 0.5 ? -1 : 1;
                let horiz = 0;
                for (let step = 0; step < 380 && y > 24; step++) {
                    carve(x, y, 3);
                    if (Math.random() < 0.08) dir = -dir;
                    if (x < 30) dir = 1;
                    if (x > 770) dir = -1;
                    if (horiz > 9 || Math.random() < 0.4) {
                        y -= 1;
                        horiz = Math.max(0, horiz - 2);
                    }
                    if (Math.random() < 0.85) {
                        x += dir;
                        horiz++;
                    }
                    if (step % 120 === 60) carve(x, y, 6); // gallery chamber
                }
                carve(x, y, 7); // terminal chamber near the bottom
            }
            // Feeder galleries hugging the membrane under the lake bed, opening
            // into the central cavern — one breach floods everything below
            for (const fx of [355, 445]) {
                let x = fx, y = 213;
                for (let i = 0; i < 190 && y > 60; i++) {
                    carve(x, y, 3);
                    if (Math.random() < 0.8) x += fx < 400 ? 1 : -1;
                    if (Math.random() < 0.35) y -= 1;
                }
            }
        }

        // Upload initial scene texture to both FBO textures + refresh the snapshot
        const gl = this.gl;
        for (let i = 0; i < 2; i++) {
            gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, data);
        }
        this.gridData.set(data);
        this.projectiles = [];
        this.shockwaves = [];
        this.grains = [];
        this.submergedTNTCount = 0;
    }

    // ---- Grid snapshot ------------------------------------------------------

    matAt(x, y) {
        const cx = Math.max(0, Math.min(this.width - 1, Math.round(x)));
        const cy = Math.max(0, Math.min(this.height - 1, Math.round(y)));
        return this.gridData[(cy * this.width + cx) * 4];
    }

    readbackGrid() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.currentFboIndex]);
        gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, this.gridData);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.snapshotFrame = this.frame;

        // Diagnostics + FX/audio census piggyback on the readback: cell
        // counts, sampled ember/smoke emitter positions, quench detection.
        let sand = 0, fluid = 0, fire = 0, obsidian = 0;
        const d = this.gridData;
        const w = this.width, w4 = w * 4;
        this.lavaSurface.length = 0;
        this.firePositions.length = 0;
        for (let i = 0; i < d.length; i += 4) {
            const m = d[i];
            if (m === MAT.SAND) sand++;
            else if (isLiquidMat(m)) {
                fluid++;
                if (m === MAT.LAVA && d[i + w4] === MAT.AIR &&
                    this.lavaSurface.length < 24 && Math.random() < 0.05) {
                    const cell = i / 4;
                    this.lavaSurface.push({ x: cell % w, y: (cell / w) | 0 });
                }
            } else if (m === MAT.FIRE) {
                fire++;
                if (this.firePositions.length < 24 && Math.random() < 0.1) {
                    const cell = i / 4;
                    this.firePositions.push({ x: cell % w, y: (cell / w) | 0 });
                }
            } else if (m === MAT.OBSIDIAN) {
                obsidian++;
            }
        }
        this.activeSandCells = sand;
        this.activeFluidCells = fluid;
        this.fireCellCount = fire;
        this.audio.setFireLevel(fire);
        // A jump in obsidian means lava just quenched somewhere — sizzle
        if (obsidian > this.lastObsidianCount + 6) {
            this.audio.sizzle(this.lavaSurface[0]?.x ?? 400);
        }
        this.lastObsidianCount = obsidian;
    }

    // COHERENCE GUARD: every CPU mutation that later uploads a rect must run
    // against a snapshot taken THIS frame — a stale rect reverts every other
    // cell in it and silently duplicates or destroys matter.
    ensureFreshSnapshot() {
        if (this.snapshotFrame !== this.frame) {
            this.readbackGrid();
        }
    }

    uploadRegion(x0, y0, w, h) {
        if (w <= 0 || h <= 0) return;
        const gl = this.gl;
        const region = new Float32Array(w * h * 4);
        for (let row = 0; row < h; row++) {
            const src = ((y0 + row) * this.width + x0) * 4;
            region.set(this.gridData.subarray(src, src + w * 4), row * w * 4);
        }
        gl.bindTexture(gl.TEXTURE_2D, this.textures[this.currentFboIndex]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.FLOAT, region);
    }

    // ---- Rigid concrete island solver ---------------------------------------
    // JS mirror of SubSurfaceIslandSolver.cs (WebGL coordinates: below = y - 1).
    // Concrete is inert in the GPU automaton; here connected components are
    // flood-filled and any island with no sand/bedrock under any cell falls as
    // ONE coherent body until it lands, displacing water upward into the cells
    // it vacates so fluid mass is conserved.

    solveConcreteIslands() {
        const w = this.width, h = this.height;
        const grid = this.gridData;
        const visited = this.islandVisited;
        visited.fill(0);

        const stack = [];
        let dirty = null;
        let anyActive = false;

        for (let y = 3; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const ci = y * w + x;
                if (visited[ci] || grid[ci * 4] !== MAT.CONCRETE) continue;

                // Flood fill one 4-connected island; record the x-extent of
                // its actual footing and its mass distribution as we go
                const cells = [];
                stack.length = 0;
                stack.push(ci);
                visited[ci] = 1;
                let supported = false;
                let supMinX = w, supMaxX = -1, comSum = 0;
                while (stack.length > 0) {
                    const idx = stack.pop();
                    cells.push(idx);
                    const cx = idx % w, cy = (idx / w) | 0;
                    comSum += cx;

                    const belowIdx = idx - w;
                    const belowMat = grid[belowIdx * 4];
                    // Loose debris gravel is NOT support: a stray blast pebble
                    // under a beam must not leave it hovering — rigid bodies
                    // crush through gravel (see the drop path below).
                    if (belowMat === MAT.SAND || belowMat === MAT.BEDROCK || belowMat === MAT.OBSIDIAN) {
                        supported = true;
                        if (cx < supMinX) supMinX = cx;
                        if (cx > supMaxX) supMaxX = cx;
                    }

                    const neighbors = [idx + 1, idx - 1, idx + w, belowIdx];
                    for (const n of neighbors) {
                        const nx = n % w, ny = (n / w) | 0;
                        if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue; // no row wrap
                        if (ny < 0 || ny >= h || visited[n]) continue;
                        if (grid[n * 4] === MAT.CONCRETE) {
                            visited[n] = 1;
                            stack.push(n);
                        }
                    }
                }

                if (cells.length === 0) continue;

                // Static equilibrium, not just contact: a piece whose centre of
                // mass lies outside its footing's x-span topples — treat it as
                // unsupported so it falls instead of levitating off one corner.
                // A toppling piece also drifts one column toward its centre of
                // mass per tick, pivoting off the footing edge instead of
                // dropping straight down off one corner.
                let toppleDir = 0;
                if (supported) {
                    const comX = comSum / cells.length;
                    if (comX < supMinX - 2) { supported = false; toppleDir = -1; }
                    else if (comX > supMaxX + 2) { supported = false; toppleDir = 1; }
                }

                if (supported) {
                    // Standing structures can still snap: check load vs. span
                    const fdirty = cells.length > 40 ? this.maybeFractureIsland(cells) : null;
                    if (fdirty) {
                        anyActive = true;
                        if (!dirty) dirty = fdirty;
                        else {
                            dirty.minX = Math.min(dirty.minX, fdirty.minX);
                            dirty.maxX = Math.max(dirty.maxX, fdirty.maxX);
                            dirty.minY = Math.min(dirty.minY, fdirty.minY);
                            dirty.maxY = Math.max(dirty.maxY, fdirty.maxY);
                        }
                    }
                    continue;
                }

                // Find the largest coherent drop (up to ISLAND_FALL_STEP px):
                // every cell's target must be air, water, crushable debris
                // gravel, or another island cell. A toppling island first tries
                // the drop shifted one column toward its centre of mass.
                const inIsland = new Set(cells);
                let drop = 0, dropDx = 0;
                const tryDrop = (dx) => {
                    for (let d = ISLAND_FALL_STEP; d >= 1; d--) {
                        let ok = true;
                        for (const idx of cells) {
                            const cx2 = idx % w;
                            if (cx2 + dx < 0 || cx2 + dx >= w) { ok = false; break; }
                            const t = idx - d * w + dx;
                            if (((t / w) | 0) <= 2) { ok = false; break; } // bedrock rows
                            if (inIsland.has(t)) continue;
                            const tm = grid[t * 4];
                            if (tm !== MAT.AIR && tm !== MAT.WATER && tm !== MAT.DEBRIS) { ok = false; break; }
                        }
                        if (ok) return d;
                    }
                    return 0;
                };
                if (toppleDir !== 0) {
                    drop = tryDrop(toppleDir);
                    if (drop > 0) dropDx = toppleDir;
                }
                if (drop === 0) drop = tryDrop(0);
                if (drop === 0) continue;
                anyActive = true;

                // Move the island: clear old cells, count displaced water at the
                // targets, stamp concrete, then refill vacated cells with the
                // displaced water (topmost vacated cells first — water rises).
                // Debris gravel at the targets is CRUSHED aside as ballistic
                // grains (conserved — the pebbles squirt out and land again).
                let displacedWater = 0;
                for (const idx of cells) grid[idx * 4] = MAT.AIR;
                for (const idx of cells) {
                    const t = idx - drop * w + dropDx;
                    if (grid[t * 4] === MAT.WATER) displacedWater++;
                    else if (grid[t * 4] === MAT.DEBRIS) {
                        this.grains.push({
                            x: t % w, y: (t / w) | 0,
                            vx: (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 110),
                            vy: 40 + Math.random() * 100,
                            mat: MAT.DEBRIS, dust: false, sub: false
                        });
                    }
                    grid[t * 4] = MAT.CONCRETE;
                    grid[t * 4 + 1] = 0;
                    grid[t * 4 + 2] = 0;
                    grid[t * 4 + 3] = 0;
                }
                if (displacedWater > 0) {
                    const vacated = cells
                        .filter(idx => grid[idx * 4] === MAT.AIR)
                        .sort((a, b) => b - a); // highest rows first
                    for (const idx of vacated) {
                        if (displacedWater === 0) break;
                        grid[idx * 4] = MAT.WATER;
                        displacedWater--;
                    }
                }

                // Track the dirty rectangle for a single texture upload
                let minX = w, maxX = 0, minY = h, maxY = 0;
                for (const idx of cells) {
                    const cx = idx % w, cy = (idx / w) | 0;
                    if (cx + Math.min(dropDx, 0) < minX) minX = cx + Math.min(dropDx, 0);
                    if (cx + Math.max(dropDx, 0) > maxX) maxX = cx + Math.max(dropDx, 0);
                    if (cy - drop < minY) minY = cy - drop;
                    if (cy > maxY) maxY = cy;
                }

                // Touchdown: an island whose full-speed drop was cut short is
                // striking ground this tick. The impact jolt loosens the bed
                // under the contact line (it splashes out from under the slab
                // via the automaton), throws a dust line, and thuds.
                if (drop < ISLAND_FALL_STEP && cells.length > 30) {
                    let contacts = 0;
                    for (const idx of cells) {
                        const t = idx - drop * w + dropDx;
                        const bx = t % w, by = (t / w) | 0;
                        if (by - 1 <= 2) continue;
                        const bi = ((by - 1) * w + bx) * 4;
                        if (grid[bi] !== MAT.SAND) continue;
                        contacts++;
                        grid[bi + 1] = 1; // jolted loose
                        const b2 = ((by - 2) * w + bx) * 4;
                        if (by - 2 > 2 && grid[b2] === MAT.SAND) grid[b2 + 1] = 1;
                        if (by - 2 < minY) minY = Math.max(3, by - 2);
                        if (contacts % 7 === 0) {
                            this.spawnFx(0, bx, by + 1,
                                (Math.random() - 0.5) * 40, 15 + Math.random() * 30,
                                0.6 + Math.random() * 0.8);
                        }
                    }
                    if (contacts > 5) {
                        this.addShake(Math.min(4, contacts / 60 + 1));
                        this.audio.bounce((minX + maxX) / 2, 260);
                    }
                }
                if (!dirty) dirty = { minX, maxX, minY, maxY };
                else {
                    dirty.minX = Math.min(dirty.minX, minX);
                    dirty.maxX = Math.max(dirty.maxX, maxX);
                    dirty.minY = Math.min(dirty.minY, minY);
                    dirty.maxY = Math.max(dirty.maxY, maxY);
                }
            }
        }

        if (dirty) {
            this.uploadRegion(dirty.minX, dirty.minY, dirty.maxX - dirty.minX + 1, dirty.maxY - dirty.minY + 1);
        }
        this.islandsActive = anyActive;
    }

    // Stress fracture for a SUPPORTED island: if its longest unsupported bottom
    // span, amplified by the overburden pressing down on that span, exceeds the
    // material's capacity, the beam snaps at the span's centre. The 3px seam
    // shatters into concrete-rubble grains (conserved — they land as pebbles);
    // the two halves become independent islands on the next solver tick.
    maybeFractureIsland(cells) {
        const w = this.width, grid = this.gridData;
        const inIsland = new Set(cells);

        // Per-column extents and bottom support
        const colBottom = new Map(), colTop = new Map();
        for (const idx of cells) {
            const x = idx % w, y = (idx / w) | 0;
            if (!colBottom.has(x) || y < colBottom.get(x)) colBottom.set(x, y);
            if (!colTop.has(x) || y > colTop.get(x)) colTop.set(x, y);
        }
        const xs = [...colBottom.keys()].sort((a, b) => a - b);

        // Longest contiguous run of columns whose bottom cell hangs over nothing
        let runStart = -1, runLen = 0, bestStart = -1, bestLen = 0;
        for (let i = 0; i < xs.length; i++) {
            const x = xs[i];
            const contiguous = i > 0 && xs[i - 1] === x - 1;
            const below = grid[((colBottom.get(x) - 1) * w + x) * 4];
            const unsupported = below !== MAT.SAND && below !== MAT.BEDROCK && below !== MAT.CONCRETE && below !== MAT.OBSIDIAN;
            if (unsupported && (runStart >= 0 ? contiguous : true)) {
                if (runStart < 0 || !contiguous) { runStart = i; runLen = 0; }
                runLen++;
                if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
            } else {
                runStart = -1; runLen = 0;
            }
        }
        if (bestLen < 60) return null;

        // Overburden pressing on the unsupported span (capped scan upward)
        let over = 0;
        for (let i = bestStart; i < bestStart + bestLen; i++) {
            const x = xs[i];
            let y = colTop.get(x) + 1;
            let count = 0;
            while (count < 60 && y < this.height && grid[(y * w + x) * 4] !== MAT.AIR) { count++; y++; }
            over += count;
        }
        const effective = bestLen * (1 + (over / bestLen) / 40);
        if (effective <= 70) return null;

        // Plastic stage: an over-stressed beam SAGS before it snaps — the
        // middle half of the unsupported span shears down 1px per solver tick,
        // visibly bending like real reinforced concrete telegraphing failure.
        if (effective <= 110) {
            const q = bestLen >> 2;
            const sagXs = new Set(xs.slice(bestStart + q, bestStart + bestLen - q));
            const sagCells = cells.filter(idx => sagXs.has(idx % w));
            const sagSet = new Set(sagCells);
            if (sagCells.length === 0) return null;
            for (const idx of sagCells) {
                const t = idx - w;
                if (((t / w) | 0) <= 2 || (!sagSet.has(t) && grid[t * 4] !== MAT.AIR)) return null;
            }
            let minX = w, maxX = -1, minY = this.height, maxY = -1;
            for (const idx of sagCells) {
                grid[idx * 4] = MAT.AIR;
                grid[idx * 4 + 1] = 0;
                grid[idx * 4 + 2] = 0;
                grid[idx * 4 + 3] = 0;
            }
            for (const idx of sagCells) {
                const t = (idx - w) * 4;
                grid[t] = MAT.CONCRETE;
                grid[t + 1] = 0;
                grid[t + 2] = 0;
                grid[t + 3] = 0;
                const x = idx % w, y = (idx / w) | 0;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y - 1 < minY) minY = y - 1;
                if (y > maxY) maxY = y;
            }
            return { minX, maxX, minY, maxY };
        }

        // Snap: shatter a 3px vertical seam at the span centre into rubble
        const seamX = xs[bestStart + (bestLen >> 1)];
        let minX = w, maxX = -1, minY = this.height, maxY = -1;
        for (const idx of cells) {
            const x = idx % w, y = (idx / w) | 0;
            if (Math.abs(x - seamX) > 1) continue;
            this.grains.push({
                x, y,
                vx: (Math.random() - 0.5) * 60,
                vy: -20 - Math.random() * 50,
                mat: MAT.CONCRETE,
                dust: false,
                sub: false
            });
            const gi = idx * 4;
            grid[gi] = MAT.AIR;
            grid[gi + 1] = 0;
            grid[gi + 2] = 0;
            grid[gi + 3] = 0;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        return maxX >= 0 ? { minX, maxX, minY, maxY } : null;
    }

    // ---- Input --------------------------------------------------------------

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
            this.audio.unlock(); // user gesture: allowed to start the AudioContext
            this.isMouseDown = true;
            const pt = getCanvasCoord(e);
            this.mousePos = pt;

            // Slingshot Aim in Sky (domY <= 299 or WebGL y >= 300)
            if (TOOL_ORDNANCE[this.currentTool] !== undefined && pt.domY <= 300) {
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
                // Launch Projectile: V0 = (origin - drag) * k
                const vx = (this.slingshotOrigin.x - this.slingshotCurrent.x) * LAUNCH_POWER;
                const vy = (this.slingshotOrigin.y - this.slingshotCurrent.y) * LAUNCH_POWER;

                const power = Math.hypot(vx, vy);
                if (power > 10.0 && this.projectiles.length < MAX_PROJECTILES) {
                    // The "sky" gate is a fixed row, but the sand horizon and
                    // ejecta piles reach into it: a charge released inside the
                    // ground would start embedded and appear to pass through
                    // it. Lift the spawn point to the first clear cell above.
                    const spec = ORDNANCE_SPECS[TOOL_ORDNANCE[this.currentTool] ?? 'TNT'];
                    let sy = this.slingshotOrigin.y;
                    let lift = 0;
                    while (lift < 64 && isSolidMat(this.matAt(this.slingshotOrigin.x, sy - spec.radius))) { sy += 1; lift += 1; }
                    if (lift < 64) {
                        this.spawnOrdnance(TOOL_ORDNANCE[this.currentTool] ?? 'TNT',
                            this.slingshotOrigin.x, sy, vx, vy);
                        this.audio.launch(power);
                        this.addShake(1.2); // release recoil
                    }
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

    // ---- Frame loop ---------------------------------------------------------

    startLoop() {
        const loop = (timestamp) => {
            this.updateAndRender(timestamp);
            this.animationFrameId = requestAnimationFrame(loop);
        };
        this.animationFrameId = requestAnimationFrame(loop);
    }

    // Dynamic sub-stepping: spend the 16.6ms budget on 4 sub-steps when the
    // frame loop is keeping up, back off toward 2 when frames run long.
    computeSubSteps(timestamp) {
        if (this.lastFrameTimestamp > 0) {
            const delta = Math.min(100, timestamp - this.lastFrameTimestamp);
            this.frameDeltaEma = this.frameDeltaEma * 0.9 + delta * 0.1;
        }
        this.lastFrameTimestamp = timestamp;
        if (this.frameDeltaEma <= 17.5) return 4;
        if (this.frameDeltaEma <= 23.0) return 3;
        return 2;
    }

    updateAndRender(timestamp) {
        const gl = this.gl;
        if (!gl) return;

        const timeSeconds = (timestamp - this.startTime) / 1000.0;
        const running = !this.isPaused || this.pendingStep;
        this.pendingStep = false;

        const subSteps = running ? this.computeSubSteps(timestamp) : 0;
        if (running) this.currentSubSteps = subSteps;

        this.fpsFrames++;
        if (timestamp - this.lastFpsUpdate >= 1000.0) {
            this.currentFps = (this.fpsFrames * 1000.0) / (timestamp - this.lastFpsUpdate);
            this.fpsFrames = 0;
            this.lastFpsUpdate = timestamp;
            if (this.dotNetHelper) {
                this.dotNetHelper.invokeMethodAsync('OnEngineMetricsUpdate', {
                    fps: Math.round(this.currentFps),
                    subSteps: this.currentSubSteps,
                    activeProjectiles: this.projectiles.length,
                    submergedTNTCount: this.submergedTNTCount,
                    activeFluidCells: this.activeFluidCells,
                    activeSandCells: this.activeSandCells,
                    airborneGrains: this.grains.length
                }).catch(() => {});
            }
        }

        // 1. CPU pass: snapshot the grid, run the rigid island solver, then
        //    integrate projectiles against the fresh terrain.
        //    COHERENCE: while ejecta grains are airborne the snapshot MUST be
        //    refreshed every frame — grain landings upload whole dirty rects
        //    from gridData, and a stale rect would revert every other cell in
        //    it to an old state, silently duplicating or destroying matter.
        //    (The texture only changes in our own passes, so a start-of-frame
        //    readback is exactly the current state.)
        // Falling concrete keeps the solver hot: while any island is in motion
        // (or grains are airborne) we refresh and solve EVERY frame, so rigid
        // pieces drop at 240px/s instead of the idle 15Hz cadence.
        if (running && (this.grains.length > 0 || this.islandsActive ||
                        this.frame % SNAPSHOT_INTERVAL === 0)) {
            this.readbackGrid();
            this.solveConcreteIslands();
        }
        if (running) {
            this.updateProjectiles(0.0166);
            this.updateGrains(0.0166);
            this.updateFx(0.0166);
        }
        this.applyShake();

        // 2. Cellular Physics Sub-Steps (skipped while no tier is linked —
        //    the grid still renders, it just does not advance)
        if (this.physicsBuild) this.pollPhysicsBuild();
        const physicsReady = !!this.physicsProgram;
        if (physicsReady) {
            gl.useProgram(this.physicsProgram);
            gl.bindVertexArray(this.quadVAO);
        }

        // Brush parameters: (x, y, radius, material) — brush tool ids double as
        // material ids (0 air, 1 sand, 2 concrete, 3 water, 6 lava, 7 oil)
        let brushUniform = [0, 0, 0, 0];
        if (this.isMouseDown && !this.isSlingshotAiming && BRUSH_TOOLS.has(this.currentTool)) {
            brushUniform = [this.mousePos.x, this.mousePos.y, this.brushRadius, this.currentTool];
        }

        // Active shockwaves (up to MAX_SHOCKWAVES simultaneous blasts)
        const shockwaveData = new Float32Array(MAX_SHOCKWAVES * 4);
        const shockwaveCount = Math.min(this.shockwaves.length, MAX_SHOCKWAVES);
        for (let i = 0; i < shockwaveCount; i++) {
            const sw = this.shockwaves[i];
            shockwaveData.set([sw.x, sw.y, sw.radius, sw.intensity], i * 4);
        }

        if (physicsReady) {
            gl.uniform2f(this.physicsLocs.u_resolution, this.width, this.height);
            gl.uniform1f(this.physicsLocs.u_time, timeSeconds);
            gl.uniform1i(this.physicsLocs.u_frame, this.frame);
            gl.uniform4fv(this.physicsLocs.u_brush, brushUniform);
            gl.uniform4fv(this.physicsLocs.u_shockwaves, shockwaveData);
            gl.uniform1i(this.physicsLocs.u_shockwaveCount, shockwaveCount);
        }

        gl.viewport(0, 0, this.width, this.height);

        // While paused, a held brush still paints with a single sub-step so the
        // sandbox stays editable frame-by-frame.
        const effectiveSteps = physicsReady
            ? (subSteps || (this.isMouseDown && !this.isSlingshotAiming ? 1 : 0))
            : 0;
        for (let step = 0; step < effectiveSteps; step++) {
            const readIndex = this.currentFboIndex;
            const writeIndex = 1 - this.currentFboIndex;

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[writeIndex]);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.textures[readIndex]);
            gl.uniform1i(this.physicsLocs.u_stateTexture, 0);
            gl.uniform1i(this.physicsLocs.u_subStep, step);

            gl.drawArrays(gl.TRIANGLES, 0, 6);
            this.currentFboIndex = writeIndex;
        }

        // 3. Render Pass — into the offscreen scene target when post-FX is
        // active, else straight to the canvas (fallback path)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.postFx ? this.sceneTarget.fbo : null);
        gl.useProgram(this.renderProgram);
        gl.bindVertexArray(this.quadVAO);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[this.currentFboIndex]);
        gl.uniform1i(this.renderLocs.u_stateTexture, 0);
        gl.uniform2f(this.renderLocs.u_resolution, this.width, this.height);
        gl.uniform1f(this.renderLocs.u_time, timeSeconds);
        gl.uniform4fv(this.renderLocs.u_shockwaves, shockwaveData);
        gl.uniform1i(this.renderLocs.u_shockwaveCount, shockwaveCount);

        const projData = new Float32Array(MAX_PROJECTILES * 4);
        const projCount = Math.min(this.projectiles.length, MAX_PROJECTILES);
        for (let i = 0; i < projCount; i++) {
            const p = this.projectiles[i];
            const kind = ORDNANCE_SPECS[p.type]?.kind ?? 0;
            const TAU = Math.PI * 2;
            const ang = ((p.angle % TAU) + TAU) % TAU;
            projData.set([p.x, p.y, p.radius, kind * 10 + ang], i * 4);
        }
        gl.uniform4fv(this.renderLocs.u_projectiles, projData);
        gl.uniform1i(this.renderLocs.u_projectileCount, projCount);
        gl.uniform4f(this.renderLocs.u_aim,
            this.slingshotOrigin.x, this.slingshotOrigin.y,
            this.slingshotCurrent.x, this.slingshotCurrent.y);
        gl.uniform1i(this.renderLocs.u_aimActive, this.isSlingshotAiming ? 1 : 0);

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // 4. Ejecta grain overlay (blast debris in flight)
        const grainCount = Math.min(this.grains.length, MAX_RENDER_GRAINS);
        if (grainCount > 0) {
            for (let i = 0; i < grainCount; i++) {
                const g = this.grains[i];
                this.grainBuffer[i * 3] = g.x;
                this.grainBuffer[i * 3 + 1] = g.y;
                this.grainBuffer[i * 3 + 2] = g.mat + (g.dust ? 10 : 0);
            }
            gl.useProgram(this.grainProgram);
            gl.bindVertexArray(this.grainVAO);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.grainVBO);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.grainBuffer.subarray(0, grainCount * 3));
            gl.uniform2f(this.grainResolutionLoc, this.width, this.height);
            gl.drawArrays(gl.POINTS, 0, grainCount);
        }

        // 5. Post-FX: cosmetic particles into the scene, then bloom + composite
        if (this.postFx) {
            this.drawFxParticles();

            gl.bindVertexArray(this.quadVAO);

            // 5a. Bright-pass extract at half resolution
            gl.useProgram(this.extractProgram);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo);
            gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.tex);
            gl.uniform1i(this.extractLocs.u_scene, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            // 5b. Two separable gaussian blur iterations (A->B->A ...)
            gl.useProgram(this.blurProgram);
            gl.uniform1i(this.blurLocs.u_tex, 0);
            for (let it = 0; it < 2; it++) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fbo);
                gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
                gl.uniform2f(this.blurLocs.u_dir, 1.0 / this.bloomA.w, 0.0);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo);
                gl.bindTexture(gl.TEXTURE_2D, this.bloomB.tex);
                gl.uniform2f(this.blurLocs.u_dir, 0.0, 1.0 / this.bloomA.h);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            }

            // 5c. Composite to canvas: lighting, haze, god rays, glow, vignette
            gl.useProgram(this.compositeProgram);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, this.width, this.height);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.tex);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, this.textures[this.currentFboIndex]);
            gl.uniform1i(this.compositeLocs.u_scene, 0);
            gl.uniform1i(this.compositeLocs.u_bloom, 1);
            gl.uniform1i(this.compositeLocs.u_state, 2);
            gl.uniform2f(this.compositeLocs.u_resolution, this.width, this.height);
            gl.uniform1f(this.compositeLocs.u_time, timeSeconds);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            gl.activeTexture(gl.TEXTURE0);
        }

        this.frame++;
    }

    // FX particles draw in two batches over the scene: smoke with standard
    // alpha blending, embers/sparks additively so they read as incandescent.
    drawFxParticles() {
        const n = Math.min(this.fx.length, MAX_FX);
        if (n === 0) return;
        const gl = this.gl;
        let smoke = 0;
        let glow = n;
        // Pack smoke first, then glow (embers + sparks), into one buffer
        for (let i = 0; i < n; i++) {
            const p = this.fx[i];
            const lifeFrac = Math.max(0, Math.min(1, p.life / p.maxLife));
            if (p.type === 0) {
                const o = smoke++ * 4;
                this.fxBuffer[o] = p.x; this.fxBuffer[o + 1] = p.y;
                this.fxBuffer[o + 2] = p.type; this.fxBuffer[o + 3] = lifeFrac;
            } else {
                const o = --glow * 4;
                this.fxBuffer[o] = p.x; this.fxBuffer[o + 1] = p.y;
                this.fxBuffer[o + 2] = p.type; this.fxBuffer[o + 3] = lifeFrac;
            }
        }
        gl.useProgram(this.fxProgram);
        gl.bindVertexArray(this.fxVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVBO);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.fxBuffer.subarray(0, n * 4));
        gl.uniform2f(this.fxLocs.u_resolution, this.width, this.height);
        gl.enable(gl.BLEND);
        if (smoke > 0) {
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.drawArrays(gl.POINTS, 0, smoke);
        }
        if (glow < n) {
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.drawArrays(gl.POINTS, glow, n - glow);
        }
        gl.disable(gl.BLEND);
        gl.bindVertexArray(null);
    }

    spawnFx(type, x, y, vx, vy, life) {
        if (this.fx.length >= MAX_FX) return;
        this.fx.push({ type, x, y, vx, vy, life, maxLife: life });
    }

    updateFx(dt) {
        // Continuous emitters: embers drift off molten surfaces, thin smoke
        // curls off burning cells (positions sampled during the grid census)
        if (this.lavaSurface.length > 0 && Math.random() < 0.5) {
            const s = this.lavaSurface[(Math.random() * this.lavaSurface.length) | 0];
            this.spawnFx(1, s.x + (Math.random() - 0.5) * 3, s.y + 1,
                (Math.random() - 0.5) * 14, 18 + Math.random() * 30, 1.2 + Math.random() * 1.6);
        }
        if (this.firePositions.length > 0 && Math.random() < 0.6) {
            const s = this.firePositions[(Math.random() * this.firePositions.length) | 0];
            this.spawnFx(0, s.x + (Math.random() - 0.5) * 3, s.y + 2,
                (Math.random() - 0.5) * 8, 22 + Math.random() * 20, 1.0 + Math.random() * 1.5);
        }

        for (let i = this.fx.length - 1; i >= 0; i--) {
            const p = this.fx[i];
            p.life -= dt;
            if (p.type === 0) {
                // Smoke: buoyant, wandering, air-dragged
                p.vy += 26 * dt;
                p.vx = p.vx * 0.985 + (Math.random() - 0.5) * 10 * dt;
            } else if (p.type === 1) {
                // Ember: rises on the thermal, flickers sideways
                p.vy += 14 * dt;
                p.vx = p.vx * 0.98 + (Math.random() - 0.5) * 30 * dt;
            } else {
                // Spark: ballistic and fast-burning
                p.vy -= 500 * dt;
            }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.life <= 0 || p.x < 0 || p.x > this.width || p.y < 0 || p.y > this.height ||
                (p.type !== 0 && isSolidMat(this.matAt(p.x, p.y)))) {
                this.fx[i] = this.fx[this.fx.length - 1];
                this.fx.pop();
            }
        }
    }

    // Camera shake is a CSS transform on the canvas so simulation/input
    // coordinates stay exact; it decays exponentially each frame.
    addShake(amp) {
        this.shakeAmp = Math.min(14, this.shakeAmp + amp);
    }

    applyShake() {
        if (this.shakeAmp > 0.15) {
            const dx = (Math.random() - 0.5) * 2 * this.shakeAmp;
            const dy = (Math.random() - 0.5) * 2 * this.shakeAmp;
            this.canvas.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
            this.shakeAmp *= 0.88;
        } else if (this.shakeAmp !== 0) {
            this.shakeAmp = 0;
            this.canvas.style.transform = '';
        }
    }

    // ---- Blast ejecta -------------------------------------------------------

    // Polar occlusion map: march 360 rays outward once, recording how far each
    // ray reaches before it has chewed through BLAST_SOLID_BUDGET px of solid.
    // Cells beyond their ray's reach are shielded — blasts carve bowl craters,
    // channel through tunnels, and are stopped by concrete walls.
    computeBlastReach(cx, cy, maxR, solidBudget = BLAST_SOLID_BUDGET) {
        const rays = 360;
        const reach = new Float32Array(rays);
        const step = (Math.PI * 2) / rays;
        for (let a = 0; a < rays; a++) {
            const ux = Math.cos(a * step), uy = Math.sin(a * step);
            let solid = 0, t = 2;
            for (; t < maxR; t += 2) {
                if (isSolidMat(this.matAt(cx + ux * t, cy + uy * t))) {
                    solid += 2;
                    if (solid > solidBudget) break;
                }
            }
            reach[a] = t;
        }
        return reach;
    }

    // scale multiplies the crater radius / shockwave / ray budget (bomblets
    // ~0.4, nuke ~1.45); bodyR is the casing radius shattered into red debris.
    detonateBlast(cx, cy, exclude, scale = 1.0, bodyR = 6) {
        // Fresh snapshot so the crater is cut from the true current terrain
        this.ensureFreshSnapshot();
        const submergedBlast = this.matAt(cx, cy) === MAT.WATER;

        const w = this.width, h = this.height, grid = this.gridData;
        // Depth of burial governs the blast's character, and it does so as a
        // continuous curve rather than in three bands (ported from Sand2; the
        // old `burial > 70 ? … : burial < 12 ? … : …` step function made a
        // charge 69 cells down behave exactly like a surface burst, then
        // snapped to a camouflet one cell deeper).
        //
        // Crater volume peaks near 0.55 R of overburden. A surface burst vents
        // its energy to the air — wide shallow scoop, big airblast, little
        // ejecta; optimal burial couples the charge into the ground; a deeply
        // buried shot vents nothing at all, sealing a camouflet cavity and
        // lifting the ground above it into a heave dome instead of throwing
        // ejecta. Sand2 measured 3518 cells dug at the surface, 8425 at
        // optimal burial, 5261 deep.
        let burial = 0;
        for (let t = 1; t <= 220; t++) {
            if (isSolidMat(this.matAt(cx, cy + t))) burial++;
        }
        const dob = burial / CRATER_RADIUS;                       // scaled depth of burst
        const coupling = Math.exp(-Math.pow((dob - 0.55) / 0.45, 2));
        const vent = Math.max(0, Math.min(1, 1.15 - dob * 1.05)); // fraction that escapes
        // `camouflet` survives as the "nothing vents" predicate the rest of
        // this method already branches on (no dust, no glass lining, no
        // fracture seams, muffled report) — it is now a threshold on vent
        // rather than a hard depth band.
        const camouflet = vent < 0.12;
        const rScale = (0.62 + 0.55 * coupling) * scale;
        const spScale = 0.35 + 0.65 * vent;
        const upBias = 15 + 115 * vent;
        // Sand that cannot vent, collected during excavation and stacked back
        // onto the surface below (heave dome).
        const heave = [];

        const sandR = Math.round(CRATER_RADIUS * rScale);   // sand excavation
        const scorchR = sandR + 14;               // charred crater lining
        // Water is thrown farther; underwater the incompressible coupling
        // (water hammer) carries the shock farther still
        const waterR = Math.round(sandR * 1.4 * (submergedBlast ? 1.35 : 1.0));
        const ringR = sandR * 2;                  // surviving water gets outward surge
        const reach = this.computeBlastReach(cx, cy, ringR, BLAST_SOLID_BUDGET * scale);

        const x0 = Math.max(1, Math.round(cx - ringR)), x1 = Math.min(w - 2, Math.round(cx + ringR));
        const y0 = Math.max(3, Math.round(cy - ringR)), y1 = Math.min(h - 1, Math.round(cy + ringR));
        let minX = w, maxX = -1, minY = h, maxY = -1;
        const touch = (x, y) => {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        };

        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const dx = x - cx, dy = y - cy;
                const dist = Math.hypot(dx, dy);
                if (dist > ringR) continue;
                const idx = (y * w + x) * 4;
                const m = grid[idx];
                const solidLike = m === MAT.SAND || m === MAT.DEBRIS || m === MAT.OBSIDIAN;
                const liquidLike = isLiquidMat(m);
                const concrete = m === MAT.CONCRETE;
                if (!solidLike && !liquidLike && !concrete && m !== MAT.FIRE) continue; // bedrock immune

                let ai = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
                if (ai < 0) ai += 360;
                if (dist > reach[ai % 360]) continue;            // shielded

                if (m === MAT.FIRE) {
                    // The pressure wave blows flames out (non-conserved gas)
                    grid[idx] = MAT.AIR;
                    grid[idx + 1] = 0;
                    touch(x, y);
                    continue;
                }

                let ux, uy;
                if (dist < 0.5) {
                    const a = Math.random() * Math.PI * 2;
                    ux = Math.cos(a); uy = Math.sin(a);
                } else {
                    ux = dx / dist; uy = dy / dist;
                }

                if (concrete) {
                    // Reinforced concrete is not immune, it fails like concrete:
                    // pulverized to gravel-sized rubble in the fireball core
                    // (radial cracking beyond is seeded after this loop). The
                    // rubble grains are conserved and land as loose gravel.
                    if (dist <= sandR * 0.45) {
                        const speed = EJECTA_SPEED * spScale * 0.55 *
                                      (0.35 + 0.65 * (1 - dist / (sandR * 0.45))) *
                                      (0.7 + Math.random() * 0.6);
                        this.grains.push({
                            x, y,
                            vx: ux * speed + (Math.random() - 0.5) * 60,
                            vy: uy * speed + upBias * 0.7 + Math.random() * 60,
                            mat: MAT.DEBRIS,
                            dust: Math.random() < 0.2,
                            sub: false
                        });
                        grid[idx] = MAT.AIR;
                        grid[idx + 1] = 0;
                        grid[idx + 2] = 0;
                        grid[idx + 3] = 0;
                        touch(x, y);
                    }
                    continue;
                }

                if (solidLike) {
                    if (dist <= sandR) {
                        // Displace: eject as a ballistic grain (25% fine dust).
                        // Overburden-compacted ground (negative looseness)
                        // absorbs more of the shock: no dust, slower throw.
                        const packed = m === MAT.SAND && grid[idx + 1] < -0.1;
                        const dust = m === MAT.SAND && !camouflet && !packed && Math.random() < 0.25;
                        grid[idx] = MAT.AIR;
                        grid[idx + 1] = 0;
                        grid[idx + 2] = 0;
                        grid[idx + 3] = 0;
                        touch(x, y);
                        // Material that cannot vent does not erupt — it lifts
                        // the overburden. Deferred to after this loop so the
                        // excavation keeps reading the pre-blast terrain.
                        if (m === MAT.SAND && Math.random() > vent) {
                            heave.push(m);
                            continue;
                        }
                        // Inverted-cone ejection graded by radius: near-vertical
                        // over the centre, ~45 deg at the rim, which is the
                        // shape real crater throw-out leaves (from Sand2 — the
                        // old fixed 45 deg threw the whole crater sideways, so
                        // the centre never fountained). The slow "rim" fraction
                        // lands at the lip and builds the raised crater rim.
                        const tNorm = Math.min(1, dist / Math.max(1, sandR));
                        const side = dx === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dx);
                        // 70 deg over the centre grading to 45 deg at the rim.
                        // Sand2 goes fully vertical (90 deg) at the centre; this
                        // engine must not, because its sand is Mohr-Coulomb
                        // cohesive and cements whatever lands on it, while
                        // Sand2's relaxes to a 32 deg repose. Straight-up ejecta
                        // falls back onto the columns it left and stands there.
                        // Measured over 45 s of settling: full-vertical left
                        // three sharp needles, 70 deg left two broader mounds.
                        // Steep ejecta mounds are NOT new here — the pre-change
                        // engine builds them too (verified against HEAD), so this
                        // is a mitigation of a standing quirk, not a regression
                        // fix. The real cure is a true angle of repose; see the
                        // sand/water realism notes.
                        const ang = Math.PI * 0.39 * (1 - tNorm) + Math.PI * 0.25 * tNorm;
                        let ex = ux, ey = uy;
                        if (!camouflet) { ex = Math.cos(ang) * side; ey = Math.sin(ang); }
                        const rim = !camouflet && !dust && Math.random() < 0.30;
                        const speed = EJECTA_SPEED * spScale * (0.35 + 0.65 * (1 - dist / sandR)) *
                                      (0.7 + Math.random() * 0.6) * (dust ? 0.55 : 1.0) *
                                      (packed ? 0.8 : 1.0) * (rim ? 0.32 : 1.0);
                        this.grains.push({
                            x, y,
                            vx: ex * speed + (Math.random() - 0.5) * 60,
                            vy: ey * speed + upBias + Math.random() * 70,
                            mat: m,
                            dust,
                            sub: false,
                            // Staged curtain: excavation flows outward over
                            // ~10 frames rather than all at once, so the
                            // throw-out grows instead of starbursting.
                            delay: camouflet ? 0 : Math.round(tNorm * 8 + Math.random() * 2)
                        });
                    } else if (m === MAT.SAND && dist <= scorchR && !camouflet) {
                        // Fireball fuses the inner lining to glass, chars the rest
                        grid[idx + 2] = dist <= sandR + 5 ? -2 : -1;
                        touch(x, y);
                    }
                } else {
                    if (dist <= waterR) {
                        // Liquid column thrown up; near the core water flashes
                        // to slow-drifting steam mist that condenses back down
                        const steam = m === MAT.WATER && dist < 20;
                        const speed = EJECTA_SPEED * 1.1 * (0.35 + 0.65 * (1 - dist / waterR)) *
                                      (0.7 + Math.random() * 0.6);
                        this.grains.push({
                            x, y,
                            vx: ux * speed + (Math.random() - 0.5) * 80,
                            vy: uy * speed + 110 + Math.random() * 90 + (steam ? 220 : 0),
                            mat: m,
                            dust: steam,
                            sub: false
                        });
                        grid[idx] = MAT.AIR;
                        grid[idx + 1] = 0;
                        grid[idx + 2] = 0;
                        grid[idx + 3] = 0;
                        touch(x, y);
                    } else if (m === MAT.WATER) {
                        // Surviving outer water takes an outward surge impulse
                        grid[idx + 1] = dx >= 0 ? 1 : -1;
                        touch(x, y);
                    } else if (m === MAT.OIL) {
                        // The fireball ignites the surviving oil ring
                        grid[idx] = MAT.FIRE;
                        grid[idx + 1] = 1;
                        grid[idx + 2] = 0;
                        grid[idx + 3] = 0;
                        touch(x, y);
                    }
                }
            }
        }

        // Heave dome (from Sand2): the excavated mass that could not vent is
        // stacked back onto the surface over the charge, so a deep shot mounds
        // the ground instead of cratering it, and the sealed cavity is left
        // below to collapse later. stampGrain walks up to the first air cell,
        // so seeding it one cell above the pre-blast column top lands each
        // grain on the surface rather than back inside the fresh crater.
        if (heave.length) {
            const hx0 = Math.max(1, Math.round(cx - sandR * 1.4));
            const hx1 = Math.min(w - 2, Math.round(cx + sandR * 1.4));
            const top = new Int32Array(Math.max(0, hx1 - hx0 + 1));
            for (let x = hx0; x <= hx1; x++) {
                let ty = h - 1;
                while (ty > 3 && !isSolidMat(this.matAt(x, ty))) ty--;
                top[x - hx0] = ty;
            }
            for (let i = 0; i < heave.length; i++) {
                const hx = Math.max(hx0, Math.min(hx1,
                    Math.round(cx + (Math.random() + Math.random() - 1) * sandR * 1.3)));
                const k = hx - hx0;
                const spot = this.stampGrain(hx, top[k] + 1, heave[i]);
                if (spot) {
                    touch(spot.x, spot.y);
                    if (spot.y > top[k]) top[k] = spot.y;
                }
            }
        }

        // Blast cracking: radial fracture seams chew 1px lines through the
        // concrete within range, splitting slabs into independent islands the
        // rigid solver then drops, sags, topples, or snaps. Seam cells become
        // conserved rubble grains, exactly like the stress-fracture seam.
        if (!camouflet) {
            const seams = 2 + Math.round(scale * 2);
            for (let s = 0; s < seams; s++) {
                const a = Math.random() * Math.PI * 2;
                const sx = Math.cos(a), sy = Math.sin(a);
                let chew = 0;
                for (let t = 4; t < sandR && chew < 90; t += 1) {
                    const x = Math.round(cx + sx * t), y = Math.round(cy + sy * t);
                    if (x < 1 || x > w - 2 || y <= 3 || y >= h - 1) break;
                    const idx = (y * w + x) * 4;
                    if (grid[idx] !== MAT.CONCRETE) continue;
                    chew++;
                    this.grains.push({
                        x, y,
                        vx: (Math.random() - 0.5) * 160,
                        vy: 60 + Math.random() * 120,
                        mat: MAT.CONCRETE,
                        dust: false,
                        sub: false
                    });
                    grid[idx] = MAT.AIR;
                    grid[idx + 1] = 0;
                    grid[idx + 2] = 0;
                    grid[idx + 3] = 0;
                    touch(x, y);
                }
            }
        }

        if (maxX >= 0) {
            this.uploadRegion(minX, minY, maxX - minX + 1, maxY - minY + 1);
        }

        // The bomb's own matter survives: its casing shatters into red debris
        // grains (one per body cell) that fly with the blast and land as
        // permanent red gravel — nothing about the bomb vanishes.
        for (let dy = -bodyR; dy <= bodyR; dy++) {
            for (let dx = -bodyR; dx <= bodyR; dx++) {
                const dist = Math.hypot(dx, dy);
                if (dist > bodyR) continue;
                let ux, uy;
                if (dist < 0.5) {
                    const a = Math.random() * Math.PI * 2;
                    ux = Math.cos(a); uy = Math.sin(a);
                } else {
                    ux = dx / dist; uy = dy / dist;
                }
                // Heavy casing chunks: slower than the soil ejecta so the red
                // gravel lands around the crater instead of leaving the map.
                // Each body cell shatters into 3 fragments — a visible red
                // debris field rather than scattered single pixels.
                for (let f = 0; f < 3; f++) {
                    const speed = 220 + Math.random() * 220;
                    this.grains.push({
                        x: cx + dx,
                        y: cy + dy,
                        vx: ux * speed + (Math.random() - 0.5) * 120,
                        vy: uy * speed + 120 + Math.random() * 100,
                        mat: MAT.DEBRIS,
                        dust: false,
                        sub: false
                    });
                }
            }
        }

        // Air-blast wind: the expanding pressure wave shoves every airborne
        // grain radially — dust clouds and ejecta curtains billow away
        const windR = ringR * 2;
        for (const g of this.grains) {
            const d = Math.hypot(g.x - cx, g.y - cy);
            if (d > windR || d < 0.5) continue;
            const push = (camouflet ? 200 : 650) * (1 - d / windR);
            g.vx += ((g.x - cx) / d) * push;
            g.vy += ((g.y - cy) / d) * push * 0.5;
        }

        // Air-blast impulse knocks nearby ordnance flying (and shakes stuck
        // charges loose). Water transmits the shock farther (incompressible).
        const kickR = 400 * Math.max(1, scale) * (submergedBlast ? 1.4 : 1);
        for (const q of this.projectiles) {
            if (q === exclude) continue;
            const d = Math.hypot(q.x - cx, q.y - cy);
            if (d > kickR || d < 0.5) continue;
            const kick = 900 * (1 - d / kickR);
            q.stuck = false;
            q.vx += ((q.x - cx) / d) * kick;
            q.vy += ((q.y - cy) / d) * kick + 90;
        }

        if (this.shockwaves.length >= MAX_SHOCKWAVES) this.shockwaves.shift();
        this.shockwaves.push({ x: cx, y: cy, radius: 10, maxRadius: Math.round(340 * rScale), intensity: 1.0 });

        // Juice: bang, kick, buzz, and a lingering smoke plume off the crater
        this.audio.explosion(cx, scale, submergedBlast || camouflet);
        this.addShake(4 * scale + 2);
        try { navigator.vibrate?.(Math.min(220, Math.round(90 * scale))); } catch { /* unsupported */ }
        if (!submergedBlast) {
            const plumes = Math.round(50 * scale);
            for (let i = 0; i < plumes; i++) {
                const a = Math.random() * Math.PI;
                const r = Math.random() * sandR * 0.6;
                this.spawnFx(0,
                    cx + Math.cos(a) * r, cy + Math.abs(Math.sin(a)) * r * 0.5 + 4,
                    (Math.random() - 0.5) * 30, 20 + Math.random() * 55,
                    1.5 + Math.random() * 2.5);
            }
        }
    }

    // Drop one grain back into the grid at its landing spot; grains landing on
    // an occupied cell pile upward, keeping the 1-cell-per-grain invariant.
    // Sediment reaching a submerged bed swaps with the water it displaces
    // (Archimedes: the water rises to the first open cell above) so both
    // materials stay exactly conserved.
    stampGrain(x, y, mat) {
        const cx = Math.round(x);
        let cy = Math.max(3, Math.min(this.height - 1, Math.round(y)));
        const grid = this.gridData;

        if (mat !== MAT.WATER && this.matAt(cx, cy) === MAT.WATER) {
            let airY = cy + 1;
            let guard = 0;
            while (airY < this.height - 1 && this.matAt(cx, airY) !== MAT.AIR && guard++ < 300) airY++;
            if (this.matAt(cx, airY) === MAT.AIR) {
                const idx = (cy * this.width + cx) * 4;
                grid[idx] = mat;
                grid[idx + 1] = mat === MAT.WATER ? 0 : 1;
                grid[idx + 2] = mat === MAT.SAND ? 1 : 0; // sand lands saturated
                grid[idx + 3] = 0;
                const aIdx = (airY * this.width + cx) * 4;
                grid[aIdx] = MAT.WATER;
                grid[aIdx + 1] = 0;
                grid[aIdx + 2] = 0;
                grid[aIdx + 3] = 0;
                return { x: cx, y: airY }; // dirty rect must span both cells
            }
            // Column sealed to the top: fall through to the pile-up path
        }

        let guard = 0;
        while (cy < this.height - 1 && this.matAt(cx, cy) !== MAT.AIR && guard++ < 300) cy++;
        if (this.matAt(cx, cy) !== MAT.AIR) return null;
        const idx = (cy * this.width + cx) * 4;
        grid[idx] = mat;
        grid[idx + 1] = mat === MAT.WATER ? 0 : 1; // land loose, then settle
        grid[idx + 2] = 0;
        grid[idx + 3] = 0;
        return { x: cx, y: cy };
    }

    updateGrains(dt) {
        if (this.grains.length === 0) return;
        const w = this.width, h = this.height;
        let minX = w, maxX = -1, minY = h, maxY = -1;

        // Mid-air crowding: dense ejecta curtains jostle instead of ghosting
        // through each other — a grain entering an occupied cell loses speed.
        // Grains still waiting on their staged-launch delay are not in flight
        // yet, so they must not crowd: a big crater parks thousands of them on
        // its own cells for a few frames, and counting those would damp every
        // grain that flew through the crater mouth.
        const occ = new Set();
        for (const g of this.grains) {
            if (g.delay > 0) continue;
            occ.add((Math.round(g.y) << 10) | Math.round(g.x));
        }

        for (let i = this.grains.length - 1; i >= 0; i--) {
            const g = this.grains[i];
            // Staged ejecta curtain (from Sand2): a grain launched from the
            // crater rim leaves later than one from the centre, so throw-out
            // reads as an expanding curtain rather than one instantaneous
            // starburst. Counted in frames, matching how it was authored.
            if (g.delay > 0) { g.delay--; continue; }
            g.vy -= (g.sub ? GRAVITY * 0.3 : GRAVITY) * dt;

            if (g.dust) {
                // Fine particles: strong air drag, low terminal velocity — the
                // lingering cloud that settles seconds after the blast
                g.vx *= 0.90;
                if (g.vy < -45) g.vy = -45;
            }
            if (g.sub) {
                // Submerged sediment sinks slowly and drifts with the current
                // (reads the water's momentum channel), so flowing breaches
                // carry their load downstream and deposit it where flow calms
                g.vx *= 0.85;
                if (g.vy < -55) g.vy = -55;
                const ci = (Math.round(g.y) * w + Math.round(g.x)) * 4;
                if (this.gridData[ci] === MAT.WATER) {
                    g.vx += this.gridData[ci + 1] * 140 * dt;
                }
            }

            const steps = Math.max(1, Math.ceil(Math.hypot(g.vx, g.vy) * dt / 1.5));
            const sx = g.vx * dt / steps, sy = g.vy * dt / steps;
            let landed = false, gone = false;

            for (let s = 0; s < steps; s++) {
                const nx = g.x + sx, ny = g.y + sy;
                if (nx < 1 || nx > w - 2) { gone = true; break; } // lateral drains: the one allowed loss
                if (ny < h && ny > 3) {
                    const m = this.matAt(nx, ny);
                    if (m === MAT.WATER) {
                        if (g.mat === MAT.WATER) { landed = true; break; } // droplet merges
                        if (!g.sub) {
                            // Sand/rubble plunges in: velocity absorbed by the splash
                            g.sub = true;
                            g.vx *= 0.4;
                            g.vy *= 0.35;
                        }
                    } else if (m !== MAT.AIR) {
                        landed = true;
                        break;
                    } else if (g.sub) {
                        g.sub = false; // sank through into an air cavern below
                    }
                } else if (ny <= 3) {
                    landed = true;
                    break;
                }
                const key = (Math.round(ny) << 10) | Math.round(nx);
                if (occ.has(key) && s === 0 && Math.random() < 0.3) {
                    g.vx *= 0.6;
                    g.vy *= 0.6;
                }
                g.x = nx; g.y = ny;
            }

            if (landed) {
                // Shrapnel: fast red casing fragments strike like bullets,
                // kicking out the sand they hit (conserved secondary ejecta)
                if (g.mat === MAT.DEBRIS && Math.hypot(g.vx, g.vy) > 350) {
                    const bx = Math.round(g.x), by = Math.round(g.y) - 1;
                    const bi = (by * w + bx) * 4;
                    if (by > 3 && this.gridData[bi] === MAT.SAND) {
                        this.grains.push({
                            x: bx, y: by,
                            vx: (Math.random() - 0.5) * 200,
                            vy: 90 + Math.random() * 130,
                            mat: MAT.SAND, dust: false, sub: false
                        });
                        this.gridData[bi] = MAT.AIR;
                        this.gridData[bi + 1] = 0;
                        this.gridData[bi + 2] = 0;
                        this.gridData[bi + 3] = 0;
                        if (bx < minX) minX = bx;
                        if (bx > maxX) maxX = bx;
                        if (by < minY) minY = by;
                        if (by > maxY) maxY = by;
                    }
                }
                const spot = this.stampGrain(g.x, g.y, g.mat);
                if (spot) {
                    if (spot.x < minX) minX = spot.x;
                    if (spot.x > maxX) maxX = spot.x;
                    if (spot.y - 1 < minY) minY = Math.max(3, spot.y - 1);
                    if (spot.y > maxY) maxY = spot.y;
                    // Underwater swaps touch two cells in the column; widen the
                    // dirty rect down to the original landing row
                    const low = Math.max(3, Math.min(spot.y, Math.round(g.y)) - 1);
                    if (low < minY) minY = low;
                }
                gone = true;
            }
            if (gone) {
                this.grains[i] = this.grains[this.grains.length - 1];
                this.grains.pop();
            }
        }

        if (maxX >= 0) {
            this.uploadRegion(minX, minY, maxX - minX + 1, maxY - minY + 1);
        }
    }

    // ---- Ordnance -----------------------------------------------------------

    updateProjectiles(dt) {
        // Auto-drop demo ordnance: rain a random bomb from the sky every second
        if (this.autoDropEnabled) {
            this.autoDropTimer += dt;
            if (this.autoDropTimer >= 1.0) {
                this.autoDropTimer -= 1.0;
                this.spawnRandomOrdnance();
            }
        }

        // Update Shockwave expansion & decay
        for (let i = this.shockwaves.length - 1; i >= 0; i--) {
            const sw = this.shockwaves[i];
            sw.radius += 460.0 * dt;
            sw.intensity -= 1.2 * dt;
            if (sw.intensity <= 0 || sw.radius >= sw.maxRadius) {
                this.shockwaves.splice(i, 1);
            }
        }

        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];

            // Molten heat cooks off any ordnance instantly (balloon flashes to
            // steam-spray; explosives sympathetically detonate)
            if (this.matAt(p.x, p.y) === MAT.LAVA ||
                this.matAt(p.x, p.y - p.radius) === MAT.LAVA) {
                this.explodeProjectile(p);
                this.projectiles.splice(i, 1);
                continue;
            }

            // A stuck charge just counts down; it un-sticks if its anchor cell
            // is dug or blasted away (or a nearby blast kicks it loose).
            if (p.stuck) {
                if (isSolidMat(this.matAt(p.ax, p.ay))) {
                    p.timer -= dt;
                    if (p.timer <= 0) {
                        this.explodeProjectile(p);
                        this.projectiles.splice(i, 1);
                    }
                    continue;
                }
                p.stuck = false;
            }

            const inWater = this.matAt(p.x, p.y) === MAT.WATER ||
                            this.matAt(p.x, p.y - p.radius) === MAT.WATER;

            // Entry splash: hitting the surface at speed throws up a plume of
            // real surface-water cells (conserving — they rain back down)
            if (inWater && !p.wasInWater && p.vy < -120) {
                this.splashWaterEntry(p);
            }
            // Volume displacement while submerged: the sphere occupies space,
            // so overlapped water is pushed up its column (Archimedes — the
            // surface visibly rises; water closes back in when the bomb moves)
            if (inWater || p.wasInWater) {
                this.displaceSubmergedVolume(p);
            }
            p.wasInWater = inWater;

            // Integrate: gravity (buoyant drag in water/oil), substepped to
            // avoid tunneling through thin terrain at slingshot speeds.
            const inOil = !inWater && this.matAt(p.x, p.y) === MAT.OIL;
            const gravity = inWater || inOil ? GRAVITY * 0.25 : GRAVITY;
            p.vy -= gravity * dt;
            if (inWater || inOil) {
                p.vx *= 0.92;
                p.vy *= 0.92;
            }

            const moveLen = Math.hypot(p.vx, p.vy) * dt;
            const moveSteps = Math.max(1, Math.ceil(moveLen / 2.0));
            let burst = false;
            if (p.type === 'DRILL') p.carving = false;
            for (let s = 0; s < moveSteps && !burst; s++) {
                p.x += (p.vx * dt) / moveSteps;
                p.y += (p.vy * dt) / moveSteps;
                burst = p.type === 'DRILL'
                    ? this.drillStep(p)
                    : this.resolveProjectileCollision(p);
            }
            if (!burst && (p.type === 'TNT' || p.type === 'NUKE' ||
                           p.type === 'CLUSTER' || p.type === 'BOMBLET')) {
                this.rollOnSlope(p, dt);
            }
            // Spin: rotation follows contact velocity (set in rollOnSlope and
            // at bounces); the drill instead keeps its nose on the velocity
            // vector (set in drillStep).
            if (p.type !== 'DRILL') p.angle += p.omega * dt;
            p.splash = Math.max(0, p.splash - dt);

            if (burst) {
                this.explodeProjectile(p);
                this.projectiles.splice(i, 1);
                continue;
            }

            // Lateral drainage: ordnance leaving the viewport is gone
            if (p.x < -10 || p.x > this.width + 10) {
                this.projectiles.splice(i, 1);
                continue;
            }

            // Fuse burns on land and underwater alike; a submerged blast
            // ejects the surrounding water column and the remaining body of
            // water then pours into the freshly opened crater via the fluid CA.
            // (Balloon has no fuse — it is purely impact-detonated.)
            if (p.type !== 'BALLOON') {
                p.timer -= dt;
                if (p.timer <= 0) {
                    this.explodeProjectile(p);
                    this.projectiles.splice(i, 1);
                }
            }
        }

        // Drill grind loop follows whichever drill is actively boring
        const activeDrill = this.projectiles.find(q => q.type === 'DRILL' && q.carving);
        this.audio.drill(!!activeDrill, activeDrill ? activeDrill.x : 400);
    }

    explodeProjectile(p) {
        const spec = ORDNANCE_SPECS[p.type] ?? ORDNANCE_SPECS.TNT;
        switch (p.type) {
            case 'BALLOON':
                // Instantaneous 360° pressurized fluid discharge
                this.sprayWaterBurst(Math.round(p.x), Math.round(p.y), 16);
                this.audio.balloonPop(p.x);
                break;
            case 'CLUSTER':
                this.popCluster(p);
                break;
            default:
                this.detonateBlast(p.x, p.y, p, spec.scale ?? 1.0, p.radius);
                break;
        }
    }

    // Cluster shell: a small opening pop, then a fan of live bomblets that
    // scatter, bounce, and detonate on short randomized fuses.
    popCluster(p) {
        this.detonateBlast(p.x, p.y, p, ORDNANCE_SPECS.CLUSTER.scale, p.radius);
        const n = 7;
        for (let i = 0; i < n; i++) {
            if (this.projectiles.length >= MAX_PROJECTILES) break;
            const a = Math.PI * (0.15 + 0.7 * (i / (n - 1)));
            const sp = 160 + Math.random() * 180;
            this.projectiles.push({
                type: 'BOMBLET',
                x: p.x, y: p.y + 4,
                vx: Math.cos(a) * sp + p.vx * 0.3,
                vy: Math.sin(a) * sp + 60,
                radius: ORDNANCE_SPECS.BOMBLET.radius,
                timer: 0.8 + Math.random() * 0.9,
                angle: Math.PI / 2,
                omega: (Math.random() - 0.5) * 20,
                splash: 0,
                stuck: false
            });
        }
    }

    // Bunker-buster: never bounces — it bores along its velocity vector,
    // converting every carved cell into slow backward spoil grains (displaced,
    // not destroyed) until its chew budget runs out, it stalls, or it meets
    // bedrock; then it detonates at depth. Returns true when it should explode.
    drillStep(p) {
        const speed = Math.hypot(p.vx, p.vy);
        if (speed > 1) p.angle = Math.atan2(p.vy, p.vx);
        const ux = speed > 1 ? p.vx / speed : 0;
        const uy = speed > 1 ? p.vy / speed : -1;
        const tipM = this.matAt(p.x + ux * p.radius, p.y + uy * p.radius);
        if (tipM === MAT.BEDROCK) return true;
        if (!isSolidMat(tipM)) return false;      // free flight / liquid
        if (speed < 60) return true;              // stalled in the ground

        this.ensureFreshSnapshot();
        const w = this.width, grid = this.gridData;
        const R = 4;
        const cx = Math.round(p.x + ux * p.radius), cy = Math.round(p.y + uy * p.radius);
        let minX = w, maxX = -1, minY = this.height, maxY = -1;
        for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
                if (Math.hypot(dx, dy) > R) continue;
                const x = cx + dx, y = cy + dy;
                if (x < 1 || x > w - 2 || y <= 3 || y >= this.height) continue;
                const idx = (y * w + x) * 4;
                const m = grid[idx];
                if (!isSolidMat(m) || m === MAT.BEDROCK) continue;
                // Overburden-compacted sand (negative looseness) bores at
                // double cost — deep packed strata resist the bit
                p.budget -= (m === MAT.CONCRETE || m === MAT.OBSIDIAN) ? 3
                          : (m === MAT.SAND && grid[idx + 1] < -0.1) ? 2 : 1;
                this.grains.push({
                    x, y,
                    vx: -ux * (40 + Math.random() * 90) + (Math.random() - 0.5) * 80,
                    vy: -uy * (40 + Math.random() * 90) + 60 + Math.random() * 60,
                    mat: m,
                    dust: Math.random() < 0.5,
                    sub: false
                });
                grid[idx] = MAT.AIR;
                grid[idx + 1] = 0;
                grid[idx + 2] = 0;
                grid[idx + 3] = 0;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        if (maxX >= 0) {
            this.uploadRegion(minX, minY, maxX - minX + 1, maxY - minY + 1);
            p.carving = true;
            // White-hot chips fly back off the bit
            for (let s = 0; s < 3; s++) {
                this.spawnFx(2, cx - ux * 3, cy - uy * 3,
                    -ux * (120 + Math.random() * 220) + (Math.random() - 0.5) * 120,
                    -uy * (120 + Math.random() * 220) + 60 + Math.random() * 80,
                    0.25 + Math.random() * 0.2);
            }
        }
        // Boring bleeds momentum
        p.vx *= 0.985;
        p.vy *= 0.985;
        return p.budget <= 0;
    }

    // Water-entry splash: convert the surface water the sphere punches through
    // into an upward/outward droplet plume. One cell = one droplet — conserved.
    splashWaterEntry(p) {
        this.ensureFreshSnapshot();
        this.audio.splash(p.x, Math.min(1, Math.abs(p.vy) / 500));
        const w = this.width, grid = this.gridData;
        const r = p.radius + 2;
        const cx = Math.round(p.x), cy = Math.round(p.y);
        const speedBoost = Math.min(1.5, Math.abs(p.vy) / 400);
        const x0 = Math.max(1, cx - r), x1 = Math.min(w - 2, cx + r);
        const y0 = Math.max(3, cy - r), y1 = Math.min(this.height - 1, cy + r);
        let minX = w, maxX = -1, minY = this.height, maxY = -1;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                if (Math.hypot(x - cx, y - cy) > r) continue;
                const idx = (y * w + x) * 4;
                if (grid[idx] !== MAT.WATER) continue;
                const side = x < cx ? -1 : 1;
                // Crown splash: the outer ring sheets near-vertically upward,
                // the core sprays outward with the impact
                const crown = Math.hypot(x - cx, y - cy) > r * 0.55;
                this.grains.push({
                    x, y,
                    vx: crown ? side * (15 + Math.random() * 50)
                              : side * (60 + Math.random() * 180) * speedBoost + p.vx * 0.2,
                    vy: crown ? (240 + Math.random() * 200) * speedBoost
                              : (110 + Math.random() * 180) * speedBoost,
                    mat: MAT.WATER,
                    dust: false,
                    sub: false
                });
                grid[idx] = MAT.AIR;
                grid[idx + 1] = 0;
                grid[idx + 2] = 0;
                grid[idx + 3] = 0;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        // Radiating ripple: stamp outward momentum into the surviving surface
        // water around the entry point — a ring wave spreads from the impact
        for (let x = Math.max(1, cx - 30); x <= Math.min(w - 2, cx + 30); x++) {
            const dx = x - cx;
            if (Math.abs(dx) < r) continue;
            for (let y = Math.max(3, cy - 4); y <= Math.min(this.height - 2, cy + 6); y++) {
                const idx = (y * w + x) * 4;
                if (grid[idx] !== MAT.WATER) continue;
                grid[idx + 1] = dx > 0 ? 1 : -1;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        if (maxX >= 0) {
            this.uploadRegion(minX, minY, maxX - minX + 1, maxY - minY + 1);
        }
    }

    // Archimedes displacement: water overlapping the submerged sphere is moved
    // to the first open cell above its column — the sphere gets a body-shaped
    // pocket and the surface rises by exactly the displaced volume. The fluid
    // CA flows water back around the sphere as it moves, so wakes and
    // closing splashes emerge naturally. Exactly conserving (cell-for-cell).
    displaceSubmergedVolume(p) {
        this.ensureFreshSnapshot();
        const w = this.width, h = this.height, grid = this.gridData;
        const r = p.radius;
        const cx = Math.round(p.x), cy = Math.round(p.y);
        const x0 = Math.max(1, cx - r), x1 = Math.min(w - 2, cx + r);
        const y0 = Math.max(3, cy - r), y1 = Math.min(h - 1, cy + r);
        let minX = w, maxX = -1, minY = h, maxY = -1;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                if (Math.hypot(x - cx, y - cy) > r) continue;
                const idx = (y * w + x) * 4;
                if (grid[idx] !== MAT.WATER) continue;
                // Push this cell to the first air above its column (through the
                // water body). A fully sealed column can't displace — skip it.
                let airY = y + 1;
                let guard = 0;
                while (airY < h - 1 && grid[(airY * w + x) * 4] === MAT.WATER && guard++ < 300) airY++;
                if (grid[(airY * w + x) * 4] !== MAT.AIR) continue;
                grid[idx] = MAT.AIR;
                grid[idx + 1] = 0;
                grid[idx + 2] = 0;
                grid[idx + 3] = 0;
                const aIdx = (airY * w + x) * 4;
                grid[aIdx] = MAT.WATER;
                grid[aIdx + 1] = 0;
                grid[aIdx + 2] = 0;
                grid[aIdx + 3] = 0;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (airY > maxY) maxY = airY;
            }
        }
        if (maxX >= 0) {
            this.uploadRegion(minX, minY, maxX - minX + 1, maxY - minY + 1);
        }
    }

    // Circular rigid body vs. terrain: bounce with restitution, roll along
    // slopes with friction, rest when energy is spent. Returns true when a
    // water balloon ruptures on contact.
    resolveProjectileCollision(p) {
        const r = p.radius;
        const solidBelow = isSolidMat(this.matAt(p.x, p.y - r));
        const solidAbove = isSolidMat(this.matAt(p.x, p.y + r));
        const solidLeft  = isSolidMat(this.matAt(p.x - r, p.y));
        const solidRight = isSolidMat(this.matAt(p.x + r, p.y));

        if (p.type === 'BALLOON') {
            // Ruptures on any collision with solids or liquid surfaces
            return solidBelow || solidAbove || solidLeft || solidRight ||
                   isLiquidMat(this.matAt(p.x, p.y));
        }

        const contact = solidBelow || solidAbove || solidLeft || solidRight;

        if (p.type === 'STICKY') {
            // Adheres to the first solid it touches; anchor cell is watched so
            // the charge drops free if its support is dug or blasted away
            if (contact) {
                // Back the shell out of the cell it just overlapped (it moved
                // in 2px substeps) so it sits ON the surface, not sunk into it
                let guard = 0;
                if (solidBelow)      while (guard++ < 12 && isSolidMat(this.matAt(p.x, p.y - r))) p.y += 1;
                else if (solidAbove) while (guard++ < 12 && isSolidMat(this.matAt(p.x, p.y + r))) p.y -= 1;
                else if (solidLeft)  while (guard++ < 12 && isSolidMat(this.matAt(p.x - r, p.y))) p.x += 1;
                else                 while (guard++ < 12 && isSolidMat(this.matAt(p.x + r, p.y))) p.x -= 1;
                p.stuck = true;
                p.vx = 0; p.vy = 0; p.omega = 0;
                if (solidBelow)      { p.ax = Math.round(p.x); p.ay = Math.round(p.y - r - 1); }
                else if (solidAbove) { p.ax = Math.round(p.x); p.ay = Math.round(p.y + r + 1); }
                else if (solidLeft)  { p.ax = Math.round(p.x - r - 1); p.ay = Math.round(p.y); }
                else                 { p.ax = Math.round(p.x + r + 1); p.ay = Math.round(p.y); }
            }
            return false;
        }

        // Cluster shell is impact-fused: a hard strike pops it open mid-air;
        // a gentle landing lets it roll until the 3s fuse fires
        if (p.type === 'CLUSTER' && contact && Math.hypot(p.vx, p.vy) > 140) {
            return true;
        }

        if (solidBelow && p.vy < 0) {
            // Hard impact into loose sand: a dust puff and the energy the
            // ground absorbed. This used to excavate a crater under the sphere
            // (splashCrater) — the bomb sank into it, the ejecta rained back on
            // top, and the charge went off buried, reading as "the bomb went
            // through the sand". Ordnance now always stops AT the surface.
            if (p.vy < -320 && p.splash === 0 && this.matAt(p.x, p.y - r) === MAT.SAND) {
                for (let k = 0; k < 6; k++) {
                    this.spawnFx(0, p.x + (Math.random() - 0.5) * r * 2, p.y - r + 1,
                        (Math.random() - 0.5) * 120, 20 + Math.random() * 60, 0.5 + Math.random() * 0.6);
                }
                p.splash = 0.3;
                p.vy *= 0.5;
            }
            // Un-embed (fully — a sphere buried by settling sand or ejecta must
            // surface this frame, never sit inside the ground), then bounce;
            // contact torque spins the sphere.
            // Impact friction fires only on a real strike — resting contact
            // re-triggers this branch EVERY frame (gravity), and scrubbing vx
            // here each time froze spheres on slopes instead of letting
            // rollOnSlope carry them downhill.
            let guard = 0;
            while (isSolidMat(this.matAt(p.x, p.y - r)) && guard++ < 48) p.y += 1;
            const impact = Math.abs(p.vy) > 60;
            if (impact) {
                this.audio.bounce(p.x, Math.abs(p.vy));
                p.vx *= 0.7;
            }
            p.vy = impact ? -p.vy * 0.35 : 0;
            p.omega = -p.vx / r;
        }
        if (solidAbove && p.vy > 0) {
            p.vy = -p.vy * 0.4;
        }
        if (solidLeft && p.vx < 0) {
            p.x += 1;
            p.vx = -p.vx * 0.4;
        }
        if (solidRight && p.vx > 0) {
            p.x -= 1;
            p.vx = -p.vx * 0.4;
        }

        return false;
    }

    // Top of the terrain in one column, searched in a window around yNear.
    // A column of pure air in the window reads as a drop-off, which correctly
    // pulls a resting sphere toward cliff edges and crater mouths.
    surfaceHeightAt(x, yNear) {
        let y = Math.min(this.height - 1, Math.round(yNear) + 12);
        const yMin = Math.max(3, Math.round(yNear) - 24);
        while (y > yMin && !isSolidMat(this.matAt(x, y))) y--;
        return y;
    }

    // Spheres roll: a grounded bomb on uneven ground accelerates toward the
    // lower side (a = g·sinθ, scaled for rolling inertia), carries momentum
    // through dips, and comes to rest only on near-flat ground.
    rollOnSlope(p, dt) {
        const r = p.radius;
        if (p.vy !== 0 || !isSolidMat(this.matAt(p.x, p.y - r - 1))) return;

        const probe = r;
        const hL = this.surfaceHeightAt(p.x - probe, p.y - r);
        const hR = this.surfaceHeightAt(p.x + probe, p.y - r);
        const slope = (hR - hL) / (2 * probe);      // + = terrain rises to the right
        const sinTheta = slope / Math.hypot(1, slope);

        p.vx += -sinTheta * GRAVITY * 0.6 * dt;      // downhill acceleration
        p.vx *= Math.pow(0.5, dt);                   // rolling friction (sole scrubber on the ground)
        p.omega = -p.vx / r;                         // rolling without slipping

        // Rest only when the ground is effectively flat AND motion has died out
        if (Math.abs(sinTheta) < 0.06 && Math.abs(p.vx) < 3.0) {
            p.vx = 0;
            p.omega = 0;
        }
    }

    sprayWaterBurst(cx, cy, radius) {
        // Instantaneous 360° pressurized discharge: the balloon's payload is
        // released as ballistic droplets (one grain per fluid cell) that surge
        // outward, splash off terrain, and pool where they land.
        const count = Math.round(Math.PI * radius * radius * 0.8);
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const speed = 60 + Math.random() * 260;
            this.grains.push({
                x: cx,
                y: cy,
                vx: Math.cos(a) * speed,
                vy: Math.sin(a) * speed + 40,
                mat: MAT.WATER,
                dust: false,
                sub: false
            });
        }
    }

    // ---- Interop surface ----------------------------------------------------

    setTool(toolId) {
        this.currentTool = toolId;
    }

    setAutoDrop(enabled) {
        this.autoDropEnabled = enabled;
        this.autoDropTimer = 0;
    }

    spawnOrdnance(type, x, y, vx, vy) {
        const spec = ORDNANCE_SPECS[type] ?? ORDNANCE_SPECS.TNT;
        this.projectiles.push({
            type,
            x, y, vx, vy,
            radius: spec.radius,
            timer: spec.timer,
            budget: spec.budget ?? 0,
            angle: Math.PI / 2,
            omega: 0,
            splash: 0,
            stuck: false
        });
    }

    spawnRandomOrdnance() {
        // Every bomb detonates within its fuse (land or water), so the array
        // self-clears; the cap only trips during extreme manual barrages.
        if (this.projectiles.length >= MAX_PROJECTILES) return;
        const r = Math.random();
        const type = r < 0.70 ? 'TNT' : r < 0.85 ? 'CLUSTER' : r < 0.95 ? 'DRILL' : 'NUKE';
        const x = 30 + Math.random() * (this.width - 60);
        const y = this.height - 20; // top of the sky; the bomb free-falls into the terrain
        // The drill needs entry speed to start boring
        this.spawnOrdnance(type, x, y, 0, type === 'DRILL' ? -320 : 0);
    }

    setBrushRadius(radius) {
        this.brushRadius = Math.max(1, Math.min(32, radius));
    }

    setPaused(isPaused) {
        this.isPaused = isPaused;
    }

    stepOnce() {
        if (!this.isPaused) return;
        // Consumed by the next animation frame: runs one full simulated frame
        // (projectiles + physics sub-steps) while staying paused afterwards.
        this.pendingStep = true;
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
        this.audio.dispose();
        this.canvas.style.transform = '';
        const gl = this.gl;
        if (gl) {
            this.textures.forEach(t => gl.deleteTexture(t));
            this.fbos.forEach(f => gl.deleteFramebuffer(f));
            if (this.physicsBuild) this.discardPhysicsBuild();
            if (this.physicsProgram) gl.deleteProgram(this.physicsProgram);
            if (this.renderProgram) gl.deleteProgram(this.renderProgram);
            if (this.grainProgram) gl.deleteProgram(this.grainProgram);
            if (this.grainVBO) gl.deleteBuffer(this.grainVBO);
            if (this.grainVAO) gl.deleteVertexArray(this.grainVAO);
            if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
            for (const t of [this.sceneTarget, this.bloomA, this.bloomB]) {
                if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
            }
            for (const prog of [this.extractProgram, this.blurProgram, this.compositeProgram, this.fxProgram]) {
                if (prog) gl.deleteProgram(prog);
            }
            if (this.fxVBO) gl.deleteBuffer(this.fxVBO);
            if (this.fxVAO) gl.deleteVertexArray(this.fxVAO);
        }
    }
}

// Module entry points for Blazor WASM interop
let activeEngine = null;

export function initSubSurface(canvas, dotNetHelper, realism) {
    if (activeEngine) {
        activeEngine.dispose();
    }
    activeEngine = new SubSurfaceEngine(canvas, dotNetHelper, realism);
    // Debug handle for browser-driven diagnostics (same convention as PoVoxelStrike's window.__pvs)
    window.__sand = activeEngine;
    return true;
}

export function setSubSurfaceRealism(level) {
    if (activeEngine) activeEngine.setRealism(level);
}

export function setSubSurfaceTool(toolId) {
    if (activeEngine) activeEngine.setTool(toolId);
}

export function setSubSurfaceAutoDrop(enabled) {
    if (activeEngine) activeEngine.setAutoDrop(enabled);
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

export function setSubSurfaceAudio(enabled) {
    if (activeEngine) {
        // The toggle click is itself a user gesture — try to unlock too
        if (enabled) activeEngine.audio.unlock();
        activeEngine.audio.setEnabled(enabled);
    }
}

export function disposeSubSurface() {
    if (activeEngine) {
        activeEngine.dispose();
        activeEngine = null;
    }
}
