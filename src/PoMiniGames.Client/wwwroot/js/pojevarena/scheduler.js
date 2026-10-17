// pojevarena/scheduler.js — the staggered decision scheduler.
//
// Every 250 ms of *sim* time (15 ticks) it sends one batch: the living units whose slot is due
// (slot = unit index mod 4). Scheduling on sim time rather than wall time means a paused or hidden
// tab (the loop stops stepping) makes no calls at all.
//
// How often a unit is asked depends on the match's brain (the ticket says which):
//   local — the free rule-based brain on the server: every unit once a second, as before.
//   jev   — paid Jev calls: a unit is asked only when its situation changed in a way that matters
//           (its target is lost or dead, its HP crossed 75/50/25 %, or a new enemy came within
//           6 m), never more often than every 2 s, and at least every 10 s so nobody is stuck on a
//           stale order. The server also answers repeated situations from a per-match cache.
//
// Optional on-device model (js/localAi.js, only when the player turned it on): after a batch
// lands, one of its units at a time is re-asked in the browser, and a valid answer within 1.5 s
// overrides the rule-based one. Anything else (busy, loading, slow, nonsense) keeps the rules.
//
// A unit with a request in flight is skipped, never double-asked. Failures change nothing: the
// unit keeps acting on its last intent, indefinitely, and its stale timer keeps climbing for the
// inspector. Account-level stops (allowance spent, match expired, Jev rejected the key) end
// scheduling for the match; units hold their intents to the end.

import { measure, applyDecision } from './sim.js';

export const SLOT_TICKS = 15;
export const SLOTS = 4;
const MAX_BATCHES_IN_FLIGHT = 3;
const STOPPING_NOTICES = new Set(['allowance-exhausted', 'match-expired', 'jev-unavailable', 'jev-rejected']);
const BASE_OPTIONS = ['melee_charge', 'peel_to_ally', 'fall_back', 'take_cover'];

// Jev brain throttle.
const JEV_MIN_INTERVAL_S = 2;
const JEV_REFRESH_S = 10;
const THREAT_RANGE_M = 6;

const hpBand = (u) => { const p = u.hp / u.maxHp; return p > 0.75 ? 0 : p > 0.5 ? 1 : p > 0.25 ? 2 : 3; };

/**
 * decide(batch) → Promise<{ decisions, remaining, notice } | { error }>, where batch is
 * { units: ArenaUnitState[] }. onDecision(frame, unitIdx, decision, request) records it.
 * brain is 'local' | 'jev'; device is the optional on-device model (localAi.js), settable later.
 */
export function createScheduler(world, { decide, onDecision, onNotice, onRemaining, brain = 'local', device = null }) {
    const inFlight = new Set();
    const lastDecided = new Float64Array(world.units.length).fill(0);   // sim time of last answer
    const throttled = brain === 'jev';
    const asked = world.units.map(() => ({ at: -Infinity, band: -1, threats: 0 }));
    let batchesInFlight = 0;
    let stopped = null;
    let calls = 0;
    let deviceBusy = false, deviceNext = 0, deviceUsed = 0, deviceMissed = 0;

    function threatsNear(u) {
        let mask = 0;
        for (const o of world.units) {
            if (o.alive && o.team !== u.team && Math.hypot(o.x - u.x, o.y - u.y) <= THREAT_RANGE_M) mask |= 1 << o.idx;
        }
        return mask;
    }

    function worthAsking(u) {
        if (!throttled) return true;
        const last = asked[u.idx];
        const since = world.time - last.at;
        if (since < JEV_MIN_INTERVAL_S) return false;
        if (since >= JEV_REFRESH_S) return true;
        const target = world.units[u.intent.target];
        if (!target || !target.alive) return true;
        if (hpBand(u) !== last.band) return true;
        return (threatsNear(u) & ~last.threats) !== 0;
    }

    function remember(u) {
        const last = asked[u.idx];
        last.at = world.time;
        last.band = hpBand(u);
        last.threats = threatsNear(u);
    }

    async function send(indices) {
        const requests = new Map();
        const units = [];
        for (const i of indices) {
            const m = measure(world, i);
            requests.set(m.state.unit, { idx: i, candidates: m.candidates, state: m.state, frame: world.tick });
            units.push(m.state);
            inFlight.add(i);
            remember(world.units[i]);
        }
        batchesInFlight++;
        calls += units.length;

        let response;
        try {
            response = await decide({ units });
        } catch {
            response = { error: 'network' };
        } finally {
            batchesInFlight--;
            for (const i of indices) inFlight.delete(i);
        }

        if (!response) response = { error: 'network' };
        if (response.error) {
            if (STOPPING_NOTICES.has(response.error)) stop(response.error);
            for (const r of requests.values()) onDecision(world.tick, r.idx, { ok: false, failure: response.error }, r);
            return;
        }

        if (typeof response.remaining === 'number' && response.remaining >= 0) onRemaining?.(response.remaining);
        const landed = [];
        for (const d of response.decisions || []) {
            const r = requests.get(d.unit);
            if (!r) continue;
            const u = world.units[r.idx];
            // Late answers for the dead, or after the whistle, are dropped (they were still paid for).
            if (d.ok && u.alive && !world.over) {
                applyDecision(world, r.idx, d, r.candidates);
                lastDecided[r.idx] = world.time;
                landed.push({ r, d });
            }
            onDecision(world.tick, r.idx, d, r);
        }
        if (response.notice && STOPPING_NOTICES.has(response.notice)) stop(response.notice);
        else if (response.notice) onNotice?.(response.notice);

        if (device && landed.length && !deviceBusy) askDevice(landed[deviceNext++ % landed.length]);
    }

    /** One unit, re-asked in the browser; a valid, timely answer overrides the rules. */
    async function askDevice({ r, d: base }) {
        const u = world.units[r.idx];
        const actions = BASE_OPTIONS.concat(u.abil.map(a => a.def?.jevOption).filter(Boolean));
        const foci = Object.keys(r.candidates);
        const started = performance.now();
        deviceBusy = true;
        let pick = null;
        try { pick = await device.pick({ situation: describe(r.state, actions), actions, foci }); }
        catch { pick = null; }
        finally { deviceBusy = false; }

        if (!pick || !u.alive || world.over) { if (!pick) deviceMissed++; return; }
        const spread = (chosen, options) => Object.fromEntries(options.map(o => [o, o === chosen ? 0.6 : 0.4 / Math.max(1, options.length - 1)]));
        const d = {
            ...base,
            action: pick.action,
            actionConfidence: 0.6,
            actionProbabilities: spread(pick.action, actions),
            focus: pick.focus ?? base.focus,
            focusConfidence: pick.focus ? 0.6 : base.focusConfidence,
            focusProbabilities: pick.focus ? spread(pick.focus, foci) : base.focusProbabilities,
            latencyMs: Math.round(performance.now() - started),
            source: 'device',
        };
        applyDecision(world, r.idx, d, r.candidates);
        lastDecided[r.idx] = world.time;
        deviceUsed++;
        onDecision(world.tick, r.idx, d, r);
    }

    function stop(reason) {
        if (stopped) return;
        stopped = reason;
        onNotice?.(reason);
    }

    return {
        /** Called once per sim tick, after step(). */
        tick() {
            if (stopped || world.over || world.tick % SLOT_TICKS !== 0) return;
            if (batchesInFlight >= MAX_BATCHES_IN_FLIGHT) return;
            const slot = (world.tick / SLOT_TICKS) % SLOTS;
            const due = world.units
                .filter(u => u.alive && u.idx % SLOTS === slot && !inFlight.has(u.idx) && worthAsking(u))
                .map(u => u.idx);
            if (due.length) send(due);
        },
        /** Seconds since the unit last got a usable answer (from match start if never). */
        staleSeconds(idx) { return world.time - lastDecided[idx]; },
        /** Hands in the on-device model once its module has loaded (null turns it off). */
        setDevice(model) { device = model; },
        /** On-device model state for the HUD, or null when it is not in play. */
        get device() { return device ? { status: device.status(), used: deviceUsed, missed: deviceMissed } : null; },
        get brain() { return brain; },
        get stoppedReason() { return stopped; },
        get calls() { return calls; },
        stop,
    };
}

/** The unit's numbers in a few words for the small on-device model. */
function describe(s, actions) {
    const parts = [
        `My HP ${s.hp}${s.underFire ? ', under fire' : ''}${s.poisoned ? ', poisoned' : ''}`,
        `${s.alliesNear} allies within 4 m`,
        `teams alive: blue ${s.blueAlive}, red ${s.redAlive}`,
    ];
    if (s.coverDistanceM >= 0) parts.push(`cover ${s.coverDistanceM} m away`);
    for (const c of s.candidates) parts.push(`${c.focus}: ${c.unit} at ${c.distanceM} m with ${c.hpPercent}% HP`);
    const cooling = s.abilityCooldowns.filter(cd => cd > 0).length;
    if (cooling) parts.push(`${cooling} of my abilities cooling down`);
    parts.push(`I can: ${actions.join(', ')}`);
    return parts.join('. ') + '.';
}
