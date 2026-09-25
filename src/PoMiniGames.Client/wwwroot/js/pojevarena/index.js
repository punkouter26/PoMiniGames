// pojevarena/index.js — the engine facade the Blazor page drives (window.PoJevArena).
//
// Contract surface (called from src/PoMiniGames.Client/Games/PoJevArena/*):
//   PoJevArena.deploy(canvasId, dotnetRef, ticketJson, abilitiesJson, optionsJson)   → starts a live match
//   PoJevArena.select(unitIdx) / cycle(+1|-1)                                         → inspector anchor
//   PoJevArena.scrub(frame) / play() / pause() / step(n) / jumpDecision(dir) / setSpeed(x)  → Black Box
//   PoJevArena.stop()                                                                  → tears the match down
//   PoJevArena.preview(canvasId, creatureJson, team) → id / stopPreview(id)            → Factory live preview
//   PoJevArena.portrait(canvasId, creatureJson, team)                                  → static library card
//
// .NET callbacks (JSON strings in and out; the page deserialises with source-gen contexts):
//   DecideAsync(batchJson) → responseJson   the only way this module reaches the server, so every call
//                                           rides the app HttpClient (antiforgery + credentials)
//   OnInspector(json)                       selected unit + the Jev distribution governing it
//   OnHud(json)                             ~4 Hz: clock, alive counts, calls, notices
//   OnMatchEnded(json)                      winner, reason, duration → page reports + opens the Black Box
//   OnBlackBox(json)                        replay position while scrubbing/playing
//
// Lifecycle: stop() (and page dispose) cancels the rAF loop, removes every listener, stops the
// scheduler and drops cached bitmaps — the PoRacer cleanup contract.

import * as sim from './sim.js';
import { createRenderer, viewOf } from './render.js';
import { createFx } from './fx.js';
import { createScheduler } from './scheduler.js';
import { createBlackBox } from './blackbox.js';
import { lookFor, newMemory, drawCreature, FLAGS } from './creatures.js';

const BASE_ACTIONS = ['idle', 'melee_charge', 'peel_to_ally', 'fall_back'];
const HUD_EVERY_S = 0.25;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

let match = null;            // the one live/replaying arena
const previews = new Map();  // id → preview loop
let nextPreviewId = 1;

function teamColorFor(canvas) {
    const css = getComputedStyle(canvas);
    const blue = css.getPropertyValue('--jev-blue').trim() || '#3d7bff';
    const red = css.getPropertyValue('--jev-red').trim() || '#f0524f';
    return (team) => (team === 'blue' ? blue : red);
}

function send(dotnet, method, payload) {
    try { dotnet.invokeMethodAsync(method, JSON.stringify(payload)).catch(() => { }); } catch { /* disposed */ }
}

// ── Live match ───────────────────────────────────────────────────────────────

function deploy(canvasId, dotnet, ticketJson, abilitiesJson, optionsJson) {
    stop();
    const canvas = document.getElementById(canvasId);
    if (!canvas) return false;

    const ticket = JSON.parse(ticketJson);
    const abilities = JSON.parse(abilitiesJson);
    const options = optionsJson ? JSON.parse(optionsJson) : {};
    const creatures = [...ticket.blue, ...ticket.red];
    const actions = BASE_ACTIONS.concat(abilities.map(a => a.jevOption));
    const reduced = reducedMotion();

    const world = sim.createWorld({ seed: ticket.seed, blue: ticket.blue, red: ticket.red, abilities });
    const fx = createFx();
    const renderer = createRenderer(canvas, { creatures, fx, reduced });
    const teamColor = teamColorFor(canvas);
    const blackbox = createBlackBox(world, { actions, abilityIds: abilities.map(a => a.id) });

    const m = {
        canvas, dotnet, world, fx, renderer, blackbox, teamColor, reduced,
        selected: options.selected ?? 0,
        mode: 'live',           // 'live' | 'replay'
        frame: 0, playing: false, speed: 1, replayAcc: 0,
        raf: 0, last: 0, acc: 0, hudAcc: 0, paused: false,
        notices: [], remaining: null, pendingEvents: [],
        listeners: [],
    };

    m.scheduler = createScheduler(world, {
        decide: async (batch) => JSON.parse(await dotnet.invokeMethodAsync('DecideAsync', JSON.stringify(batch))),
        onDecision: (frame, idx, decision, request) => {
            blackbox.recordDecision(frame, idx, decision, request);
            if (idx === m.selected) pushInspector(m);
        },
        onNotice: (notice) => { if (!m.notices.includes(notice)) m.notices.push(notice); pushHud(m, true); },
        onRemaining: (remaining) => { m.remaining = remaining; },
    });

    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); m.listeners.push(() => target.removeEventListener(type, fn, opts)); };
    on(canvas, 'pointerdown', (e) => {
        const views = currentViews(m);
        const idx = renderer.pick(e.clientX, e.clientY, views);
        if (idx >= 0) select(idx);
    });
    on(window, 'resize', () => renderer.resize());
    on(document, 'visibilitychange', () => { m.paused = document.hidden; m.last = performance.now(); });
    on(window, 'keydown', (e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
        if (e.key === '[') { cycle(-1); e.preventDefault(); }
        else if (e.key === ']') { cycle(1); e.preventDefault(); }
        else if (m.mode === 'replay' && e.key === ' ') { m.playing ? pause() : play(); e.preventDefault(); }
        else if (m.mode === 'replay' && e.key === 'ArrowLeft') { step(e.shiftKey ? -60 : -1); e.preventDefault(); }
        else if (m.mode === 'replay' && e.key === 'ArrowRight') { step(e.shiftKey ? 60 : 1); e.preventDefault(); }
    });
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => renderer.resize());
        ro.observe(canvas);
        m.listeners.push(() => ro.disconnect());
    }

    match = m;
    m.last = performance.now();
    m.raf = requestAnimationFrame((t) => loop(m, t));
    pushInspector(m);
    return true;
}

function loop(m, now) {
    if (match !== m) return;
    m.raf = requestAnimationFrame((t) => loop(m, t));
    const dt = Math.min(0.1, (now - m.last) / 1000);
    m.last = now;
    if (m.paused) return;

    if (m.mode === 'live') {
        m.acc += dt;
        while (m.acc >= sim.DT && !m.world.over) {
            m.acc -= sim.DT;
            sim.step(m.world);
            m.scheduler.tick();
            m.blackbox.record((i) => m.scheduler.staleSeconds(i));
            m.fx.onEvents(m.world.events, m.world.units, m.world.tick, { reduced: m.reduced, teamColor: m.teamColor });
            for (const e of m.world.events) m.pendingEvents.push(e);
        }
        const views = m.world.units.map(u => viewOf(u, m.world, m.scheduler.staleSeconds(u.idx)));
        m.renderer.draw({ time: m.world.time, dt, views, projectiles: m.world.projectiles, events: m.pendingEvents, selected: m.selected });
        m.pendingEvents.length = 0;

        m.hudAcc += dt;
        if (m.hudAcc >= HUD_EVERY_S) { m.hudAcc = 0; pushHud(m); pushInspector(m); }
        if (m.world.over) endMatch(m);
    } else {
        if (m.playing) {
            m.replayAcc += dt * m.speed;
            while (m.replayAcc >= sim.DT) {
                m.replayAcc -= sim.DT;
                if (m.frame >= m.blackbox.frames - 1) { m.playing = false; break; }
                m.frame++;
                const evs = m.blackbox.eventsAt(m.frame);
                const d = m.blackbox.decode(m.frame);
                m.fx.onEvents(evs, d.views, m.frame, { reduced: m.reduced, teamColor: m.teamColor, live: false });
                for (const e of evs) m.pendingEvents.push(e);
            }
        }
        drawReplay(m, dt);
    }
}

function drawReplay(m, dt) {
    const d = m.blackbox.decode(m.frame);
    m.renderer.draw({ time: d.time, dt, views: d.views, projectiles: d.projectiles, events: m.pendingEvents, selected: m.selected });
    m.pendingEvents.length = 0;
    m.hudAcc += dt;
    if (m.hudAcc >= 0.1) { m.hudAcc = 0; pushBlackBox(m); }
}

function endMatch(m) {
    m.scheduler.stop('match-over');
    const w = m.world;
    const counts = sim.teamCounts(w);
    send(m.dotnet, 'OnMatchEnded', {
        winner: w.winner, reason: w.endReason, durationSeconds: w.time,
        blueAlive: counts.blue, redAlive: counts.red,
        hpPercent: w.hpPercent || null,
        calls: m.scheduler.calls,
        decisions: m.blackbox.decisions.filter(d => d.ok).length,
        frames: m.blackbox.frames,
    });
    // Hand over to the Black Box, parked on the final frame.
    m.mode = 'replay';
    m.frame = m.blackbox.frames - 1;
    m.playing = false;
    pushBlackBox(m);
    pushInspector(m);
}

function currentViews(m) {
    return m.mode === 'live'
        ? m.world.units.map(u => viewOf(u, m.world, m.scheduler.staleSeconds(u.idx)))
        : m.blackbox.decode(m.frame).views;
}

function pushHud(m, force = false) {
    const w = m.world;
    const counts = sim.teamCounts(w);
    send(m.dotnet, 'OnHud', {
        time: w.time, blueAlive: counts.blue, redAlive: counts.red,
        calls: m.scheduler.calls, remaining: m.remaining, notices: m.notices, stopped: m.scheduler.stoppedReason, force,
    });
}

/** The inspector payload: who is selected, what they're doing, and the Jev answer governing it. */
function pushInspector(m) {
    if (!m) return;
    const frame = m.mode === 'live' ? m.world.tick : m.frame;
    const views = currentViews(m);
    const v = views[m.selected];
    if (!v) return;
    const d = m.blackbox.decisionAt(m.selected, frame);
    const stale = m.mode === 'live' ? m.scheduler.staleSeconds(m.selected) : (d ? (frame - d.frame) / 60 : frame / 60);
    const creature = m.world.units[m.selected].creature;
    send(m.dotnet, 'OnInspector', {
        unit: v.label, index: v.idx, team: v.team, name: v.name, creatureId: creature.id,
        hp: Math.max(0, Math.round(v.hp)), maxHp: v.maxHp, alive: v.alive,
        action: (v.flags & FLAGS.PANIC) ? 'panic_flee' : v.action,
        target: v.target >= 0 ? views[v.target]?.label ?? null : null,
        staleSeconds: Math.max(0, stale),
        frame, mode: m.mode,
        decision: d,
    });
}

function pushBlackBox(m) {
    send(m.dotnet, 'OnBlackBox', {
        frame: m.frame, frames: m.blackbox.frames, seconds: m.frame / 60,
        playing: m.playing, speed: m.speed, decisions: m.blackbox.decisions.length,
    });
    pushInspector(m);
}

// ── Inspector & Black Box controls ───────────────────────────────────────────

function select(idx) {
    if (!match) return;
    match.selected = Math.max(0, Math.min(match.world.units.length - 1, idx | 0));
    pushInspector(match);
}

function cycle(dir) {
    if (!match) return;
    const views = currentViews(match);
    const n = views.length;
    for (let k = 1; k <= n; k++) {
        const i = (match.selected + dir * k + n * 2) % n;
        if (views[i].alive) { select(i); return; }
    }
}

function scrub(frame) {
    const m = match;
    if (!m || m.mode !== 'replay') return;
    m.frame = Math.max(0, Math.min(m.blackbox.frames - 1, frame | 0));
    m.fx.clear();
    m.renderer.resetMemory();
    m.fx.restoreDeaths(m.blackbox.deathsUpTo(m.frame), m.teamColor);
    pushBlackBox(m);
}

function play() { if (match?.mode === 'replay') { if (match.frame >= match.blackbox.frames - 1) scrub(0); match.playing = true; pushBlackBox(match); } }
function pause() { if (match?.mode === 'replay') { match.playing = false; pushBlackBox(match); } }
function step(n) { if (match?.mode === 'replay') { match.playing = false; scrub(match.frame + (n | 0)); } }
function setSpeed(x) { if (match) { match.speed = Math.max(0.25, Math.min(4, +x || 1)); pushBlackBox(match); } }
function jumpDecision(dir) {
    if (match?.mode !== 'replay') return;
    const f = match.blackbox.neighbourDecision(match.frame, dir, match.selected);
    if (f >= 0) { match.playing = false; scrub(f); }
}

function stop() {
    const m = match;
    if (!m) return;
    match = null;
    cancelAnimationFrame(m.raf);
    m.scheduler.stop('stopped');
    for (const off of m.listeners) off();
    m.renderer.dispose();
    m.fx.clear();
}

// ── Factory preview & library portraits ─────────────────────────────────────

const PREVIEW_POSES = [
    { name: 'idle', flags: 0, speed: 0, secs: 1.4 },
    { name: 'move', flags: 0, speed: 3, secs: 1.2 },
    { name: 'windup', flags: FLAGS.WINDUP, speed: 0, secs: 0.35 },
    { name: 'strike', flags: FLAGS.LUNGE, speed: 3, secs: 0.35 },
    { name: 'ability', flags: FLAGS.CAST, speed: 0, secs: 0.9 },
    { name: 'defense', flags: 0, speed: 0, secs: 1.2 },
];

function previewPalette(canvas) {
    const css = getComputedStyle(canvas);
    const v = (n, f) => css.getPropertyValue(n).trim() || f;
    return { blue: v('--jev-blue', '#3d7bff'), blueDark: v('--jev-blue-dark', '#1b3f99'), red: v('--jev-red', '#f0524f'), redDark: v('--jev-red-dark', '#8f1f1d') };
}

function drawPose(canvas, look, creature, pose, t, poseT) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); look.cache = null; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const R = Math.min(canvas.width, canvas.height) * (0.16 + 0.03 * creature.mass / 5);
    const offense = (creature.abilities || []).find(a => a === 'spit_glob' || a === 'hurl_boulder' || a === 'mend_bolt') || null;
    const defense = (creature.abilities || []).find(a => a === 'shield_brace' || a === 'hard_shell' || a === 'dodge_dash') || null;
    let flags = pose.flags;
    if (pose.name === 'ability' && !offense) flags = 0;
    if (pose.name === 'defense') flags = defense === 'shield_brace' ? FLAGS.BRACE : defense === 'hard_shell' ? FLAGS.SHELL : defense === 'dodge_dash' ? FLAGS.DASH | FLAGS.INVULN : 0;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const view = {
        alive: true, deathAge: -1, vx: pose.speed, vy: 0, facing: 0, hp: creature.maxHp, maxHp: creature.maxHp,
        flags, castId: pose.name === 'ability' ? offense : null, castT: poseT, strikeT: poseT,
        px: cx, py: cy, lookAt: { x: cx + 100, y: cy + Math.sin(t) * 40 },
    };
    drawCreature(ctx, look, view, look.previewMem || (look.previewMem = newMemory()), cx, cy, R, t, 1 / 60, reducedMotion());
}

function preview(canvasId, creatureJson, team) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return 0;
    const creature = JSON.parse(creatureJson);
    const look = lookFor(creature, team || 'blue', previewPalette(canvas));
    const id = nextPreviewId++;
    const start = performance.now();
    const total = PREVIEW_POSES.reduce((s, p) => s + p.secs, 0);
    const state = { raf: 0 };
    const frame = (now) => {
        if (!previews.has(id)) return;
        const t = (now - start) / 1000;
        let within = reducedMotion() ? 0 : t % total, pose = PREVIEW_POSES[0];
        for (const p of PREVIEW_POSES) { if (within < p.secs) { pose = p; break; } within -= p.secs; }
        drawPose(canvas, look, creature, pose, t, within);
        canvas.dataset.pose = pose.name;
        state.raf = requestAnimationFrame(frame);
    };
    previews.set(id, state);
    state.raf = requestAnimationFrame(frame);
    return id;
}

function stopPreview(id) {
    const state = previews.get(id);
    if (!state) return;
    cancelAnimationFrame(state.raf);
    previews.delete(id);
}

function portrait(canvasId, creatureJson, team) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const creature = JSON.parse(creatureJson);
    drawPose(canvas, lookFor(creature, team || 'blue', previewPalette(canvas)), creature, PREVIEW_POSES[0], 0.4, 0);
}

const api = {
    deploy, stop, select, cycle,
    scrub, play, pause, step, setSpeed, jumpDecision,
    preview, stopPreview, portrait,
    /** Test/diagnostic hook: frames recorded and calls made (read by the E2E-UI test). */
    state: () => (match ? { mode: match.mode, frames: match.blackbox.frames, calls: match.scheduler.calls, over: match.world.over, time: match.world.time } : null),
};

window.PoJevArena = api;
export default api;
