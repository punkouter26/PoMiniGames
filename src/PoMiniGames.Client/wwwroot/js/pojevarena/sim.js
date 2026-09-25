// pojevarena/sim.js — the pure 60 Hz battle simulation.
//
// No DOM, no fetch, no Date.now(): time is the tick counter and the only randomness is the
// seeded spawn jitter, so `node` can drive a whole match headlessly and the same seed plus the
// same decisions replays the same fight. Decisions come in through applyDecision() (from Jev,
// via scheduler.js); the physics never decides anything itself — it only carries out the
// latest intent, and holds it indefinitely when Jev is late (the user's call, SPEC §4.5).
//
// Units are metres and seconds throughout; render.js scales by PPM (40 px = 1 m).

import { HANDLERS } from './abilities.js';

export const PPM = 40;
export const ARENA_W = 800 / PPM;   // 20 m
export const ARENA_H = 600 / PPM;   // 15 m
export const DT = 1 / 60;
export const MATCH_SECONDS = 180;

const DAMP = 0.92;                               // per tick
const GAIN = (1 - DAMP) / (DAMP * DT);           // accel that makes terminal speed == commanded speed
const WALL_RESTITUTION = 0.5;
const BODY_RESTITUTION = 0.3;
const PANIC_THRESHOLD = 0.70;
const UNDER_FIRE_SECONDS = 1.5;
const ALLY_NEAR_M = 4;

// Melee, for every creature (SPEC §4.3).
const STRIKE_REACH_M = 0.3;
const STRIKE_WINDUP_S = 0.12;
const STRIKE_LUNGE_S = 0.12;
const STRIKE_LUNGE_MS = 3.0;
const STRIKE_COOLDOWN_S = 1.0;
const KNOCKBACK_BASE_MS = 2.0;

// Damage pipeline factors (registry Power values win where an ability carries them).
const SHELL_FACTOR = 0.6;
const BRACE_FACTOR = 0.4;
const BRACE_ARC_COS = Math.cos(Math.PI / 3);     // front 120 degrees
const POISON_DPS = 2;

// Every blow's damage, after the formulas above. The PRD numbers make a 10v10 blob of focus
// fire end in ~25 s — too fast to follow, and only ~25 Jev decisions per unit. Halving lands
// a typical match at 45-90 s. One knob, applied in applyDamage, so every source scales alike.
const DAMAGE_SCALE = 0.5;

/** mulberry32 — tiny seeded PRNG; the sim's only randomness is spawn jitter. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function radiusFor(mass) { return (10 + 3 * mass) / PPM; }

/**
 * Builds a match. `blue`/`red` are the frozen ArenaCreature rows from the match ticket;
 * `abilities` is PoJevArenaCatalog.Abilities (the tuning source).
 */
export function createWorld({ seed, blue, red, abilities }) {
    const defs = new Map(abilities.map(a => [a.id, a]));
    const rng = mulberry32(seed);
    const units = [];
    const spawn = (roster, isBlue) => {
        const cx = (isBlue ? 130 : 670) / PPM, cy = 300 / PPM;
        roster.forEach((creature, slot) => {
            // 7 on an outer ring, 3 inside, with a little seeded jitter; overlaps settle on tick 1.
            const outer = slot < 7;
            const ring = outer ? 1.55 : 0.55;
            // Red's formation is Blue's mirrored across the centre line, so slot N faces slot N.
            const base = (outer ? slot / 7 : (slot - 7) / 3) * Math.PI * 2 + rng() * 0.3;
            const angle = isBlue ? base : Math.PI - base;
            const r = radiusFor(creature.mass);
            units.push({
                idx: units.length,
                slot,
                team: isBlue ? 'blue' : 'red',
                label: `${isBlue ? 'Blue' : 'Red'}-${String(slot + 1).padStart(2, '0')}`,
                creature,
                name: creature.name,
                maxHp: creature.maxHp,
                hp: creature.maxHp,
                alive: true,
                mass: creature.mass,
                speed: creature.moveSpeed,
                r,
                x: cx + Math.cos(angle) * ring + (rng() - 0.5) * 0.2,
                y: cy + Math.sin(angle) * ring + (rng() - 0.5) * 0.2,
                vx: 0,
                vy: 0,
                facing: isBlue ? 0 : Math.PI,
                intent: { action: 'idle', focus: null, target: -1, panicked: false, decided: false, since: 0 },
                abil: (creature.abilities || []).map(id => ({ id, def: defs.get(id), cd: 0 })).filter(a => a.def),
                strike: { phase: 0, t: 0, cd: 0, target: -1, landed: false },
                cast: null,
                braced: false,
                shell: 0,
                invuln: 0,
                dash: 0, dashVx: 0, dashVy: 0,
                poison: 0,
                lastHitTime: -99,
                deathTime: -1,
                kills: 0,
                dealt: 0,
            });
        });
    };
    spawn(blue, true);
    spawn(red, false);

    return {
        seed, tick: 0, time: 0, units, projectiles: [], events: [],
        over: false, winner: null, nextProjectileId: 1,
    };
}

// ── Queries ──────────────────────────────────────────────────────────────────

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const edge = (a, b) => Math.max(0, dist(a, b) - a.r - b.r);
const enemiesOf = (w, u) => w.units.filter(o => o.alive && o.team !== u.team);
const alliesOf = (w, u) => w.units.filter(o => o.alive && o.team === u.team && o !== u);
const hpPct = (u) => u.hp / u.maxHp;

function nearest(list, u) {
    let best = null, bd = Infinity;
    for (const o of list) { const d = dist(u, o); if (d < bd) { bd = d; best = o; } }
    return best;
}

function isRanged(unit) {
    return unit.abil.some(a => HANDLERS[a.id]?.ranged);
}

export function teamCounts(w) {
    let blue = 0, red = 0;
    for (const u of w.units) if (u.alive) (u.team === 'blue' ? blue++ : red++);
    return { blue, red };
}

/**
 * Everything the scheduler sends for one unit (the server's ArenaUnitState shape) plus the
 * focus → unit index map needed to resolve Jev's target_focus answer back to a unit.
 */
export function measure(w, idx) {
    const u = w.units[idx];
    const enemies = enemiesOf(w, u);
    const allies = alliesOf(w, u);
    const candidates = {};
    const put = (focus, o) => { if (o) candidates[focus] = o.idx; };

    put('nearest_threat', nearest(enemies, u));
    put('weakest_target', enemies.reduce((b, o) => (!b || hpPct(o) < hpPct(b) ? o : b), null));
    put('strongest_threat', enemies.reduce((b, o) => (!b || o.hp > b.hp ? o : b), null));
    put('ranged_threat', nearest(enemies.filter(isRanged), u));
    const hurt = allies.filter(a => a.hp < a.maxHp);
    put('protect_ally', hurt.length ? hurt.reduce((b, o) => (hpPct(o) < hpPct(b) ? o : b)) : nearest(allies, u));

    const counts = teamCounts(w);
    const round1 = (v) => Math.round(v * 10) / 10;
    return {
        candidates,
        state: {
            unit: u.label,
            hp: Math.max(1, Math.ceil(u.hp)),
            abilityCooldowns: u.abil.map(a => round1(Math.max(0, a.cd))),
            poisoned: u.poison > 0,
            underFire: w.time - u.lastHitTime < UNDER_FIRE_SECONDS,
            alliesNear: Math.min(9, allies.filter(a => dist(u, a) <= ALLY_NEAR_M).length),
            candidates: Object.entries(candidates).map(([focus, i]) => ({
                focus,
                unit: w.units[i].label,
                distanceM: Math.min(25, round1(edge(u, w.units[i]))),
                hpPercent: Math.round(100 * hpPct(w.units[i])),
            })),
            blueAlive: counts.blue,
            redAlive: counts.red,
        },
    };
}

// ── Decisions ────────────────────────────────────────────────────────────────

/**
 * Applies one Jev answer. `candidates` is the focus → index map from the measure() that produced
 * the request, so the target is the unit Jev was actually shown. panic > 0.70 overrides combat.
 */
export function applyDecision(w, idx, decision, candidates) {
    const u = w.units[idx];
    if (!u || !u.alive) return;
    const intent = u.intent;
    const wasPanicked = intent.panicked;

    intent.action = decision.action || intent.action;
    if (decision.focus && candidates && candidates[decision.focus] !== undefined) {
        intent.focus = decision.focus;
        intent.target = candidates[decision.focus];
    }
    intent.panicked = (decision.panic ?? 0) > PANIC_THRESHOLD;
    intent.decided = true;
    intent.since = w.time;
    if (intent.panicked !== wasPanicked) w.events.push({ type: 'panic', u: idx, on: intent.panicked });
}

// ── Damage ───────────────────────────────────────────────────────────────────

/**
 * The one damage pipeline, so defences stack predictably:
 * invulnerable → 0; else × (1 − shell); × (1 − brace) if the blow lands in the front arc.
 * Poison skips the brace (it is already inside) but not the shell.
 */
export function applyDamage(w, u, amount, kind, fromX, fromY, source = -1) {
    if (!u.alive || amount <= 0) return 0;
    if (u.invuln > 0) {
        // A dodged blow is worth showing; a dodged poison tick (60 a second) is noise.
        if (kind !== 'poison') w.events.push({ type: 'dodge', u: u.idx });
        return 0;
    }

    let dmg = amount * DAMAGE_SCALE;
    if (u.shell > 0) dmg *= 1 - shellFactor(u);
    if (u.braced && kind !== 'poison') {
        const dx = fromX - u.x, dy = fromY - u.y, len = Math.hypot(dx, dy) || 1;
        const cos = (dx * Math.cos(u.facing) + dy * Math.sin(u.facing)) / len;
        if (cos >= BRACE_ARC_COS) {
            dmg *= 1 - braceFactor(u);
            w.events.push({ type: 'block', u: u.idx });
        }
    }

    u.hp = Math.max(0, u.hp - dmg);
    if (source >= 0) w.units[source].dealt += dmg;
    if (kind === 'poison') {
        // Poison ticks every frame; report it once per whole HP lost so the event stream (and
        // the Black Box recording it) stays proportional to what a viewer can actually see.
        u.poisonAcc = (u.poisonAcc || 0) + dmg;
        if (u.poisonAcc >= 1 || u.hp <= 0) {
            w.events.push({ type: 'hit', u: u.idx, kind, amount: u.poisonAcc, source });
            u.poisonAcc = 0;
        }
    } else {
        u.lastHitTime = w.time;
        w.events.push({ type: 'hit', u: u.idx, kind, amount: dmg, source });
    }

    if (u.hp <= 0) {
        u.alive = false;
        u.deathTime = w.time;
        u.vx = u.vy = 0;
        if (source >= 0) w.units[source].kills++;
        w.events.push({ type: 'death', u: u.idx, source });
    }
    return dmg;
}

const shellFactor = (u) => u.abil.find(a => a.id === 'hard_shell')?.def.power ?? SHELL_FACTOR;
const braceFactor = (u) => u.abil.find(a => a.id === 'shield_brace')?.def.power ?? BRACE_FACTOR;

export function heal(w, u, amount, source) {
    if (!u.alive) return 0;
    const healed = Math.min(amount, u.maxHp - u.hp);
    u.hp += healed;
    w.events.push({ type: 'heal', u: u.idx, amount: healed, source });
    return healed;
}

// ── The kit handed to ability handlers (keeps abilities.js free of an import cycle) ──

const kit = {
    dist, edge, nearest, enemiesOf, alliesOf, hpPct,
    ready: (a) => a.cd <= 0,
    towards: (u, t, k = 1) => steer(t.x - u.x, t.y - u.y, k),
    away: (u, t, k = 1) => steer(u.x - t.x, u.y - t.y, k),
    hold: () => ({ x: 0, y: 0, k: 0 }),
    /** Starts a wind-up; the handler's release() runs when it completes. */
    cast(w, u, a, target, windup) {
        u.cast = { id: a.id, t: 0, windup, target };
        w.events.push({ type: 'cast', u: u.idx, ability: a.id, windup });
    },
    fire(w, u, spec) {
        const t = w.units[spec.target];
        const dx = t.x - u.x, dy = t.y - u.y, len = Math.hypot(dx, dy) || 1;
        w.projectiles.push({
            id: w.nextProjectileId++, kind: spec.kind, team: u.team, source: u.idx, target: spec.target,
            x: u.x + (dx / len) * u.r, y: u.y + (dy / len) * u.r,
            vx: (dx / len) * spec.speed, vy: (dy / len) * spec.speed,
            speed: spec.speed, ttl: spec.ttl, age: 0, flight: len / spec.speed,
            power: spec.power, knock: spec.knock || 0, poison: spec.poison || 0,
            heals: !!spec.heals, homing: !!spec.homing,
        });
    },
    ability(w, u, id) { w.events.push({ type: 'ability', u: u.idx, ability: id }); },
};

function steer(dx, dy, k) {
    const len = Math.hypot(dx, dy);
    return len < 1e-6 ? { x: 0, y: 0, k: 0 } : { x: dx / len, y: dy / len, k };
}

// ── Step ─────────────────────────────────────────────────────────────────────

export function step(w, dt = DT) {
    if (w.over) return;
    w.events.length = 0;

    for (const u of w.units) if (u.alive) think(w, u, dt);
    for (const u of w.units) if (u.alive) integrate(u, dt);
    collide(w);
    for (const u of w.units) if (u.alive) confine(u);
    for (const u of w.units) if (u.alive) melee(w, u, dt);
    moveProjectiles(w, dt);
    for (const u of w.units) if (u.alive) tickStatus(w, u, dt);

    w.tick++;
    w.time = w.tick * dt;
    checkEnd(w);
}

/** Turns the current intent into a steering command, and runs ability handlers. */
function think(w, u, dt) {
    u.braced = false;
    for (const a of u.abil) a.cd = Math.max(0, a.cd - dt);
    u.strike.cd = Math.max(0, u.strike.cd - dt);

    const intent = u.intent;
    let target = intent.target >= 0 ? w.units[intent.target] : null;
    const wantsAlly = intent.focus === 'protect_ally';
    if (!target || !target.alive || (target.team === u.team) !== wantsAlly) {
        // The focus died (or never existed): fall back to the obvious one until Jev re-decides.
        target = wantsAlly ? nearest(alliesOf(w, u), u) : nearest(enemiesOf(w, u), u);
        intent.target = target ? target.idx : -1;
    }

    let cmd = kit.hold();
    if (u.cast) {
        cmd = kit.hold();                          // planted while winding up
    } else if (intent.panicked) {
        const walls = [[0, u.y], [ARENA_W, u.y], [u.x, 0], [u.x, ARENA_H]];
        const [wx, wy] = walls.reduce((b, p) => (Math.hypot(p[0] - u.x, p[1] - u.y) < Math.hypot(b[0] - u.x, b[1] - u.y) ? p : b));
        cmd = steer(wx - u.x, wy - u.y, 1);
    } else {
        const action = intent.action;
        const ability = u.abil.find(a => a.def.jevOption === action);
        if (ability && HANDLERS[ability.id]) {
            cmd = HANDLERS[ability.id].run(w, u, ability, target, kit) || kit.hold();
        } else if (action === 'melee_charge' && target && target.team !== u.team) {
            cmd = kit.towards(u, target, 1.5);
        } else if (action === 'peel_to_ally') {
            const ally = nearest(alliesOf(w, u), u);
            cmd = ally && edge(u, ally) > 0.6 ? kit.towards(u, ally, 1) : kit.hold();
        } else if (action === 'fall_back') {
            const threat = nearest(enemiesOf(w, u), u);
            cmd = threat ? kit.away(u, threat, 1) : kit.hold();
        }
    }

    if (u.shell > 0 || u.braced) cmd = kit.hold();
    u.cmd = cmd;

    // Face the target (or the way we're going); a braced unit squares up to the nearest threat.
    const faceAt = u.braced ? nearest(enemiesOf(w, u), u) : (intent.panicked ? null : target);
    const desired = faceAt ? Math.atan2(faceAt.y - u.y, faceAt.x - u.x)
        : (Math.hypot(u.vx, u.vy) > 0.2 ? Math.atan2(u.vy, u.vx) : u.facing);
    let diff = desired - u.facing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    u.facing += diff * Math.min(1, dt * 10);

    // Ability wind-ups complete here.
    if (u.cast) {
        u.cast.t += dt;
        if (u.cast.t >= u.cast.windup) {
            const cast = u.cast;
            u.cast = null;
            const a = u.abil.find(x => x.id === cast.id);
            const t = w.units[cast.target];
            if (a && t && t.alive) HANDLERS[a.id].release(w, u, a, t, kit);
        }
    }
}

function integrate(u, dt) {
    if (u.dash > 0) {
        u.vx = u.dashVx;
        u.vy = u.dashVy;
    } else {
        const c = u.cmd;
        u.vx += c.x * u.speed * c.k * GAIN * dt;
        u.vy += c.y * u.speed * c.k * GAIN * dt;
        u.vx *= DAMP;
        u.vy *= DAMP;
        if (u.braced || u.shell > 0) { u.vx *= 0.2; u.vy *= 0.2; }
        const cap = u.speed * 1.5 + (u.strike.phase === 2 ? STRIKE_LUNGE_MS : 0);
        const sp = Math.hypot(u.vx, u.vy);
        if (sp > cap) { u.vx *= cap / sp; u.vy *= cap / sp; }
    }

    u.x += u.vx * dt;
    u.y += u.vy * dt;
    confine(u);
}

/** Wall bounce; also re-run after contacts, since de-penetration can push a body past a wall. */
function confine(u) {
    if (u.x < u.r) { u.x = u.r; u.vx = Math.abs(u.vx) * WALL_RESTITUTION; }
    if (u.x > ARENA_W - u.r) { u.x = ARENA_W - u.r; u.vx = -Math.abs(u.vx) * WALL_RESTITUTION; }
    if (u.y < u.r) { u.y = u.r; u.vy = Math.abs(u.vy) * WALL_RESTITUTION; }
    if (u.y > ARENA_H - u.r) { u.y = ARENA_H - u.r; u.vy = -Math.abs(u.vy) * WALL_RESTITUTION; }
}

const effectiveMass = (u) => u.mass * (u.braced ? 3 : 1) * (u.shell > 0 ? 3 : 1);

/** Elastic circle–circle contacts with positional de-penetration; the dead no longer block. */
function collide(w) {
    const us = w.units;
    for (let i = 0; i < us.length; i++) {
        const a = us[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < us.length; j++) {
            const b = us[j];
            if (!b.alive) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.hypot(dx, dy), min = a.r + b.r;
            if (d >= min) continue;
            const nx = d > 1e-9 ? dx / d : 1, ny = d > 1e-9 ? dy / d : 0;
            const ma = effectiveMass(a), mb = effectiveMass(b);
            const ia = 1 / ma, ib = 1 / mb;
            const push = (min - d) / (ia + ib);
            a.x -= nx * push * ia; a.y -= ny * push * ia;
            b.x += nx * push * ib; b.y += ny * push * ib;
            const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
            if (rel < 0) {
                const jImp = -(1 + BODY_RESTITUTION) * rel / (ia + ib);
                a.vx -= jImp * ia * nx; a.vy -= jImp * ia * ny;
                b.vx += jImp * ib * nx; b.vy += jImp * ib * ny;
            }
        }
    }
}

/** Every creature can melee: close in on melee_charge, wind up, lunge, land on contact. */
function melee(w, u, dt) {
    const s = u.strike;
    const target = s.target >= 0 ? w.units[s.target] : null;

    if (s.phase === 0) {
        if (u.intent.panicked || u.intent.action !== 'melee_charge' || s.cd > 0 || u.shell > 0 || u.cast) return;
        const t = w.units[u.intent.target];
        if (!t || !t.alive || t.team === u.team || edge(u, t) > STRIKE_REACH_M) return;
        s.phase = 1; s.t = 0; s.target = t.idx; s.landed = false;
        w.events.push({ type: 'windup', u: u.idx, target: t.idx });
        return;
    }

    s.t += dt;
    if (!target || !target.alive) { s.phase = 0; s.cd = STRIKE_COOLDOWN_S; return; }

    if (s.phase === 1 && s.t >= STRIKE_WINDUP_S) {
        s.phase = 2; s.t = 0;
        const dx = target.x - u.x, dy = target.y - u.y, len = Math.hypot(dx, dy) || 1;
        u.vx += (dx / len) * STRIKE_LUNGE_MS;
        u.vy += (dy / len) * STRIKE_LUNGE_MS;
    } else if (s.phase === 2) {
        if (!s.landed && edge(u, target) <= 0.05) {
            s.landed = true;
            const rel = Math.hypot(u.vx - target.vx, u.vy - target.vy);
            const dmg = 15 + 0.5 * rel * u.mass;
            const dx = target.x - u.x, dy = target.y - u.y, len = Math.hypot(dx, dy) || 1;
            applyDamage(w, target, dmg, 'melee', u.x, u.y, u.idx);
            const knock = KNOCKBACK_BASE_MS * u.mass / effectiveMass(target);
            target.vx += (dx / len) * knock;
            target.vy += (dy / len) * knock;
        }
        if (s.landed || s.t >= STRIKE_LUNGE_S) {
            if (!s.landed) w.events.push({ type: 'miss', u: u.idx });
            s.phase = 0; s.cd = STRIKE_COOLDOWN_S;
        }
    }
}

function moveProjectiles(w, dt) {
    const keep = [];
    for (const p of w.projectiles) {
        p.age += dt;
        if (p.homing) {
            const t = w.units[p.target];
            if (t && t.alive) {
                const dx = t.x - p.x, dy = t.y - p.y, len = Math.hypot(dx, dy) || 1;
                p.vx = (dx / len) * p.speed; p.vy = (dy / len) * p.speed;
            }
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        let hit = null;
        for (const u of w.units) {
            if (!u.alive) continue;
            if (p.heals ? u.idx !== p.target : u.team === p.team) continue;
            if (Math.hypot(u.x - p.x, u.y - p.y) <= u.r + 0.12) { hit = u; break; }
        }

        if (hit) {
            if (p.heals) {
                heal(w, hit, p.power, p.source);
            } else {
                const src = w.units[p.source];
                applyDamage(w, hit, p.power, p.kind, p.x - p.vx * 0.05, p.y - p.vy * 0.05, p.source);
                if (p.poison > 0 && hit.alive && hit.invuln <= 0) hit.poison = Math.max(hit.poison, p.poison);
                if (p.knock > 0 && hit.alive) {
                    const len = Math.hypot(p.vx, p.vy) || 1;
                    hit.vx += (p.vx / len) * p.knock * (src ? src.mass : 1) / effectiveMass(hit);
                    hit.vy += (p.vy / len) * p.knock * (src ? src.mass : 1) / effectiveMass(hit);
                }
            }
            w.events.push({ type: 'impact', kind: p.kind, x: p.x, y: p.y, projectile: p.id });
            continue;
        }

        const inside = p.x > 0 && p.x < ARENA_W && p.y > 0 && p.y < ARENA_H;
        if (p.age < p.ttl && inside) keep.push(p);
        else w.events.push({ type: 'fizzle', kind: p.kind, x: p.x, y: p.y, projectile: p.id });
    }
    w.projectiles = keep;
}

function tickStatus(w, u, dt) {
    if (u.poison > 0) {
        u.poison = Math.max(0, u.poison - dt);
        applyDamage(w, u, POISON_DPS * dt, 'poison', u.x, u.y);
    }
    if (u.shell > 0) u.shell = Math.max(0, u.shell - dt);
    if (u.invuln > 0) u.invuln = Math.max(0, u.invuln - dt);
    if (u.dash > 0) u.dash = Math.max(0, u.dash - dt);
}

function checkEnd(w) {
    const { blue, red } = teamCounts(w);
    if (blue === 0 || red === 0) {
        w.over = true;
        w.winner = blue === 0 && red === 0 ? 'draw' : blue === 0 ? 'red' : 'blue';
        w.endReason = 'wipe';
        return;
    }
    if (w.time >= MATCH_SECONDS - 1e-9) {
        const pct = (team) => {
            let hp = 0, max = 0;
            for (const u of w.units) if (u.team === team) { hp += u.hp; max += u.maxHp; }
            return 100 * hp / max;
        };
        const b = pct('blue'), r = pct('red');
        w.over = true;
        w.winner = Math.abs(b - r) <= 1 ? 'draw' : b > r ? 'blue' : 'red';
        w.endReason = 'time';
        w.hpPercent = { blue: b, red: r };
    }
}
