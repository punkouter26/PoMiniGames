// boardGl.js — GPU board renderer for TicTacToe (§GFX-4).
//
// 2026-08-10: ConnectFive no longer mounts this. Its 9x9 grid of falling chips
// never rendered reliably here and was replaced by the plain CSS board that had
// always been the fallback — see the note in ConnectFivePage.razor. TicTacToe's
// 3x3 of stamped marks does not drop anything and never had the problem, so it
// keeps this. The ConnectFive code paths below (`kind: 'connectfive'`, the chip
// lathe, the drop integrator, the win beam) are retained and still correct;
// they are simply unused until something mounts with that kind again.
//
// Both games were pure DOM: an SVG glyph per cell, a CSS grid, a div for the
// win line. That is a perfectly good way to render a board and a poor way to
// make one feel like an object. This adds a three.js layer *behind* the
// existing grid.
//
// THE DOM STAYS. Every cell div, every aria-label, every click handler and the
// SVG marks all remain exactly as they were — the marks are just made
// transparent by CSS while this layer is mounted. That matters for three
// reasons: the E2E-UI Playwright suite keeps finding the same elements,
// keyboard and screen-reader users keep the same board, and if WebGL is
// unavailable the game degrades to precisely what it was before by doing
// nothing at all.
//
// So this file never handles input. It is told what the board looks like and
// draws it.
//
// BACKEND: goes through renderFactory.js, so it runs on WebGPU where the
// browser has it and WebGL2 otherwise. It can do that — unlike PoBrawl and
// PoMarbleRace — precisely because it has no EffectComposer: the look here
// comes from materials and lighting, not from post-processing, and materials
// are the part of three.js that is backend-agnostic.
//
// PHYSICS: ConnectFive's chips fall on a real spring. Not a CSS keyframe with a
// bounce easing — an actual integrated spring with a stop condition, because a
// chip has to land on TOP of whatever is already in the column, and the landing
// height is different for every drop. An easing curve cannot know that.

import * as THREE from 'three';
import { createRenderer, renderFrame } from './renderFactory.js';
import * as Impact from './impactBus.js';

const EMPTY = 0;
const P1 = 1;
const P2 = 2;

// Board-space units. One cell is 1.0; everything else is expressed relative to
// that so a 3×3 and a 9×7 board look like the same physical object at
// different sizes.
const CELL = 1.0;
const PIECE_R = 0.36;
const SLAB_T = 0.28;

// ── Chip drop (2026-08-10 rewrite) ────────────────────────────────────────
// This used to be a damped spring pulling the chip toward its rest height
// (k=260, d=13.5, zeta≈0.42). That is the wrong model and it visibly corrupted
// the board.
//
// A spring is SYMMETRIC about its target: released from a displacement it
// overshoots past that target by a fixed fraction of the distance travelled.
// The drop distance here is up to ~10 board units, so the overshoot was
// proportionally enormous — measured against the shipped constants, a chip
// dipped BELOW its rest height by 0.51 units landing in the bottom row, 1.36 in
// the middle and 2.21 at the top. The slab surface is at y = -0.02 and a chip
// is 0.20 tall, so every single drop punched the chip through the board, hid it
// under the slab, and bounced it back up. It read as discs flickering through
// the playfield, and it got much more obvious once the cell sockets became
// opaque enough to see (they now cleanly occlude a sunken chip).
//
// A falling counter is not a spring — it is free fall against a hard floor.
// Gravity down, clamp at the rest height, and keep a fraction of the impact
// speed as a bounce. The clamp is the load-bearing part: the chip is now
// mathematically incapable of rendering below the slot it lands in.
const CHIP_G = 62;             // board units/s² — tallest drop lands in ~0.55 s
const CHIP_RESTITUTION = 0.18; // speed kept per bounce; ~0.3 cell first hop
// Settle when the NEXT hop would be too small to see, expressed as a height
// rather than a speed. A speed threshold cannot work here: the frame dt is
// capped at 50 ms, and at that step gravity alone adds 3.1 units/s of impact
// every frame — far above any speed small enough to call "resting". A chip on a
// slow device therefore bounced forever (measured: 1988 bounces, never
// settling), which also pinned the render loop awake because it never went
// idle. Comparing hop APEX is frame-rate independent.
const CHIP_MIN_HOP = 0.004;    // board units; below this a bounce is invisible

/**
 * Mount a board renderer onto a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {number} opts.cols
 * @param {number} opts.rows
 * @param {'tictactoe'|'connectfive'} opts.kind
 * @param {string} [opts.color1] CSS colour for player 1
 * @param {string} [opts.color2] CSS colour for player 2
 * @returns {Promise<object>} handle
 * @throws {Error} when no GPU backend is available. Rejecting rather than
 *   resolving null is deliberate: the caller is Blazor, and
 *   `InvokeAsync<IJSObjectReference>` cannot deserialise a null result — it
 *   would surface as an opaque JSException anyway. A rejection with a message
 *   is the same control flow with a readable reason, and the C# side already
 *   treats "no GL layer" as a supported outcome rather than an error.
 */
export async function mount(canvas, opts) {
    if (!canvas || !opts) throw new Error('boardGl: canvas and opts are required');

    let ctxHandle;
    try {
        ctxHandle = await createRenderer({
            preferWebGPU: true,
            antialias: true,
            alpha: true,          // the page's own background shows through
            maxPixelRatio: 2,
            canvas,               // render into the page's own canvas — see below
        });
    } catch {
        // No GPU at all. The DOM board carries on alone.
        throw new Error('boardGl: no GPU backend available');
    }
    const { renderer, isWebGPU } = ctxHandle;

    const cols = Math.max(1, opts.cols | 0);
    const rows = Math.max(1, opts.rows | 0);
    const kind = opts.kind === 'connectfive' ? 'connectfive' : 'tictactoe';

    // The renderer is constructed against the page's canvas (see the `canvas`
    // option above), so this is normally a no-op. It stays as a guard for a
    // backend that ignores the option and allocates its own element.
    //
    // The swap is a LAST RESORT, and it copies every attribute rather than just
    // className. Blazor applies scoped CSS through a generated `b-*` attribute
    // stamped on the elements a component renders — a canvas three.js created
    // has none, so the `position: absolute; inset: 0` rule in the host page's
    // scoped stylesheet stopped matching. The canvas then fell back to static
    // positioning at the HTML default 300x150, which made it a grid ITEM inside
    // the board: it consumed the first grid slot, pushed every cell one place
    // along, and rendered the whole board into a 300x150 corner while the DOM
    // marks stayed hidden. The board looked empty.
    //
    // (Originally hit on ConnectFive, which no longer uses this module — see
    // the 2026-08-10 note in ConnectFivePage.razor. TicTacToe is subject to the
    // identical failure, hence the swap stays.)
    if (renderer.domElement !== canvas) {
        const parent = canvas.parentNode;
        for (const { name, value } of canvas.attributes) {
            // width/height are the renderer's backing-store size and are owned by
            // setSize(); copying the old element's would fight it on first frame.
            if (name === 'width' || name === 'height') continue;
            renderer.domElement.setAttribute(name, value);
        }
        renderer.domElement.setAttribute('aria-hidden', 'true');
        if (parent) parent.replaceChild(renderer.domElement, canvas);
        canvas = renderer.domElement;
    }
    renderer.setClearAlpha?.(0);

    const scene = new THREE.Scene();

    // Perspective rather than orthographic. A board seen in true parallel
    // projection reads as a diagram; a small amount of convergence is what makes
    // the pieces look like they have height.
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

    const boardW = cols * CELL;
    const boardH = rows * CELL;

    // ── Framing (2026-08-07 browser audit) ──────────────────────────────────
    // The camera looks STRAIGHT DOWN at the board, and the distance is solved so
    // the board fills the canvas exactly. Both halves of that matter:
    //
    //  * Straight down, because this canvas is an underlay for a real DOM grid.
    //    The cells above it own every click, the hover ghost and the focus ring,
    //    and they are laid out flat by CSS grid. The previous rig sat high and
    //    forward (`0, 0.82d, 0.58d`), which drew the slab as a trapezoid in
    //    three-quarter perspective: the GL wells landed nowhere near the DOM
    //    cells sitting on top of them, so the board read as two grids sliding
    //    past each other and the hover ring pointed at the wrong column. Only an
    //    axis-aligned view maps board space 1:1 onto the CSS grid. Pieces keep
    //    their depth from geometry, lighting and contact shadows rather than
    //    from camera convergence.
    //
    //  * Solved rather than guessed, because `resize()` updates `camera.aspect`
    //    but a hard-coded distance cannot know about it. The old constant framed
    //    a square canvas only; anything else cropped the board (the ConnectFive
    //    slab lost its bottom row) or left a margin of bare DOM sockets showing.
    //
    // Visible half-extent at the board plane is d*tan(fov/2) vertically and that
    // times the aspect horizontally, so solve d for whichever axis binds.
    camera.up.set(0, 0, -1);   // -Z is screen-up, so row 0 renders at the top
    function frameCamera() {
        const halfFov = (camera.fov * Math.PI) / 360;   // fov/2 in radians
        const t = Math.tan(halfFov);
        const margin = 1.02;                            // a hair of breathing room
        const forHeight = (boardH / 2) / t;
        const forWidth = (boardW / 2) / (t * Math.max(camera.aspect, 0.0001));
        const d = Math.max(forHeight, forWidth) * margin;
        camera.position.set(0, d, 0);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
    }
    frameCamera();

    // Root group — parallax tilts this, so nothing inside needs to know.
    const root = new THREE.Group();
    scene.add(root);

    // ── Lighting ──────────────────────────────────────────────────────
    // A three-point rig instead of an environment map. PMREMGenerator is a
    // WebGL-only code path in this three version, and the whole reason this
    // scene can run on WebGPU is that it avoids anything backend-specific.
    // The rig now does all the shaping on its own: the pieces and slab are
    // matte since the clearcoat came out (2026-08-07), so form reads from the
    // key/fill/rim falloff rather than from a specular highlight.
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-3, 8, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.8);
    fill.position.set(5, 3, -4);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffd9a0, 1.1);
    rim.position.set(0, 2, -8);
    scene.add(rim);

    // ── Board slab ────────────────────────────────────────────────────
    // Matte for the same reason as the pieces above: the clearcoat 0.6 gloss
    // layer put a broad sheen across the board that competed with the discs
    // for attention (2026-08-07, user request).
    const slabMat = new THREE.MeshStandardMaterial({
        color: 0x1b2439,
        roughness: 0.78,
        metalness: 0.05,
    });
    const slab = new THREE.Mesh(
        roundedBox(boardW + 0.36, SLAB_T, boardH + 0.36, 0.14),
        slabMat);
    slab.position.y = -SLAB_T / 2 - 0.02;
    root.add(slab);

    // Cell wells — recesses that catch the key light along one edge. This is
    // what makes the slab read as a moulded board and not a painted rectangle,
    // and it costs one instanced ring.
    //
    // 2026-08-07: detail pass. The ring was 6 tube segments around 28 radial —
    // low enough that from the new straight-down camera each well was a visibly
    // faceted polygon rather than a circle. 14x48 rounds them out, and the
    // slightly fatter tube gives the rim a readable highlight/shadow pair
    // instead of a hairline. Still one instanced draw for the whole board.
    //
    // 2026-08-09 readability pass. The rim alone was #2b3550 on a #1b2439 slab —
    // about 1.4:1. On anything but a bright, well-calibrated monitor the whole
    // board read as one featureless dark slab, so a player could not see the
    // 9x9 grid at all and had to guess which column a drop would land in.
    //
    // The fix is not simply "brighten the ring", which just makes a flat board
    // with lighter circles printed on it. A hole reads as a hole because the
    // inside is DARKER than the surface and the rim is LIGHTER: two instanced
    // draws, one dark socket floor and one bright rim, and the contrast between
    // them does the work rather than the contrast against the slab.
    const wellGeo = new THREE.TorusGeometry(PIECE_R + 0.10, 0.042, 14, 48);
    const wellMat = new THREE.MeshStandardMaterial({
        color: 0x5468a0, roughness: 0.62, metalness: 0.12,
    });
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const one = new THREE.Vector3(1, 1, 1);

    // Socket floor: a flat disc sunk just above the slab surface, well darker
    // than the slab. Its outer radius meets the rim's inner edge (the torus
    // inner edge sits at PIECE_R + 0.10 - 0.042), so the two read as one
    // moulded recess rather than a disc with a ring floating around it.
    const socketGeo = new THREE.CircleGeometry(PIECE_R + 0.058, 40);
    const socketMat = new THREE.MeshStandardMaterial({
        color: 0x090d17, roughness: 0.95, metalness: 0.0,
    });
    const sockets = new THREE.InstancedMesh(socketGeo, socketMat, cols * rows);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            m4.compose(cellPos(c, r, 0.001), q, one);
            sockets.setMatrixAt(r * cols + c, m4);
        }
    }
    sockets.instanceMatrix.needsUpdate = true;
    root.add(sockets);

    const wells = new THREE.InstancedMesh(wellGeo, wellMat, cols * rows);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            m4.compose(cellPos(c, r, 0.004), q, one);
            wells.setMatrixAt(r * cols + c, m4);
        }
    }
    wells.instanceMatrix.needsUpdate = true;
    root.add(wells);

    // ── Piece materials ───────────────────────────────────────────────
    const col1 = new THREE.Color(opts.color1 || '#ff6b6b');
    const col2 = new THREE.Color(opts.color2 || '#22d3ee');
    // 2026-08-07 (user request): the reflective clearcoat is gone. It was a
    // `clearcoat: 1.0 / clearcoatRoughness: 0.06` layer — a near-mirror finish
    // that threw a hard white specular blob onto every disc, and with a
    // top-down camera that highlight sits dead centre on all of them at once.
    // MeshStandardMaterial (no clearcoat lobe at all) with a matte roughness
    // reads as the moulded-plastic counter it is meant to be, and drops a
    // shading feature the GPU no longer has to evaluate per piece.
    const pieceMat = (c) => new THREE.MeshStandardMaterial({
        color: c,
        roughness: 0.68,
        metalness: 0.0,
        emissive: c.clone().multiplyScalar(0.12),
    });
    const mats = { [P1]: pieceMat(col1), [P2]: pieceMat(col2) };

    // Geometry is shared across every piece of a kind; only the transforms
    // differ. Built once here rather than per placement.
    const geoO = new THREE.TorusGeometry(PIECE_R * 0.78, PIECE_R * 0.26, 16, 40);
    const geoXArm = roundedBox(PIECE_R * 1.9, PIECE_R * 0.44, PIECE_R * 0.44, 0.06);

    // ── Counter profile (2026-08-07 detail pass) ────────────────────────────
    // Was a bare CylinderGeometry: from straight above that is a flat coloured
    // circle with no edge at all, which is why the board read as printed rather
    // than moulded. A lathed profile gives a real counter — a recessed centre
    // boss, a raised annulus, then a chamfer down to the rim — so the key light
    // lays a highlight on the raised ring and a shadow in the groove, and the
    // disc reads as an object from the one angle the camera ever sees it.
    //
    // Profile is in the XY half-plane (x = radius, y = height); LatheGeometry
    // revolves it around Y. Points run centre -> rim -> down -> under.
    const CHIP_H = 0.20;
    const chipProfile = [
        new THREE.Vector2(0.00, CHIP_H * 0.40),          // centre, slightly sunk
        new THREE.Vector2(PIECE_R * 0.30, CHIP_H * 0.40),
        new THREE.Vector2(PIECE_R * 0.42, CHIP_H * 0.50), // rise out of the boss
        new THREE.Vector2(PIECE_R * 0.86, CHIP_H * 0.50), // flat annulus (catches the key)
        new THREE.Vector2(PIECE_R * 0.97, CHIP_H * 0.42), // chamfer
        new THREE.Vector2(PIECE_R, CHIP_H * 0.26),       // rim
        new THREE.Vector2(PIECE_R, -CHIP_H * 0.26),      // side wall
        new THREE.Vector2(PIECE_R * 0.97, -CHIP_H * 0.42),
        new THREE.Vector2(PIECE_R * 0.86, -CHIP_H * 0.50),
        new THREE.Vector2(0.00, -CHIP_H * 0.50),         // flat underside
    ];
    const geoChip = new THREE.LatheGeometry(chipProfile, 48);
    geoChip.computeVertexNormals();

    /** @type {Map<number, {mesh: THREE.Object3D, vy: number, targetY: number, settled: boolean}>} */
    const pieces = new Map();
    let cells = new Array(cols * rows).fill(EMPTY);

    // ── Win beam ──────────────────────────────────────────────────────
    const beamMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1, 12), beamMat);
    beam.visible = false;
    root.add(beam);
    let beamT = 0;
    let beamLen = 0;

    function cellPos(c, r, y) {
        return new THREE.Vector3(
            (c - (cols - 1) / 2) * CELL,
            y || 0,
            (r - (rows - 1) / 2) * CELL);
    }

    function buildPiece(player, isChip) {
        if (isChip) return new THREE.Mesh(geoChip, mats[player]);
        if (player === P2) {
            const o = new THREE.Mesh(geoO, mats[P2]);
            o.rotation.x = -Math.PI / 2;
            return o;
        }
        // X as two crossed rounded bars in a group, so the whole glyph can be
        // scaled and sprung as one object.
        const g = new THREE.Group();
        const a = new THREE.Mesh(geoXArm, mats[P1]);
        const b = new THREE.Mesh(geoXArm, mats[P1]);
        a.rotation.y = Math.PI / 4;
        b.rotation.y = -Math.PI / 4;
        g.add(a, b);
        return g;
    }

    /**
     * Reconcile the scene against a flat cell array.
     * Diffing rather than rebuilding: a rebuild would restart every piece's
     * landing animation on every state push, so the whole board would bounce
     * each time one move was made.
     * @param {number[]} next cols*rows of 0/1/2, row-major
     */
    function setCells(next) {
        if (!Array.isArray(next) || next.length !== cols * rows) return;
        for (let i = 0; i < next.length; i++) {
            const was = cells[i];
            const now = next[i];
            if (was === now) continue;
            if (now === EMPTY) {
                const p = pieces.get(i);
                if (p) { root.remove(p.mesh); pieces.delete(i); }
            } else {
                place(i % cols, (i / cols) | 0, now);
            }
        }
        cells = next.slice();
        wake();
    }

    function place(c, r, player) {
        const i = r * cols + c;
        const existing = pieces.get(i);
        if (existing) root.remove(existing.mesh);

        const isChip = kind === 'connectfive';
        const mesh = buildPiece(player, isChip);
        const rest = cellPos(c, r, isChip ? 0.12 : 0.10);
        mesh.position.copy(rest);

        if (isChip) {
            // Enter from above the board and fall. The drop height is measured
            // in rows so a chip landing at the bottom of the column visibly
            // falls further than one landing at the top — the single cue that
            // makes the column feel like a physical slot.
            //
            // 2026-08-10: the row term was inverted. ConnectFiveBoard seeds
            // `_topRow[c] = Rows - 1` and decrements, so row 8 is the BOTTOM of
            // a column and row 0 the top. `(rows - r)` therefore gave the
            // first chip into an empty column the SHORTEST fall (2.4 units) and
            // a chip landing on an almost-full stack the longest (10.4) — the
            // exact opposite of both the physics and the comment above it.
            mesh.position.y = rest.y + (r + 1.4) * CELL;
            pieces.set(i, { mesh, vy: 0, targetY: rest.y, settled: false });
        } else {
            // Marks are stamped, not dropped: they pop in from a squash.
            mesh.scale.setScalar(0.01);
            pieces.set(i, { mesh, vy: 0, targetY: rest.y, settled: false, stamp: 0 });
        }
        root.add(mesh);
        wake();
    }

    /**
     * Draw the win beam through a run of cells.
     * @param {{row:number,col:number}[]} run
     */
    function setWin(run) {
        if (!Array.isArray(run) || run.length < 2) {
            beam.visible = false;
            beamMat.opacity = 0;
            beamT = 0;
            return;
        }
        const a = cellPos(run[0].col, run[0].row, 0.30);
        const b = cellPos(run[run.length - 1].col, run[run.length - 1].row, 0.30);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        beamLen = a.distanceTo(b) + PIECE_R * 1.4;
        beam.position.copy(mid);
        // The cylinder's axis is +Y; aim it along the run.
        beam.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            b.clone().sub(a).normalize());
        beam.visible = true;
        beamT = 0;
        wake();
    }

    function reset() {
        for (const p of pieces.values()) root.remove(p.mesh);
        pieces.clear();
        cells = new Array(cols * rows).fill(EMPTY);
        beam.visible = false;
        beamMat.opacity = 0;
        wake();
    }

    // ── Pointer parallax ──────────────────────────────────────────────
    let pointerX = 0;
    let pointerY = 0;
    const onPointer = (e) => {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        pointerX = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width) * 2 - 1));
        pointerY = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height) * 2 - 1));
        wake();
    };
    const onLeave = () => { pointerX = 0; pointerY = 0; wake(); };
    // Bound to the PARENT, not the canvas: the canvas sits behind the DOM cells
    // and never receives a pointer event of its own.
    const host = canvas.parentNode || canvas;
    host.addEventListener('pointermove', onPointer, { passive: true });
    host.addEventListener('pointerleave', onLeave, { passive: true });

    // ── Sizing ────────────────────────────────────────────────────────
    function resize() {
        const w = canvas.clientWidth || host.clientWidth || 320;
        const h = canvas.clientHeight || host.clientHeight || 320;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        // Re-solve the distance for the new aspect — see frameCamera(). Without
        // this the board only fitted the aspect it happened to mount at.
        frameCamera();
        wake();
    }
    // ── Loop state ────────────────────────────────────────────────────
    // Declared BEFORE resize() runs: resize() calls wake(), which reads
    // `idleFrames`. Hoisting these `let`s out of order puts wake()'s read in
    // the temporal dead zone and every ResizeObserver tick throws.
    let raf = 0;
    let idleFrames = 0;
    let last = 0;
    let disposed = false;

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // Not always-on. A finished board with the pointer elsewhere is a static
    // image, and re-rendering it 60 times a second on a phone is the difference
    // between a warm device and a cold one. `wake()` restarts it and the loop
    // parks itself once everything has settled.
    function wake() {
        idleFrames = 0;
        if (!raf && !disposed) { last = 0; raf = requestAnimationFrame(frame); }
    }

    function frame(now) {
        raf = 0;
        if (disposed) return;
        const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
        last = now;
        let busy = false;

        // Hitstop applies here too: a chip freezing mid-fall for 90 ms when the
        // winning move lands is the same effect the 3D games get.
        const scaled = dt * Impact.getTimeScale();

        for (const p of pieces.values()) {
            if (p.settled) continue;
            busy = true;
            if (kind === 'connectfive') {
                // Free fall, then a hard floor at the rest height with a little
                // restitution. See the CHIP_G note above for why this replaced
                // the spring.
                p.vy -= CHIP_G * scaled;
                p.mesh.position.y += p.vy * scaled;
                if (p.mesh.position.y <= p.targetY) {
                    // Clamp FIRST, unconditionally. A long frame (the dt cap is
                    // 50 ms) can carry the chip well past the floor in one step,
                    // and without this the overshoot would be drawn before the
                    // bounce corrected it — which is the whole class of bug this
                    // rewrite exists to remove.
                    p.mesh.position.y = p.targetY;
                    const bounceV = Math.max(0, -p.vy) * CHIP_RESTITUTION;
                    // Apex of the hop this bounce would produce, v²/2g.
                    if (bounceV * bounceV < 2 * CHIP_G * CHIP_MIN_HOP) {
                        p.vy = 0;
                        p.settled = true;
                    } else {
                        p.vy = bounceV;
                    }
                }
            } else {
                p.stamp = Math.min(1, (p.stamp || 0) + scaled * 4.2);
                // Overshoot then settle: 1 + sin decay. A plain ease-out makes
                // the mark appear; this makes it land.
                const s = 1 + Math.sin(p.stamp * Math.PI) * 0.22 * (1 - p.stamp);
                p.mesh.scale.setScalar(p.stamp * s);
                if (p.stamp >= 1) { p.mesh.scale.setScalar(1); p.settled = true; }
            }
        }

        if (beam.visible && beamT < 1) {
            busy = true;
            beamT = Math.min(1, beamT + scaled * 2.6);
            // Sweep the beam out from the centre rather than fading it in — a
            // strike-through should be drawn, not revealed.
            beam.scale.y = beamLen * beamT;
            beamMat.opacity = 0.85 * Math.min(1, beamT * 2);
        }

        // Parallax. Chased rather than snapped so a fast pointer does not make
        // the board jitter.
        const tx = pointerY * 0.10;
        const tz = pointerX * -0.12;
        const k = 1 - Math.exp(-9 * dt);
        root.rotation.x += (tx - root.rotation.x) * k;
        root.rotation.z += (tz - root.rotation.z) * k;
        if (Math.abs(tx - root.rotation.x) > 0.0004 || Math.abs(tz - root.rotation.z) > 0.0004) busy = true;

        renderFrame(renderer, scene, camera);

        // A few grace frames after the last movement: the chase above converges
        // asymptotically, and stopping the instant `busy` goes false would leave
        // a visible fraction of a degree of tilt un-corrected.
        idleFrames = busy ? 0 : idleFrames + 1;
        if (idleFrames < 6 && !document.hidden) raf = requestAnimationFrame(frame);
    }

    const onVisible = () => { if (!document.hidden) wake(); };
    document.addEventListener('visibilitychange', onVisible);

    function dispose() {
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        ro.disconnect();
        host.removeEventListener('pointermove', onPointer);
        host.removeEventListener('pointerleave', onLeave);
        document.removeEventListener('visibilitychange', onVisible);
        for (const p of pieces.values()) root.remove(p.mesh);
        pieces.clear();
        geoO.dispose();
        geoXArm.dispose();
        geoChip.dispose();
        wellGeo.dispose();
        wellMat.dispose();
        wells.dispose();
        socketGeo.dispose();
        socketMat.dispose();
        sockets.dispose();
        slab.geometry.dispose();
        slabMat.dispose();
        beam.geometry.dispose();
        beamMat.dispose();
        mats[P1].dispose();
        mats[P2].dispose();
        renderer.dispose?.();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    return { setCells, setWin, reset, dispose, backend: isWebGPU ? 'webgpu' : 'webgl2' };
}

/**
 * A box with rounded edges, without pulling in the RoundedBoxGeometry addon.
 * Built by scaling a low-detail sphere's normals outward onto a box — cheaper
 * to ship than another module fetch, and at these sizes the difference from a
 * true rounded box is invisible.
 */
function roundedBox(w, h, d, r) {
    const radius = Math.min(r, w / 2, h / 2, d / 2);
    const geo = new THREE.BoxGeometry(w, h, d, 4, 4, 4);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    // Half-extents of the inner box the corners are rounded around.
    const ix = w / 2 - radius;
    const iy = h / 2 - radius;
    const iz = d / 2 - radius;
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        // Clamp each vertex to the inner box, then push it back out by `radius`
        // along the direction it was displaced. Vertices on a face move nowhere;
        // vertices on an edge or corner land on a cylinder or sphere of that
        // radius. That is exactly a rounded box.
        const cx = Math.max(-ix, Math.min(ix, v.x));
        const cy = Math.max(-iy, Math.min(iy, v.y));
        const cz = Math.max(-iz, Math.min(iz, v.z));
        const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
        const len = Math.hypot(dx, dy, dz);
        if (len > 1e-6) {
            const s = radius / len;
            pos.setXYZ(i, cx + dx * s, cy + dy * s, cz + dz * s);
        }
    }
    geo.computeVertexNormals();
    return geo;
}

if (typeof window !== 'undefined') {
    window.PoBoardGl = { mount };
}
