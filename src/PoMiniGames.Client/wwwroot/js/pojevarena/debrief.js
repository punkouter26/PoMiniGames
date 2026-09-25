// pojevarena/debrief.js — the end-of-match "what was each team thinking" summary.
//
// Pure and node-runnable: it only reads the Black Box's decision log and the world's final
// state, so the debrief costs no extra Jev (or any AI) calls. Numbers only — the page turns them
// into sentences — so the wording lives in one place (JevDebrief.razor) and this stays testable.

const PANIC = 0.70;
const COIN_FLIP = 0.40;

/**
 * decisions: blackbox.decisions (each { frame, unit, ok, failure, action, actionConfidence,
 *            actionProbabilities, focus, focusProbabilities, panic, latencyMs }).
 * Returns { blue, red } team summaries.
 */
export function summarize(world, decisions) {
    const teams = { blue: newTeam(), red: newTeam() };

    for (const d of decisions) {
        const u = world.units[d.unit];
        if (!u) continue;
        const t = teams[u.team];
        if (!d.ok) { t.failures++; continue; }

        t.decisions++;
        t.confidenceSum += d.actionConfidence || 0;
        t.latencySum += d.latencyMs || 0;
        bump(t.actions, d.action);
        if (d.focus) bump(t.foci, d.focus);
        if ((d.actionConfidence || 0) < COIN_FLIP) t.coinFlips++;

        const byName = t.creatures[u.name] ??= { name: u.name, units: new Set(), decisions: 0, confidenceSum: 0, actions: {} };
        byName.units.add(u.idx);
        byName.decisions++;
        byName.confidenceSum += d.actionConfidence || 0;
        bump(byName.actions, d.action);

        if ((d.panic || 0) > PANIC) {
            t.panicDecisions++;
            t.panickedUnits.add(u.idx);
            if (!t.firstPanic) t.firstPanic = moment(d, u, 'first-panic');
        }
        if ((d.panic || 0) > t.peakPanic) t.peakPanic = d.panic || 0;

        if (!t.surest || (d.actionConfidence || 0) > t.surest.confidence) t.surest = moment(d, u, 'surest');
        const margin = marginOverRunnerUp(d);
        if (margin !== null && (!t.torn || margin < t.torn.margin)) t.torn = { ...moment(d, u, 'torn'), margin };
    }

    const out = {};
    for (const [team, t] of Object.entries(teams)) {
        const alive = world.units.filter(u => u.team === team && u.alive).length;
        out[team] = {
            decisions: t.decisions,
            failures: t.failures,
            averageConfidence: t.decisions ? round(t.confidenceSum / t.decisions) : 0,
            averageLatencyMs: t.decisions ? Math.round(t.latencySum / t.decisions) : 0,
            coinFlips: t.coinFlips,
            actions: shares(t.actions, t.decisions),
            foci: shares(t.foci, sum(t.foci)),
            panicDecisions: t.panicDecisions,
            panickedUnits: t.panickedUnits.size,
            peakPanic: round(t.peakPanic),
            survivors: alive,
            creatures: Object.values(t.creatures)
                .map(c => {
                    const top = shares(c.actions, c.decisions)[0];
                    return {
                        name: c.name, count: c.units.size, decisions: c.decisions,
                        topAction: top?.key ?? null, topShare: top?.share ?? 0,
                        averageConfidence: round(c.confidenceSum / c.decisions),
                    };
                })
                .sort((a, b) => b.decisions - a.decisions),
            moments: [t.surest, t.torn, t.firstPanic].filter(Boolean),
        };
    }
    return out;
}

function newTeam() {
    return {
        decisions: 0, failures: 0, confidenceSum: 0, latencySum: 0, coinFlips: 0,
        actions: {}, foci: {}, creatures: {},
        panicDecisions: 0, panickedUnits: new Set(), peakPanic: 0,
        surest: null, torn: null, firstPanic: null,
    };
}

function moment(d, u, kind) {
    // The runner-up is the best option Jev did NOT pick (its pick is not always the argmax: ties).
    const ranked = Object.entries(d.actionProbabilities || {}).filter(([k]) => k !== d.action).sort((a, b) => b[1] - a[1]);
    return {
        kind,
        frame: d.frame,
        unitIndex: u.idx,
        unit: u.label,
        name: u.name,
        action: d.action,
        confidence: round(d.actionConfidence || 0),
        runnerUp: ranked[0]?.[0] ?? null,
        runnerUpProbability: ranked[0] ? round(ranked[0][1]) : 0,
        panic: round(d.panic || 0),
    };
}

/** How far the chosen option led the best alternative (the smaller, the closer the call). */
function marginOverRunnerUp(d) {
    const p = d.actionProbabilities || {};
    const others = Object.entries(p).filter(([k]) => k !== d.action).map(([, v]) => v);
    if (!others.length || p[d.action] === undefined) return null;
    return p[d.action] - Math.max(...others);
}

const bump = (bag, key) => { if (key) bag[key] = (bag[key] || 0) + 1; };
const sum = (bag) => Object.values(bag).reduce((a, b) => a + b, 0);
const round = (v) => Math.round(v * 100) / 100;

function shares(bag, total) {
    return Object.entries(bag)
        .map(([key, n]) => ({ key, count: n, share: total ? round(n / total) : 0 }))
        .sort((a, b) => b.count - a.count);
}
