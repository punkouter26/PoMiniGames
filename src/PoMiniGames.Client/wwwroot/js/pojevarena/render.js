// pojevarena/render.js — Canvas 2D composition of one arena frame.
//
// Layers, bottom to top: cached floor → decals → team base markers → target lines → creatures
// (y-sorted) → projectiles → particles → popups → overlay (HP bars, intent glyphs, slot badges,
// stale bubbles, selection). The renderer never reads the sim: it draws "views" (plain unit
// snapshots, see viewOf) so live play and Black Box replay are drawn by exactly the same code.
//
// Colours come from CSS custom properties on the canvas (--jev-*), read once at mount; team hues
// are scheme-invariant canvas tokens, and team is never shown by colour alone (Blue stands on a
// ring, Red on a diamond).

import { FLAGS, lookFor, newMemory, noteEvent, drawCreature, releaseLook } from './creatures.js';
import { PPM, ARENA_W, ARENA_H } from './sim.js';

const TAU = Math.PI * 2;
const ARENA_PX_W = ARENA_W * PPM;   // 800
const ARENA_PX_H = ARENA_H * PPM;   // 600

/** Builds the drawable view of a live unit (the Black Box decodes to the same shape). */
export function viewOf(u, w, staleSeconds = 0) {
    let flags = 0;
    if (u.intent.panicked) flags |= FLAGS.PANIC;
    if (u.shell > 0) flags |= FLAGS.SHELL;
    if (u.braced) flags |= FLAGS.BRACE;
    if (u.invuln > 0) flags |= FLAGS.INVULN;
    if (u.poison > 0) flags |= FLAGS.POISON;
    if (staleSeconds > 1.5) flags |= FLAGS.STALE;
    if (u.dash > 0) flags |= FLAGS.DASH;
    if (u.cast) flags |= FLAGS.CAST;
    if (u.strike.phase === 1) flags |= FLAGS.WINDUP;
    if (u.strike.phase === 2) flags |= FLAGS.LUNGE;
    return {
        idx: u.idx, team: u.team, slot: u.slot, label: u.label, name: u.name,
        alive: u.alive, deathAge: u.alive ? -1 : w.time - u.deathTime,
        x: u.x, y: u.y, vx: u.vx, vy: u.vy, facing: u.facing,
        hp: u.hp, maxHp: u.maxHp, flags,
        castId: u.cast ? u.cast.id : null, castT: u.cast ? u.cast.t : 0,
        strikeT: u.strike.t,
        action: u.intent.decided ? u.intent.action : 'idle',
        target: u.intent.target,
        focus: u.intent.focus,
        stale: staleSeconds,
    };
}

function readPalette(el) {
    const css = getComputedStyle(el);
    const v = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    return {
        blue: v('--jev-blue', '#3d7bff'),
        blueDark: v('--jev-blue-dark', '#1b3f99'),
        red: v('--jev-red', '#f0524f'),
        redDark: v('--jev-red-dark', '#8f1f1d'),
        floor: v('--jev-floor', '#2b3a2f'),
        floorLine: v('--jev-floor-line', '#324536'),
        wall: v('--jev-wall', '#141a15'),
        ink: v('--jev-ink', '#f4f6f8'),
        heal: v('--jev-heal', '#5fe07f'),
    };
}

export function createRenderer(canvas, { creatures, fx, reduced = false }) {
    const ctx = canvas.getContext('2d');
    const palette = readPalette(canvas);
    const looks = creatures.map((c, i) => lookFor(c, i < creatures.length / 2 ? 'blue' : 'red', palette));
    const memory = creatures.map(() => newMemory());
    let floor = null;
    let map = null;
    let dpr = 1;

    function resize() {
        dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const s = Math.min(canvas.width / ARENA_PX_W, canvas.height / ARENA_PX_H);   // canvas px per arena px
        const ox = (canvas.width - ARENA_PX_W * s) / 2, oy = (canvas.height - ARENA_PX_H * s) / 2;
        map = {
            s: s * PPM,                                   // canvas px per metre
            ox, oy, k: s,
            px: (x) => ox + x * PPM * s,
            py: (y) => oy + y * PPM * s,
        };
        floor = null;
        for (const l of looks) releaseLook(l);
    }

    function buildFloor() {
        const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(canvas.width, canvas.height) : Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
        const g = c.getContext('2d');
        g.fillStyle = palette.wall;
        g.fillRect(0, 0, c.width, c.height);
        const x0 = map.px(0), y0 = map.py(0), w = ARENA_PX_W * map.k, h = ARENA_PX_H * map.k;

        g.fillStyle = palette.floor;
        g.fillRect(x0, y0, w, h);
        // A 1 m tile grid, then seeded pebbles, so motion reads against the ground.
        g.strokeStyle = palette.floorLine;
        g.lineWidth = Math.max(1, map.k);
        for (let i = 1; i < ARENA_W; i++) { g.beginPath(); g.moveTo(map.px(i), y0); g.lineTo(map.px(i), y0 + h); g.stroke(); }
        for (let j = 1; j < ARENA_H; j++) { g.beginPath(); g.moveTo(x0, map.py(j)); g.lineTo(x0 + w, map.py(j)); g.stroke(); }
        let s = 12345;
        const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
        g.fillStyle = 'rgba(255,255,255,0.05)';
        for (let i = 0; i < 260; i++) { g.beginPath(); g.arc(x0 + r() * w, y0 + r() * h, (0.5 + r() * 1.6) * map.k, 0, TAU); g.fill(); }

        // Start zones: faint team-tinted circles.
        for (const [cx, col] of [[130 / PPM, palette.blue], [670 / PPM, palette.red]]) {
            g.globalAlpha = 0.12;
            g.fillStyle = col;
            g.beginPath(); g.arc(map.px(cx), map.py(7.5), 2.6 * map.s, 0, TAU); g.fill();
            g.globalAlpha = 0.35;
            g.strokeStyle = col;
            g.setLineDash([6 * map.k, 6 * map.k]);
            g.lineWidth = 2 * map.k;
            g.stroke();
            g.setLineDash([]);
            g.globalAlpha = 1;
        }
        // Centre line.
        g.strokeStyle = 'rgba(255,255,255,0.08)';
        g.lineWidth = 3 * map.k;
        g.beginPath(); g.moveTo(map.px(ARENA_W / 2), y0); g.lineTo(map.px(ARENA_W / 2), y0 + h); g.stroke();
        // Wall lip.
        g.strokeStyle = 'rgba(0,0,0,0.55)';
        g.lineWidth = 6 * map.k;
        g.strokeRect(x0, y0, w, h);
        floor = c;
    }

    const teamColor = (team) => (team === 'blue' ? palette.blue : palette.red);

    function drawMarker(v, x, y, R) {
        ctx.strokeStyle = teamColor(v.team);
        ctx.lineWidth = Math.max(1.5, R * 0.14);
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        if (v.team === 'blue') {
            ctx.ellipse(x, y + R * 0.15, R * 1.3, R * 1.05, 0, 0, TAU);
        } else {
            const rx = R * 1.35, ry = R * 1.1, cy = y + R * 0.15;
            ctx.moveTo(x, cy - ry); ctx.lineTo(x + rx, cy); ctx.lineTo(x, cy + ry); ctx.lineTo(x - rx, cy);
            ctx.closePath();
        }
        ctx.stroke();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(x, y + R * 0.35, R * 1.05, R * 0.6, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    const FRIENDLY_ACTIONS = new Set(['mend_ally', 'peel_to_ally']);

    function drawTargetLine(v, views, selected) {
        if (!v.alive || v.target < 0 || v.action === 'idle' || (v.flags & FLAGS.PANIC)) return;
        const t = views[v.target];
        if (!t || !t.alive) return;
        const friendly = FRIENDLY_ACTIONS.has(v.action) || t.team === v.team;
        ctx.globalAlpha = selected ? 0.9 : 0.22;
        ctx.strokeStyle = friendly ? palette.heal : teamColor(v.team);
        ctx.lineWidth = Math.max(1, (selected ? 2.5 : 1.5) * map.k);
        if (friendly) ctx.setLineDash([6 * map.k, 5 * map.k]);
        ctx.beginPath();
        ctx.moveTo(map.px(v.x), map.py(v.y));
        ctx.lineTo(map.px(t.x), map.py(t.y));
        ctx.stroke();
        ctx.setLineDash([]);
        if (selected) {
            // Arrowhead at the target so direction is unambiguous.
            const a = Math.atan2(t.y - v.y, t.x - v.x), tx = map.px(t.x) - Math.cos(a) * 0.55 * map.s, ty = map.py(t.y) - Math.sin(a) * 0.55 * map.s;
            ctx.fillStyle = ctx.strokeStyle;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(tx - Math.cos(a - 0.45) * 10 * map.k, ty - Math.sin(a - 0.45) * 10 * map.k);
            ctx.lineTo(tx - Math.cos(a + 0.45) * 10 * map.k, ty - Math.sin(a + 0.45) * 10 * map.k);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function drawOverlay(v, x, y, R, selected, time) {
        if (!v.alive) return;
        const barW = Math.max(26 * map.k, R * 2.2), barH = Math.max(4, 5 * map.k);
        const bx = x - barW / 2, by = y - R * 1.55 - barH;
        const pct = Math.max(0, v.hp / v.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
        ctx.fillStyle = pct > 0.5 ? '#5fe07f' : pct > 0.25 ? '#ffc247' : '#ff5a5a';
        ctx.fillRect(bx, by, barW * pct, barH);

        // Intent glyph above the bar (what Jev told it to do).
        const gy = by - 11 * map.k;
        drawGlyph(v.flags & FLAGS.PANIC ? 'panic' : v.action, x, gy, 8 * map.k, v.team);

        // Slot badge.
        ctx.font = `700 ${Math.max(9, 10 * map.k)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const badgeX = x + R * 0.95, badgeY = y + R * 0.95;
        ctx.fillStyle = teamColor(v.team);
        ctx.beginPath(); ctx.arc(badgeX, badgeY, 7.5 * map.k, 0, TAU); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(String(v.slot + 1), badgeX, badgeY + 0.5);

        if (v.flags & FLAGS.STALE) {
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            const sx = x + R * 1.1, sy = y - R * 1.1;
            ctx.beginPath(); ctx.ellipse(sx, sy, 10 * map.k, 6.5 * map.k, 0, 0, TAU); ctx.fill();
            ctx.fillStyle = '#c9ced6';
            ctx.fillText('…', sx, sy - 1);
        }

        if (selected) {
            const pulse = 1 + 0.08 * Math.sin(time * 6);
            ctx.strokeStyle = palette.ink;
            ctx.lineWidth = 2 * map.k;
            ctx.beginPath(); ctx.arc(x, y, R * 1.65 * pulse, 0, TAU); ctx.stroke();
            ctx.font = `700 ${Math.max(10, 11 * map.k)}px system-ui, sans-serif`;
            const label = `${v.label} · ${v.name}`;
            const tw = ctx.measureText(label).width + 10 * map.k;
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(x - tw / 2, y + R * 1.8, tw, 16 * map.k);
            ctx.fillStyle = palette.ink;
            ctx.fillText(label, x, y + R * 1.8 + 8 * map.k);
        }
    }

    /** Small vector icons for the unit's current intent. */
    function drawGlyph(kind, x, y, s, team) {
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath(); ctx.arc(0, 0, s * 1.15, 0, TAU); ctx.fill();
        ctx.strokeStyle = ctx.fillStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.2, s * 0.2);
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath();
        switch (kind) {
            case 'melee_charge':   // fist / claw swipe
                for (let i = -1; i <= 1; i++) { ctx.moveTo(-s * 0.55, i * s * 0.4 - s * 0.2); ctx.lineTo(s * 0.55, i * s * 0.4 + s * 0.2); }
                ctx.stroke(); break;
            case 'kite_and_shoot': // glob
                ctx.fillStyle = '#9be35a'; ctx.arc(0, 0, s * 0.45, 0, TAU); ctx.fill(); break;
            case 'lob_boulder':    // rock
                ctx.fillStyle = '#b8a88f';
                for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; ctx.lineTo(Math.cos(a) * s * 0.55, Math.sin(a) * s * 0.5); }
                ctx.closePath(); ctx.fill(); break;
            case 'mend_ally':      // cross
                ctx.strokeStyle = '#7dff9a';
                ctx.moveTo(-s * 0.55, 0); ctx.lineTo(s * 0.55, 0); ctx.moveTo(0, -s * 0.55); ctx.lineTo(0, s * 0.55); ctx.stroke(); break;
            case 'shield_brace':   // shield
                ctx.moveTo(0, -s * 0.6); ctx.lineTo(s * 0.5, -s * 0.35); ctx.lineTo(s * 0.35, s * 0.3); ctx.lineTo(0, s * 0.62);
                ctx.lineTo(-s * 0.35, s * 0.3); ctx.lineTo(-s * 0.5, -s * 0.35); ctx.closePath(); ctx.stroke(); break;
            case 'shell_up':       // dome
                ctx.arc(0, s * 0.2, s * 0.55, Math.PI, 0); ctx.closePath(); ctx.stroke(); break;
            case 'dodge_dash':     // chevrons
                ctx.moveTo(-s * 0.55, -s * 0.4); ctx.lineTo(-s * 0.1, 0); ctx.lineTo(-s * 0.55, s * 0.4);
                ctx.moveTo(0, -s * 0.4); ctx.lineTo(s * 0.45, 0); ctx.lineTo(0, s * 0.4); ctx.stroke(); break;
            case 'fall_back':      // back arrow
                ctx.moveTo(s * 0.55, 0); ctx.lineTo(-s * 0.5, 0); ctx.moveTo(-s * 0.15, -s * 0.35); ctx.lineTo(-s * 0.55, 0); ctx.lineTo(-s * 0.15, s * 0.35); ctx.stroke(); break;
            case 'peel_to_ally':   // two linked dots
                ctx.arc(-s * 0.3, 0, s * 0.22, 0, TAU); ctx.moveTo(s * 0.52, 0); ctx.arc(s * 0.3, 0, s * 0.22, 0, TAU); ctx.fill(); break;
            case 'panic':          // !
                ctx.fillStyle = '#7fd0ff';
                ctx.fillRect(-s * 0.12, -s * 0.6, s * 0.24, s * 0.75);
                ctx.beginPath(); ctx.arc(0, s * 0.45, s * 0.14, 0, TAU); ctx.fill(); break;
            default:               // idle / awaiting orders
                for (let i = -1; i <= 1; i++) { ctx.moveTo(i * s * 0.35 + s * 0.1, 0); ctx.arc(i * s * 0.35, 0, s * 0.1, 0, TAU); }
                ctx.fill();
        }
        ctx.restore();
    }

    resize();

    return {
        looks,
        resize,

        /**
         * Draws one frame. frame = { time, tick, dt, views, projectiles, events, selected, live };
         * `selected` is a unit index or an array of them (Dual Inspector: one per team).
         * `events` are this frame's sim events (fed to fx once per sim tick by the caller).
         */
        draw(frame) {
            if (!floor) buildFloor();
            const { views, projectiles = [], selected = -1, time = 0, dt = 1 / 60 } = frame;
            const picked = new Set([].concat(selected));

            for (const e of frame.events || []) if (e.u !== undefined && memory[e.u]) noteEvent(memory[e.u], e);
            fx.update(dt);

            const shake = reduced ? 0 : fx.shakeAmount;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(floor, 0, 0);
            if (shake > 0) ctx.translate(Math.sin(time * 91) * shake * 5 * map.k, Math.cos(time * 77) * shake * 5 * map.k);

            fx.drawDecals(ctx, map);
            for (const v of views) if (v.alive) drawMarker(v, map.px(v.x), map.py(v.y), (v.r ?? radius(v)) * map.s);
            for (const v of views) drawTargetLine(v, views, picked.has(v.idx));

            const order = views.slice().sort((a, b) => a.y - b.y);
            for (const v of order) {
                const R = radius(v) * map.s;
                const x = map.px(v.x), y = map.py(v.y);
                const target = v.target >= 0 ? views[v.target] : null;
                v.px = x; v.py = y;
                v.lookAt = target && target.alive ? { x: map.px(target.x), y: map.py(target.y) } : null;
                drawCreature(ctx, looks[v.idx], v, memory[v.idx], x, y, R, time, dt, reduced);
            }

            fx.drawProjectiles(ctx, projectiles, map, time);
            fx.drawParticles(ctx, map);
            for (const v of order) drawOverlay(v, map.px(v.x), map.py(v.y), radius(v) * map.s, picked.has(v.idx), time);
            fx.drawPopups(ctx, map);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        },

        /** Unit index under a client-space point (for click-to-inspect), or -1. */
        pick(clientX, clientY, views) {
            const rect = canvas.getBoundingClientRect();
            const x = (clientX - rect.left) * dpr, y = (clientY - rect.top) * dpr;
            let best = -1, bd = Infinity;
            for (const v of views) {
                if (!v.alive) continue;
                const d = Math.hypot(map.px(v.x) - x, map.py(v.y) - y);
                const R = radius(v) * map.s * 1.6;
                if (d < R && d < bd) { bd = d; best = v.idx; }
            }
            return best;
        },

        /** Forgets per-unit animation memory (Black Box jumps). */
        resetMemory() { for (let i = 0; i < memory.length; i++) memory[i] = newMemory(); },

        dispose() {
            for (const l of looks) releaseLook(l);
            floor = null;
        },
    };

    function radius(v) { return (10 + 3 * creatures[v.idx].mass) / PPM; }
}
