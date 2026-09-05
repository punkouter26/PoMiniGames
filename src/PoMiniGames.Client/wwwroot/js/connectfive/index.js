// connectfive/index.js — physics-driven disc drop + chain reaction for ConnectFive (§CF-1).
//
// WHY THIS EXISTS
// §GFX-1 brought the chip-drop audio + impact cue to ConnectFive but the visual
// drop itself remained a CSS keyframe (cf-slide-down). That keyframe already
// overshoots and squashes — it reads as "physical" for a single disc — but a
// new disc falling onto existing ones in the same column does not interact
// with them. The disc appears on top of its target cell regardless of what's
// already there. matter.js gives the new disc a real collision body and the
// existing discs become static "ghost" bodies, so the falling disc actually
// bounces off them as it settles.
//
// QUALITY GATES (same shape as impactBus.js / glassFx.js):
//   • reduced motion      → fall back to the keyframe, never spawn the engine
//   • low quality tier    → fall back to the keyframe
//   • matter.js not on window (CDN blocked / offline)
//                          → window.PoConnectFive is never set; the Blazor
//                            call below the page makes hits a thrown JS error
//                            which the page catches and the keyframe runs.
//   • any uncaught throw during the drop
//                          → cancelDrop() reveals the static disc on the next
//                            frame so a mid-drop failure never leaves the
//                            board blank.
//
// BUNDLE IMPACT: zero. matter.min.js loads from the jsdelivr CDN as a
// classic-script dependency injected by engineLoader.js; the trimmed WASM
// bundle does not include it. The cost is paid only by sessions that actually
// visit /connectfive.

(function () {
    'use strict';

    // matter.js exposes itself on `window.Matter` when loaded as a classic
    // script. If the CDN injection failed, we return early and never publish
    // `window.PoConnectFive` — the page's Blazor JSInterop call then throws,
    // the page catches, and the existing CSS keyframe runs as it always did.
    const Matter = window.Matter;
    if (!Matter) {
        console.warn('PoConnectFive: matter.js not on window; physics drop disabled, CSS keyframe will run.');
        return;
    }

    // ─── Module state ─────────────────────────────────────────────────────
    /** @type {Matter.Engine|null} Created once on init(), lives until reset(). */
    let _engine = null;
    /** @type {HTMLElement|null} The .cf-board element, measured on init(). */
    let _board = null;
    /** @type {object|null} Measured grid geometry — see measureBoard(). */
    let _layout = null;
    /** @type {Matter.Body[]} Static walls + floor shared by every drop. */
    let _walls = null;
    /** @type {{ new: Matter.Body, ghosts: Matter.Body[], col: number, targetRow: number, color: string }|null} */
    let _drop = null;
    /** @type {HTMLElement|null} Floating clone rendered while a drop is in flight. */
    let _clone = null;
    let _active = false;
    let _rafId = 0;
    /** Frame-counted stillness: how many consecutive frames the disc has been slow. */
    let _stillFrames = 0;
    /** rAF timestamp from last step; used for delta integration. */
    let _lastFrame = 0;

    // ─── Quality gates ────────────────────────────────────────────────────
    function motionReduced() {
        try {
            if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
            return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch { return false; }
    }
    function tier() {
        try { return document.documentElement.getAttribute('data-gfx') || 'high'; }
        catch { return 'high'; }
    }
    function enabled() {
        if (motionReduced()) return false;
        if (tier() === 'low') return false;
        return true;
    }

    // ─── Measurement ──────────────────────────────────────────────────────
    /**
     * Measure the live grid. Reads --cf-cell (set by ConnectFivePage.razor.css
     * via `clamp(…)` on the viewport) and the board's bounding rect to get
     * viewport coordinates for each cell. The grid is 9x9 with `gap: 3px` and
     * `padding: 10px` on the board frame.
     */
    function measureBoard(boardEl) {
        _board = boardEl;
        const cs = getComputedStyle(_board);
        // CSS custom property — `clamp(...)` already accounts for the viewport
        // so this single number is correct on both phones and desktops.
        const cellSize = parseFloat(cs.getPropertyValue('--cf-cell')) || 56;
        const gap = parseFloat(cs.rowGap || cs.gap || '3') || 3;
        const paddingLeft = parseFloat(cs.paddingLeft || '10') || 10;
        const paddingTop = parseFloat(cs.paddingTop || '10') || 10;
        const paddingRight = parseFloat(cs.paddingRight || paddingLeft) || paddingLeft;
        const paddingBottom = parseFloat(cs.paddingBottom || paddingTop) || paddingTop;
        const r = _board.getBoundingClientRect();

        const gridLeft = r.left + paddingLeft;
        const gridTop = r.top + paddingTop;
        const gridRight = r.right - paddingRight;
        const gridBottom = r.bottom - paddingBottom;
        const stride = cellSize + gap;

        // Pre-compute cell centres (the matter.js bodies for both the falling
        // disc and the ghost discs snap to these).
        const cells = [];
        for (let row = 0; row < 9; row++) {
            for (let col = 0; col < 9; col++) {
                cells.push({
                    row, col,
                    cx: gridLeft + col * stride + cellSize / 2,
                    cy: gridTop + row * stride + cellSize / 2,
                });
            }
        }
        _layout = {
            cellSize, gap, paddingLeft, paddingTop, paddingRight, paddingBottom,
            gridLeft, gridTop, gridRight, gridBottom, stride, cells, boardRect: r,
        };
    }

    // ─── Engine + walls ───────────────────────────────────────────────────
    function buildEngine() {
        _engine = Matter.Engine.create({ gravity: { x: 0, y: 1.55 } });
        const l = _layout;

        // Disc radius matches the CSS disc — 84% of cell width. The matter.js
        // body fits inside its cell with a little slack, so two stacked discs
        // do not visibly overlap.
        const r = l.cellSize * 0.42;

        // Walls sit OUTSIDE the grid so a disc cannot escape. The "floor"
        // sits one radius below the bottom of the grid: at rest, the disc's
        // bottom edge touches the grid bottom and its centre is gridBottom - r.
        // Left/right walls sit one radius outside the grid edges.
        const wallThickness = 200;
        _walls = [
            // Floor — beneath the grid, full board width, thick enough that a
            // bouncing disc can never tunnel through it in a single timestep.
            Matter.Bodies.rectangle(
                (l.gridLeft + l.gridRight) / 2,
                l.gridBottom + r,
                l.gridRight - l.gridLeft + 2 * wallThickness,
                wallThickness,
                { isStatic: true, render: { visible: false } }
            ),
            // Left wall
            Matter.Bodies.rectangle(
                l.gridLeft - r,
                (l.gridTop + l.gridBottom) / 2,
                wallThickness,
                l.gridBottom - l.gridTop + 2 * wallThickness,
                { isStatic: true, render: { visible: false } }
            ),
            // Right wall
            Matter.Bodies.rectangle(
                l.gridRight + r,
                (l.gridTop + l.gridBottom) / 2,
                wallThickness,
                l.gridBottom - l.gridTop + 2 * wallThickness,
                { isStatic: true, render: { visible: false } }
            ),
        ];
        Matter.World.add(_engine.world, _walls);
    }

    // ─── Per-drop bodies ──────────────────────────────────────────────────
    /**
     * Build ghost bodies for existing discs in the column above targetRow.
     * The new disc collides with them as it falls, producing the chain-reaction
     * feel — the new disc physically settles into the slot ABOVE the disc
     * immediately below it.
     *
     * Cells are read directly from the DOM (cells are rendered row-major:
     * index = row * 9 + col). We do NOT need data-row / data-col attributes.
     */
    function spawnGhosts(col, targetRow) {
        const l = _layout;
        const r = l.cellSize * 0.42;
        const ghosts = [];
        const cellEls = _board ? _board.querySelectorAll('.cf-cell') : null;
        if (!cellEls || cellEls.length < 81) return ghosts;

        // Existing discs in this column sit in rows BELOW targetRow (lower
        // row index = higher on board, larger y in viewport coords). For each
        // such row, add a ghost body ONLY if the cell actually holds a disc
        // — empty cells produce no body, so the falling disc passes straight
        // through them (which is what we want for the "first disc in column"
        // case: targetRow is the bottom row, no ghosts above).
        for (let row = targetRow + 1; row < 9; row++) {
            const idx = row * 9 + col;
            const cellEl = cellEls[idx];
            if (!cellEl) continue;
            const hasDisc = cellEl.querySelector('.piece:not(.ghost-piece)') !== null;
            if (!hasDisc) continue;
            const cx = l.gridLeft + col * l.stride + l.cellSize / 2;
            const cy = l.gridTop + row * l.stride + l.cellSize / 2;
            ghosts.push(Matter.Bodies.circle(cx, cy, r, {
                isStatic: true,
                render: { visible: false },
            }));
        }
        return ghosts;
    }

    /** Spawn the dynamic body + the floating clone that mirrors its position. */
    function spawnFallingDisc(col, color) {
        const l = _layout;
        const r = l.cellSize * 0.42;
        // Spawn JUST ABOVE the board top. The exact value doesn't matter as
        // long as it's clearly above; matter.js integrates gravity from here.
        const cx = l.gridLeft + col * l.stride + l.cellSize / 2;
        const cy = l.boardRect.top - r * 1.4;

        // Floating clone. position: fixed so it can move with the body without
        // affecting the grid layout. The clone's class matches the existing
        // .piece / .red-piece / .yellow-piece styling — no new CSS needed.
        const clone = document.createElement('div');
        clone.className = 'piece ' + (color === 'red' ? 'red-piece' : 'yellow-piece') + ' cf-physics-clone';
        clone.style.width = (r * 2) + 'px';
        clone.style.height = (r * 2) + 'px';
        clone.style.position = 'fixed';
        clone.style.left = '0';
        clone.style.top = '0';
        clone.style.zIndex = '5';
        clone.style.pointerEvents = 'none';
        clone.style.willChange = 'transform';
        clone.style.transform = `translate3d(${cx - r}px, ${cy - r}px, 0)`;
        document.body.appendChild(clone);

        // Dynamic body. Restitution is intentionally low — the disc settles
        // rather than ricocheting. FrictionAir drags it slightly so a vertical
        // fall does not run away from the framerate budget.
        const body = Matter.Bodies.circle(cx, cy, r, {
            restitution: 0.18,
            friction: 0.05,
            frictionAir: 0.012,
            density: 0.0022,
            render: { visible: false },
        });
        // A tiny lateral kick keeps the column entry visually interesting
        // (the disc never falls perfectly straight); zero on average.
        Matter.Body.setVelocity(body, { x: (Math.random() - 0.5) * 0.5, y: 0 });
        return { body, clone };
    }

    // ─── Settle detection ─────────────────────────────────────────────────
    /**
     * Where should the disc centre end up once at rest?
     *   • If targetRow is the bottom row (8), it rests on the floor one
     *     radius below the grid bottom.
     *   • Otherwise it rests on top of the disc immediately below it (which
     *     exists — the board enforces gravity, so targetRow is always the
     *     bottommost empty row). Centre sits 2r above the lower disc's centre.
     */
    function restYForRow(targetRow, col) {
        const l = _layout;
        const r = l.cellSize * 0.42;
        if (targetRow === 8) return l.gridBottom - r;
        const lowerRow = targetRow + 1;
        const cy = l.gridTop + lowerRow * l.stride + l.cellSize / 2;
        return cy - 2 * r;
    }

    /**
     * A drop is "settled" when the disc has been slow AND near its rest y for
     * a few consecutive frames. Frame-counting defeats the "false rest" case
     * where a single collision frame happens to look like stillness.
     */
    function isAtRest(body, restY) {
        // Read _layout lazily — at module init time it is still null. The
        // layout is fixed for the engine's lifetime, but only after init().
        const tol = _layout.cellSize;
        const slow = Math.abs(body.velocity.y) < 0.5 && Math.abs(body.velocity.x) < 0.6;
        const nearY = Math.abs(body.position.y - restY) < tol * 0.12;
        const nearX = Math.abs(body.position.x - _restX) < tol * 0.08;
        if (slow && nearY && nearX) { _stillFrames++; return _stillFrames >= 4; }
        _stillFrames = 0;
        return false;
    }
    // `_restX` / `_restY` are updated by dropDisc() before the rAF loop is
    // asked to settle-detect. Cached here so the closure doesn't need to read
    // _drop every frame.

    // ─── rAF loop ─────────────────────────────────────────────────────────
    function step(now) {
        if (!_engine) return;
        // Cap delta so a backgrounded tab returning mid-physics does not
        // dump 30+ steps into the engine in one frame.
        const delta = Math.min(32, _lastFrame ? now - _lastFrame : 16.67);
        _lastFrame = now;
        Matter.Engine.update(_engine, delta);

        if (_drop) {
            const b = _drop.body;
            const r = b.circleRadius;
            // Write the body position into the clone's transform each frame.
            // translate3d puts the clone on its own compositor layer so this
            // is a GPU-side move — no layout, no paint.
            _clone.style.transform = `translate3d(${b.position.x - r}px, ${b.position.y - r}px, 0)`;
            if (isAtRest(b, _restY)) finalizeDrop();
        }
        _rafId = requestAnimationFrame(step);
    }

    function finalizeDrop() {
        if (!_drop) return;
        const drop = _drop;
        try {
            Matter.World.remove(_engine.world, [drop.body, ...drop.ghosts]);
        } catch { /* engine may have been torn down already */ }
        if (drop.clone && drop.clone.parentNode) drop.clone.parentNode.removeChild(drop.clone);
        _drop = null;
        _clone = null;
        _stillFrames = 0;
        if (_board) _board.classList.remove('cf-board--physics-active');
        // §GFX-8 The landing event is observable to anyone else who wants to
        // hook into it (audio syncing, particles, scoreboard shake). The page
        // already fires the chip-drop audio from Blazor — kept there so the
        // timing is deterministic even when matter.js never loads.
        try {
            window.dispatchEvent(new CustomEvent('po-cf-drop-landed', {
                detail: { col: drop.col, row: drop.targetRow, color: drop.color }
            }));
        } catch { /* CustomEvent unavailable on a very old browser */ }
    }

    function cancelDrop() {
        // Reveal the static disc immediately on any failure path so a
        // mid-drop throw never leaves the cell visually blank.
        if (_drop) {
            try { Matter.World.remove(_engine.world, [_drop.body, ..._drop.ghosts]); }
            catch { /* engine may have been torn down already */ }
            if (_drop.clone && _drop.clone.parentNode) _drop.clone.parentNode.removeChild(_drop.clone);
            _drop = null;
            _clone = null;
        }
        _stillFrames = 0;
        if (_board) _board.classList.remove('cf-board--physics-active');
    }

    // ─── Public API ───────────────────────────────────────────────────────
    /**
     * One-time setup. Measures the board, builds the engine, starts the rAF
     * loop. Idempotent. Returns true if physics is now active.
     *
     * Accepts either a DOM element (from in-page script) or a CSS selector
     * (from Blazor's IJSRuntime, which marshalls values cleanly only as
     * primitives + strings). On Blazor's side the page passes ".cf-board".
     */
    function init(boardElOrSelector) {
        if (!enabled()) return false;
        if (_active) return true;
        const board = typeof boardElOrSelector === 'string'
            ? document.querySelector(boardElOrSelector)
            : boardElOrSelector;
        if (!board) return false;
        try {
            measureBoard(board);
            buildEngine();
            _active = true;
            _lastFrame = 0;
            _rafId = requestAnimationFrame(step);
            return true;
        } catch (e) {
            console.warn('PoConnectFive.init failed:', e);
            _active = false;
            return false;
        }
    }

    /**
     * Drop a disc into a column. Returns true if physics took the drop;
     * false if the call should fall through to the CSS keyframe (engine not
     * available, reduced motion, etc.).
     */
    function dropDisc(col, targetRow, color) {
        if (!enabled() || !_active || !_layout || !_engine) return false;
        if (typeof col !== 'number' || col < 0 || col > 8) return false;
        if (typeof targetRow !== 'number' || targetRow < 0 || targetRow > 8) return false;
        // Cancel any in-flight drop. Two simultaneous drops would compete for
        // the clone element; the caller is responsible for not double-tapping.
        if (_drop) cancelDrop();
        try {
            const ghosts = spawnGhosts(col, targetRow);
            const { body, clone } = spawnFallingDisc(col, color);
            Matter.World.add(_engine.world, [body, ...ghosts]);
            _drop = { body, ghosts, clone, col, targetRow, color };
            _restX = body.position.x;
            _restY = restYForRow(targetRow, col);
            _stillFrames = 0;
            if (_board) _board.classList.add('cf-board--physics-active');
            return true;
        } catch (e) {
            console.warn('PoConnectFive.dropDisc failed:', e);
            cancelDrop();
            return false;
        }
    }

    /** Tear down the engine and any in-flight drop. Page calls this on Dispose. */
    function reset() {
        cancelDrop();
        if (_rafId) cancelAnimationFrame(_rafId);
        _rafId = 0;
        _active = false;
        _engine = null;
        _walls = null;
        _layout = null;
        _board = null;
    }

    window.PoConnectFive = { init, dropDisc, reset, isAvailable: () => _active };
})();