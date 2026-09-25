// pojevarena/fx.js — per-ability visuals, particles, popups and decals.
//
// Everything here is driven by the sim's per-tick events (and the projectile list), never by the
// sim's internals, so the Black Box can feed recorded events back through and get the same show.
// Particle randomness is seeded from (tick, event index), not Math.random(), so a replayed frame
// sprays the same sparks. The ability visuals are keyed by registry id / projectile kind — the
// visual third of "one registry row + one handler + one visual" (see abilities.js).

const TAU = Math.PI * 2;
const MAX_PARTICLES = 400;
const MAX_DECALS = 60;
const MAX_POPUPS = 40;

function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

/** Projectile looks, by kind (spit_glob → glob, hurl_boulder → boulder, mend_bolt → mend). */
const PROJECTILES = {
    glob(ctx, p, m, time) {
        const x = m.px(p.x), y = m.py(p.y), r = m.s * 0.16;
        // Drip trail behind the glob.
        const len = Math.hypot(p.vx, p.vy) || 1;
        for (let i = 1; i <= 4; i++) {
            ctx.globalAlpha = 0.5 - i * 0.1;
            ctx.fillStyle = '#7ddc4a';
            ctx.beginPath();
            ctx.arc(x - (p.vx / len) * r * i * 1.3, y - (p.vy / len) * r * i * 1.3, r * (1 - i * 0.18), 0, TAU);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#9be35a';
        ctx.strokeStyle = '#3f7a1c';
        ctx.lineWidth = Math.max(1, r * 0.3);
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.2, r, Math.atan2(p.vy, p.vx), 0, TAU);
        ctx.fill();
        ctx.stroke();
    },
    boulder(ctx, p, m, time) {
        // Arcs visually (height from flight progress) but collides on the ground plane.
        const k = Math.min(1, p.age / Math.max(0.05, p.flight));
        const h = Math.sin(k * Math.PI) * m.s * 0.9;
        const x = m.px(p.x), y = m.py(p.y), r = m.s * 0.26;
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.beginPath();
        ctx.ellipse(x, y + r * 0.4, r * (1 - k * 0.1), r * 0.45, 0, 0, TAU);
        ctx.fill();
        ctx.save();
        ctx.translate(x, y - h);
        ctx.rotate(p.age * 9);
        ctx.fillStyle = '#8b7d6b';
        ctx.strokeStyle = '#4a4036';
        ctx.lineWidth = Math.max(1, r * 0.15);
        ctx.beginPath();
        for (let i = 0; i < 7; i++) {
            const a = (i / 7) * TAU, rr = r * (0.82 + ((i * 37) % 5) * 0.06);
            i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    },
    mend(ctx, p, m, time) {
        const x = m.px(p.x), y = m.py(p.y), r = m.s * 0.13;
        const len = Math.hypot(p.vx, p.vy) || 1;
        ctx.strokeStyle = 'rgba(157,255,176,0.7)';
        ctx.lineWidth = r * 0.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let i = 1; i <= 5; i++) {
            const bx = x - (p.vx / len) * r * i * 1.6, by = y - (p.vy / len) * r * i * 1.6;
            const wob = Math.sin(time * 20 + i) * r * 0.6;
            ctx.lineTo(bx - (p.vy / len) * wob, by + (p.vx / len) * wob);
        }
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.fillStyle = '#e9fff0';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        // A little cross so a heal never reads as an attack.
        ctx.strokeStyle = '#2e9d4a';
        ctx.lineWidth = Math.max(1, r * 0.35);
        ctx.beginPath();
        ctx.moveTo(x - r * 0.6, y); ctx.lineTo(x + r * 0.6, y);
        ctx.moveTo(x, y - r * 0.6); ctx.lineTo(x, y + r * 0.6);
        ctx.stroke();
    },
};

export function createFx() {
    const particles = [];
    const decals = [];
    const popups = [];
    let shake = 0;

    function burst(r, x, y, n, color, speed, life, size, gravity = 0) {
        for (let i = 0; i < n && particles.length < MAX_PARTICLES; i++) {
            const a = r() * TAU, v = speed * (0.4 + r() * 0.8);
            particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, age: 0, color, size: size * (0.6 + r() * 0.8), gravity });
        }
    }

    function popup(x, y, text, color, big = false) {
        if (popups.length >= MAX_POPUPS) popups.shift();
        popups.push({ x, y, text, color, age: 0, life: 0.9, big });
    }

    function decal(x, y, color, size, kind) {
        if (decals.length >= MAX_DECALS) decals.shift();
        decals.push({ x, y, color, size, kind, alpha: kind === 'death' ? 0.32 : 0.22, age: 0 });
    }

    return {
        get particleCount() { return particles.length; },
        get shakeAmount() { return shake; },

        /**
         * Turns one tick's events into visuals. `units` are the frame's views (metres), `tick`
         * seeds the randomness. `live` is false while scrubbing, when shake is suppressed.
         */
        onEvents(events, units, tick, { reduced = false, teamColor, live = true } = {}) {
            events.forEach((e, i) => {
                const r = rng(tick * 131 + i * 7919 + 17);
                const u = e.u !== undefined ? units[e.u] : null;
                const at = u ? { x: u.x, y: u.y } : { x: e.x, y: e.y };
                if (!at || !Number.isFinite(at.x)) return;
                const n = reduced ? 0.3 : 1;

                switch (e.type) {
                    case 'windup':
                        burst(r, at.x + Math.cos(u.facing) * 0.35, at.y + Math.sin(u.facing) * 0.35, Math.ceil(4 * n), '#ffffff', 1.2, 0.18, 0.05);
                        break;
                    case 'hit': {
                        if (e.kind === 'poison') {
                            burst(r, at.x, at.y, 1, '#8ee060', 0.3, 0.6, 0.06, -0.8);
                            break;
                        }
                        const heavy = e.kind === 'boulder' || e.amount >= 15;
                        const color = e.kind === 'glob' ? '#9be35a' : e.kind === 'boulder' ? '#b8a88f' : '#ffe27a';
                        burst(r, at.x, at.y, Math.ceil((heavy ? 14 : 9) * n), color, heavy ? 3.2 : 2.4, 0.35, heavy ? 0.1 : 0.07);
                        popup(at.x, at.y - 0.4, `-${Math.max(1, Math.round(e.amount))}`, '#ff8a80', heavy);
                        if (e.kind === 'glob') decal(at.x, at.y, '#6fb83a', 0.35, 'splat');
                        if (e.kind === 'boulder') decal(at.x, at.y, '#5b5146', 0.45, 'crater');
                        if (live && !reduced && heavy) shake = Math.min(1, shake + (e.kind === 'boulder' ? 0.7 : 0.35));
                        break;
                    }
                    case 'block':
                        burst(r, at.x + Math.cos(u.facing) * 0.5, at.y + Math.sin(u.facing) * 0.5, Math.ceil(7 * n), '#e8f1ff', 2.6, 0.25, 0.06);
                        popup(at.x, at.y - 0.55, 'BLOCK', '#dfe9ff');
                        break;
                    case 'dodge':
                        popup(at.x, at.y - 0.5, 'miss', '#ffffff');
                        break;
                    case 'heal':
                        burst(r, at.x, at.y, Math.ceil(10 * n), '#9dffb0', 1.2, 0.6, 0.06, -1.2);
                        popup(at.x, at.y - 0.4, `+${Math.round(e.amount)}`, '#7dff9a');
                        break;
                    case 'death':
                        burst(r, at.x, at.y, Math.ceil(18 * n), teamColor(u.team), 3.5, 0.6, 0.11);
                        decal(at.x, at.y, teamColor(u.team), 0.7, 'death');
                        if (live && !reduced) shake = Math.min(1, shake + 0.4);
                        break;
                    case 'ability':
                        if (e.ability === 'dodge_dash') burst(r, at.x, at.y, Math.ceil(8 * n), '#d9cbb0', 1.5, 0.35, 0.08);
                        if (e.ability === 'hard_shell') popup(at.x, at.y - 0.55, 'SHELL', '#e3e8f2');
                        if (e.ability === 'shield_brace') burst(r, at.x, at.y, Math.ceil(6 * n), '#d9cbb0', 0.8, 0.4, 0.07);
                        break;
                    case 'impact':
                    case 'fizzle':
                        if (e.kind === 'boulder') burst(r, e.x, e.y, Math.ceil(10 * n), '#a8987f', 2, 0.5, 0.09);
                        if (e.kind === 'glob' && e.type === 'fizzle') decal(e.x, e.y, '#6fb83a', 0.25, 'splat');
                        break;
                    case 'panic':
                        if (e.on) popup(at.x, at.y - 0.6, 'PANIC', '#7fd0ff', true);
                        break;
                }
            });
        },

        update(dt) {
            for (const p of particles) {
                p.age += dt;
                p.x += p.vx * dt; p.y += p.vy * dt;
                p.vx *= 0.9; p.vy = p.vy * 0.9 + p.gravity * dt;
            }
            for (let i = particles.length - 1; i >= 0; i--) if (particles[i].age >= particles[i].life) particles.splice(i, 1);
            for (const p of popups) p.age += dt;
            for (let i = popups.length - 1; i >= 0; i--) if (popups[i].age >= popups[i].life) popups.splice(i, 1);
            for (const d of decals) d.age += dt;
            shake = Math.max(0, shake - dt * 3);
        },

        drawDecals(ctx, m) {
            for (const d of decals) {
                const fade = d.kind === 'death' ? 1 : Math.max(0.35, 1 - d.age / 20);
                ctx.globalAlpha = d.alpha * fade;
                ctx.fillStyle = d.color;
                const x = m.px(d.x), y = m.py(d.y), r = d.size * m.s;
                ctx.beginPath();
                for (let i = 0; i < 9; i++) {
                    const a = (i / 9) * TAU, rr = r * (0.7 + ((i * 53 + Math.round(d.x * 10)) % 7) / 14);
                    i ? ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
                }
                ctx.closePath();
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        },

        drawProjectiles(ctx, projectiles, m, time) {
            for (const p of projectiles) (PROJECTILES[p.kind] || PROJECTILES.glob)(ctx, p, m, time);
        },

        drawParticles(ctx, m) {
            for (const p of particles) {
                ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(m.px(p.x), m.py(p.y), Math.max(1, p.size * m.s), 0, TAU);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        },

        drawPopups(ctx, m) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (const p of popups) {
                const k = p.age / p.life;
                ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
                const size = Math.max(10, m.s * (p.big ? 0.42 : 0.32)) * (k < 0.12 ? 0.7 + k * 2.5 : 1);
                ctx.font = `800 ${size}px system-ui, sans-serif`;
                const x = m.px(p.x), y = m.py(p.y) - k * m.s * 0.8;
                ctx.lineWidth = Math.max(2, size * 0.18);
                ctx.strokeStyle = 'rgba(0,0,0,0.7)';
                ctx.strokeText(p.text, x, y);
                ctx.fillStyle = p.color;
                ctx.fillText(p.text, x, y);
            }
            ctx.globalAlpha = 1;
        },

        /** Re-lays death splats after a Black Box jump, so fallen creatures don't just vanish. */
        restoreDeaths(deaths, teamColor) {
            for (const d of deaths) decal(d.x, d.y, teamColor(d.team), 0.7, 'death');
        },

        /** Clears transient visuals (used when the Black Box jumps, so stale sparks don't linger). */
        clear({ keepDecals = false } = {}) {
            particles.length = 0;
            popups.length = 0;
            if (!keepDecals) decals.length = 0;
            shake = 0;
        },
    };
}
