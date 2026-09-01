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

import { vsQuadSource, fsPhysicsSource } from './subsurface-physics.glsl.js';
import { fsRenderSource, vsGrainSource, fsGrainSource } from './subsurface-render.glsl.js';

const MAT = { AIR: 0, SAND: 1, CONCRETE: 2, WATER: 3, BEDROCK: 4, DEBRIS: 5 };
const MAX_SHOCKWAVES = 4;
const MAX_PROJECTILES = 16;
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

function isSolidMat(m) {
    return m === MAT.SAND || m === MAT.CONCRETE || m === MAT.BEDROCK || m === MAT.DEBRIS;
}

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

        // Enable float render targets so material IDs (0-4) are stored exactly.
        // An 8-bit normalized texture clamps any ID > 1.0, collapsing concrete,
        // water and bedrock into sand. RGBA32F stores the exact float ID.
        if (!this.gl.getExtension('EXT_color_buffer_float')) {
            console.warn('EXT_color_buffer_float is unavailable; Sand materials may render incorrectly.');
        }

        // State variables
        this.isPaused = false;
        this.pendingStep = false;
        this.currentTool = 0; // 0: DigVacuum, 1: Sand, 2: Concrete, 3: Water, 4: TNT, 5: WaterBalloon
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

        // Compile Programs
        this.physicsProgram = this.createProgram(vsQuadSource, fsPhysicsSource);
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
        this.physicsLocs = locs(this.physicsProgram, [
            'u_stateTexture', 'u_resolution', 'u_time', 'u_frame', 'u_subStep',
            'u_brush', 'u_shockwaves', 'u_shockwaveCount'
        ]);
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

        // Diagnostics: live cell census piggybacks on the readback
        let sand = 0, fluid = 0;
        const d = this.gridData;
        for (let i = 0; i < d.length; i += 4) {
            const m = d[i];
            if (m === MAT.SAND) sand++;
            else if (m === MAT.WATER) fluid++;
        }
        this.activeSandCells = sand;
        this.activeFluidCells = fluid;
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
                    if (belowMat === MAT.SAND || belowMat === MAT.BEDROCK || belowMat === MAT.DEBRIS) {
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
                if (supported) {
                    const comX = comSum / cells.length;
                    if (comX < supMinX - 2 || comX > supMaxX + 2) supported = false;
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
                // every cell's target must be air, water, or another island cell.
                const inIsland = new Set(cells);
                let drop = 0;
                for (let d = ISLAND_FALL_STEP; d >= 1; d--) {
                    let ok = true;
                    for (const idx of cells) {
                        const t = idx - d * w;
                        if (((t / w) | 0) <= 2) { ok = false; break; } // bedrock rows
                        if (inIsland.has(t)) continue;
                        const tm = grid[t * 4];
                        if (tm !== MAT.AIR && tm !== MAT.WATER) { ok = false; break; }
                    }
                    if (ok) { drop = d; break; }
                }
                if (drop === 0) continue;
                anyActive = true;

                // Move the island: clear old cells, count displaced water at the
                // targets, stamp concrete, then refill vacated cells with the
                // displaced water (topmost vacated cells first — water rises).
                let displacedWater = 0;
                for (const idx of cells) grid[idx * 4] = MAT.AIR;
                for (const idx of cells) {
                    const t = idx - drop * w;
                    if (grid[t * 4] === MAT.WATER) displacedWater++;
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
                    if (cx < minX) minX = cx;
                    if (cx > maxX) maxX = cx;
                    if (cy - drop < minY) minY = cy - drop;
                    if (cy > maxY) maxY = cy;
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
            const unsupported = below !== MAT.SAND && below !== MAT.BEDROCK && below !== MAT.CONCRETE && below !== MAT.DEBRIS;
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
                // Launch Projectile: V0 = (origin - drag) * k
                const vx = (this.slingshotOrigin.x - this.slingshotCurrent.x) * LAUNCH_POWER;
                const vy = (this.slingshotOrigin.y - this.slingshotCurrent.y) * LAUNCH_POWER;

                if (Math.hypot(vx, vy) > 10.0 && this.projectiles.length < MAX_PROJECTILES) {
                    this.projectiles.push({
                        type: this.currentTool === 4 ? 'TNT' : 'BALLOON',
                        x: this.slingshotOrigin.x,
                        y: this.slingshotOrigin.y,
                        vx: vx,
                        vy: vy,
                        radius: 6,
                        timer: 5.0,
                        angle: Math.PI / 2,
                        omega: 0,
                        splash: 0
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
        }

        // 2. Cellular Physics Sub-Steps
        gl.useProgram(this.physicsProgram);
        gl.bindVertexArray(this.quadVAO);

        // Brush parameters: (x, y, radius, material)
        let brushUniform = [0, 0, 0, 0];
        if (this.isMouseDown && !this.isSlingshotAiming && this.currentTool <= 3) {
            brushUniform = [this.mousePos.x, this.mousePos.y, this.brushRadius, this.currentTool];
        }

        // Active shockwaves (up to MAX_SHOCKWAVES simultaneous blasts)
        const shockwaveData = new Float32Array(MAX_SHOCKWAVES * 4);
        const shockwaveCount = Math.min(this.shockwaves.length, MAX_SHOCKWAVES);
        for (let i = 0; i < shockwaveCount; i++) {
            const sw = this.shockwaves[i];
            shockwaveData.set([sw.x, sw.y, sw.radius, sw.intensity], i * 4);
        }

        gl.uniform2f(this.physicsLocs.u_resolution, this.width, this.height);
        gl.uniform1f(this.physicsLocs.u_time, timeSeconds);
        gl.uniform1i(this.physicsLocs.u_frame, this.frame);
        gl.uniform4fv(this.physicsLocs.u_brush, brushUniform);
        gl.uniform4fv(this.physicsLocs.u_shockwaves, shockwaveData);
        gl.uniform1i(this.physicsLocs.u_shockwaveCount, shockwaveCount);

        gl.viewport(0, 0, this.width, this.height);

        // While paused, a held brush still paints with a single sub-step so the
        // sandbox stays editable frame-by-frame.
        const effectiveSteps = subSteps || (this.isMouseDown && !this.isSlingshotAiming ? 1 : 0);
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

        // 3. Render Pass to Canvas
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
            const kind = p.type === 'BALLOON' ? 2 : 0;
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

        this.frame++;
    }

    // ---- Blast ejecta -------------------------------------------------------

    // Polar occlusion map: march 360 rays outward once, recording how far each
    // ray reaches before it has chewed through BLAST_SOLID_BUDGET px of solid.
    // Cells beyond their ray's reach are shielded — blasts carve bowl craters,
    // channel through tunnels, and are stopped by concrete walls.
    computeBlastReach(cx, cy, maxR) {
        const rays = 360;
        const reach = new Float32Array(rays);
        const step = (Math.PI * 2) / rays;
        for (let a = 0; a < rays; a++) {
            const ux = Math.cos(a * step), uy = Math.sin(a * step);
            let solid = 0, t = 2;
            for (; t < maxR; t += 2) {
                if (isSolidMat(this.matAt(cx + ux * t, cy + uy * t))) {
                    solid += 2;
                    if (solid > BLAST_SOLID_BUDGET) break;
                }
            }
            reach[a] = t;
        }
        return reach;
    }

    detonateBlast(cx, cy, exclude) {
        // Fresh snapshot so the crater is cut from the true current terrain
        this.ensureFreshSnapshot();

        const w = this.width, h = this.height, grid = this.gridData;
        // Depth of burial governs the blast's character: an airburst scours a
        // shallow wide crater, a shallow burial throws the classic ejecta cone,
        // and a deep burial (camouflet) just carves a sealed cavity with low
        // ejection speeds — the surface heaves instead of erupting.
        let burial = 0;
        for (let t = 1; t <= 130; t++) {
            if (isSolidMat(this.matAt(cx, cy + t))) burial++;
        }
        const camouflet = burial > 70;
        const airburst = burial < 12;
        const rScale = camouflet ? 0.55 : (airburst ? 0.75 : 1.0);
        const spScale = camouflet ? 0.3 : 1.0;
        const upBias = camouflet ? 15 : (airburst ? 40 : 130);

        const sandR = Math.round(CRATER_RADIUS * rScale);   // sand excavation
        const scorchR = sandR + 14;               // charred crater lining
        const waterR = Math.round(sandR * 1.4);   // water is thrown farther
        const ringR = sandR * 2;                  // surviving water gets outward surge
        const reach = this.computeBlastReach(cx, cy, ringR);

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
                if (m !== MAT.SAND && m !== MAT.WATER && m !== MAT.DEBRIS) continue; // concrete/bedrock immune

                let ai = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
                if (ai < 0) ai += 360;
                if (dist > reach[ai % 360]) continue;            // shielded

                let ux, uy;
                if (dist < 0.5) {
                    const a = Math.random() * Math.PI * 2;
                    ux = Math.cos(a); uy = Math.sin(a);
                } else {
                    ux = dx / dist; uy = dy / dist;
                }

                if (m === MAT.SAND || m === MAT.DEBRIS) {
                    if (dist <= sandR) {
                        // Displace: eject as a ballistic grain (25% fine dust)
                        const dust = m === MAT.SAND && !camouflet && Math.random() < 0.25;
                        const speed = EJECTA_SPEED * spScale * (0.35 + 0.65 * (1 - dist / sandR)) *
                                      (0.7 + Math.random() * 0.6) * (dust ? 0.55 : 1.0);
                        this.grains.push({
                            x, y,
                            vx: ux * speed + (Math.random() - 0.5) * 60,
                            vy: uy * speed + upBias + Math.random() * 70,
                            mat: m,
                            dust,
                            sub: false
                        });
                        grid[idx] = MAT.AIR;
                        grid[idx + 1] = 0;
                        grid[idx + 2] = 0;
                        grid[idx + 3] = 0;
                        touch(x, y);
                    } else if (m === MAT.SAND && dist <= scorchR && !camouflet) {
                        // Fireball fuses the inner lining to glass, chars the rest
                        grid[idx + 2] = dist <= sandR + 5 ? -2 : -1;
                        touch(x, y);
                    }
                } else if (m === MAT.WATER) {
                    if (dist <= waterR) {
                        // Water column thrown up; near the core it flashes to
                        // slow-drifting steam mist that condenses back down
                        const steam = dist < 20;
                        const speed = EJECTA_SPEED * 1.1 * (0.35 + 0.65 * (1 - dist / waterR)) *
                                      (0.7 + Math.random() * 0.6);
                        this.grains.push({
                            x, y,
                            vx: ux * speed + (Math.random() - 0.5) * 80,
                            vy: uy * speed + 110 + Math.random() * 90 + (steam ? 220 : 0),
                            mat: MAT.WATER,
                            dust: steam,
                            sub: false
                        });
                        grid[idx] = MAT.AIR;
                        grid[idx + 1] = 0;
                        grid[idx + 2] = 0;
                        grid[idx + 3] = 0;
                        touch(x, y);
                    } else {
                        // Surviving outer water takes an outward surge impulse
                        grid[idx + 1] = dx >= 0 ? 1 : -1;
                        touch(x, y);
                    }
                }
            }
        }

        if (maxX >= 0) {
            this.uploadRegion(minX, minY, maxX - minX + 1, maxY - minY + 1);
        }

        // The bomb's own matter survives: its casing shatters into red debris
        // grains (one per body cell) that fly with the blast and land as
        // permanent red gravel — nothing about the bomb vanishes.
        const bodyR = 6;
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

        // Air-blast impulse knocks nearby ordnance flying
        for (const q of this.projectiles) {
            if (q === exclude) continue;
            const d = Math.hypot(q.x - cx, q.y - cy);
            if (d > 400 || d < 0.5) continue;
            const kick = 900 * (1 - d / 400);
            q.vx += ((q.x - cx) / d) * kick;
            q.vy += ((q.y - cy) / d) * kick + 90;
        }

        if (this.shockwaves.length >= MAX_SHOCKWAVES) this.shockwaves.shift();
        this.shockwaves.push({ x: cx, y: cy, radius: 10, maxRadius: Math.round(340 * rScale), intensity: 1.0 });
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
        const occ = new Set();
        for (const g of this.grains) {
            occ.add((Math.round(g.y) << 10) | Math.round(g.x));
        }

        for (let i = this.grains.length - 1; i >= 0; i--) {
            const g = this.grains[i];
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
        // Auto-drop demo ordnance: rain a random TNT bomb from the sky every second
        if (this.autoDropEnabled) {
            this.autoDropTimer += dt;
            if (this.autoDropTimer >= 1.0) {
                this.autoDropTimer -= 1.0;
                this.spawnRandomTNT();
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

            // Integrate: gravity (buoyant drag in water), substepped to avoid
            // tunneling through thin terrain at slingshot speeds.
            const gravity = inWater ? GRAVITY * 0.25 : GRAVITY;
            p.vy -= gravity * dt;
            if (inWater) {
                p.vx *= 0.92;
                p.vy *= 0.92;
            }

            const moveLen = Math.hypot(p.vx, p.vy) * dt;
            const moveSteps = Math.max(1, Math.ceil(moveLen / 2.0));
            let burst = false;
            for (let s = 0; s < moveSteps && !burst; s++) {
                p.x += (p.vx * dt) / moveSteps;
                p.y += (p.vy * dt) / moveSteps;
                burst = this.resolveProjectileCollision(p);
            }
            if (!burst && p.type === 'TNT') {
                this.rollOnSlope(p, dt);
            }
            // Spin: rotation follows contact velocity (set in rollOnSlope and
            // at bounces); a tumbling sphere keeps its angular momentum in flight
            p.angle += p.omega * dt;
            p.splash = Math.max(0, p.splash - dt);

            if (burst) {
                // Water balloon: instantaneous 360° pressurized fluid discharge
                this.sprayWaterBurst(Math.round(p.x), Math.round(p.y), 16);
                this.projectiles.splice(i, 1);
                continue;
            }

            // Lateral drainage: ordnance leaving the viewport is gone
            if (p.x < -10 || p.x > this.width + 10) {
                this.projectiles.splice(i, 1);
                continue;
            }

            // TNT fuse burns on land and underwater alike; a submerged blast
            // ejects the surrounding water column and the remaining body of
            // water then pours into the freshly opened crater via the fluid CA.
            if (p.type === 'TNT') {
                p.timer -= dt;
                if (p.timer <= 0) {
                    this.detonateBlast(p.x, p.y, p);
                    this.projectiles.splice(i, 1);
                }
            }
        }
    }

    // Water-entry splash: convert the surface water the sphere punches through
    // into an upward/outward droplet plume. One cell = one droplet — conserved.
    splashWaterEntry(p) {
        this.ensureFreshSnapshot();
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
            // Ruptures on any collision with sand, concrete, bedrock, or water
            return solidBelow || solidAbove || solidLeft || solidRight ||
                   this.matAt(p.x, p.y) === MAT.WATER;
        }

        if (solidBelow && p.vy < 0) {
            // Hard impact into loose sand: the sphere buries itself, throwing
            // an impact splash of displaced grains (conserved) and losing the
            // energy the ground absorbed
            if (p.vy < -320 && p.splash === 0 && this.matAt(p.x, p.y - r) === MAT.SAND) {
                this.splashCrater(p.x, p.y - r, 7);
                p.splash = 0.3;
                p.vy *= 0.5;
            }
            // Un-embed, then bounce; contact torque spins the sphere
            let guard = 0;
            while (isSolidMat(this.matAt(p.x, p.y - r)) && guard++ < 8) p.y += 1;
            p.vy = Math.abs(p.vy) > 60 ? -p.vy * 0.35 : 0;
            p.vx *= 0.7;
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
        p.vx *= Math.pow(0.35, dt);                  // rolling friction
        p.omega = -p.vx / r;                         // rolling without slipping

        // Rest only when the ground is effectively flat AND motion has died out
        if (Math.abs(sinTheta) < 0.08 && Math.abs(p.vx) < 1.5) {
            p.vx = 0;
            p.omega = 0;
        }
    }

    // Impact penetration splash: a fast sphere burying into loose sand throws
    // the displaced grains outward (each cell becomes one grain — conserved).
    splashCrater(cx, cy, radius) {
        this.ensureFreshSnapshot();
        const w = this.width, grid = this.gridData;
        const x0 = Math.max(1, Math.round(cx - radius)), x1 = Math.min(w - 2, Math.round(cx + radius));
        const y0 = Math.max(3, Math.round(cy - radius)), y1 = Math.min(this.height - 1, Math.round(cy + radius));
        let minX = w, maxX = -1, minY = this.height, maxY = -1;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                if (Math.hypot(x - cx, y - cy) > radius) continue;
                const idx = (y * w + x) * 4;
                if (grid[idx] !== MAT.SAND) continue;
                this.grains.push({
                    x, y,
                    vx: (Math.random() - 0.5) * 260,
                    vy: 50 + Math.random() * 150,
                    mat: MAT.SAND,
                    dust: Math.random() < 0.2,
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

    spawnRandomTNT() {
        // Every bomb detonates within 5s (land or water), so the array
        // self-clears; the cap only trips during extreme manual barrages.
        if (this.projectiles.length >= MAX_PROJECTILES) return;
        const x = 30 + Math.random() * (this.width - 60);
        const y = this.height - 20; // top of the sky; the bomb free-falls into the terrain
        this.projectiles.push({
            type: 'TNT',
            x: x,
            y: y,
            vx: 0,
            vy: 0,
            radius: 6,
            timer: 5.0,
            angle: Math.PI / 2,
            omega: 0,
            splash: 0
        });
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
        const gl = this.gl;
        if (gl) {
            this.textures.forEach(t => gl.deleteTexture(t));
            this.fbos.forEach(f => gl.deleteFramebuffer(f));
            if (this.physicsProgram) gl.deleteProgram(this.physicsProgram);
            if (this.renderProgram) gl.deleteProgram(this.renderProgram);
            if (this.grainProgram) gl.deleteProgram(this.grainProgram);
            if (this.grainVBO) gl.deleteBuffer(this.grainVBO);
            if (this.grainVAO) gl.deleteVertexArray(this.grainVAO);
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

export function disposeSubSurface() {
    if (activeEngine) {
        activeEngine.dispose();
        activeEngine = null;
    }
}
