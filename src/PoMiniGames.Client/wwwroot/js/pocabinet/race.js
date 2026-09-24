// pocabinet/race.js
//
// The per-frame race driver. Runs on the scene's frame loop for every mode:
//
//   solo / 2p — the whole race simulates here (physics.js, the same model the
//               server runs), fixed 30 Hz ticks, rendered interpolated at the
//               display rate. A HUD snapshot goes to Blazor every tick.
//   demo      — as solo, with the local car on autopilot and the camera
//               cycling cockpit → chase → TV.
//   net       — the server is authoritative. The local car is PREDICTED here:
//               each tick samples input, steps the car, sends the numbered
//               input (via Blazor → SignalR) and remembers it. Each server
//               snapshot resets the car to the server's state and replays the
//               inputs the server has not acknowledged yet; the visible
//               difference is folded into a render offset that decays over
//               ~100 ms instead of snapping. Remote cars are drawn 100 ms in
//               the past, interpolated between snapshots.
//
// Every mode records the race (all car poses + the local car's pedals) for the
// post-race telemetry chart (telemetry.js) and the replay / clip export below.
//
// Input comes from input.js (keyboard ramp, gamepad, touch, tilt); driver aids
// (physics.assistControls) are applied to the input before it is stepped or
// sent, so online they need no server support and change nobody else's physics.

import { buildTrack, wrapAngle } from './track.js';
import * as ph from './physics.js';
import { attachInput } from './input.js';
import { mountCar, unmountCar } from './cars.js';
import * as audio from './audio.js';
import { currentEnvironment } from './environment.js';
import { lapTraces, bestTrace, loadPbTrace, savePbTrace, renderTelemetry } from './telemetry.js';

const TICK = ph.TICK_SECONDS;
const COUNTDOWN = 3;
const FINISH_GRACE = 15;
const MAX_RECORD_FRAMES = 30 * 60 * 8;
const INTERP_DELAY_MS = 100;
const SNAP_DISTANCE = 40;
const PLAYER_SLOT = 2;

let race = null;

// ──────────────────────────────────────────────────────────────────────────
//  Public API (re-exported on window.PoCabinet by index.js)
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param dotnetRef  DotNetObjectReference to the page
 * @param sceneHandle / cockpitHandle / minimapHandle  mounted by the page
 * @param opts { mode: 'solo'|'demo'|'net', world, playerName, color,
 *               localCarId (net), initialSnapshot (net), settings }
 */
export function startRace(dotnetRef, sceneHandle, cockpitHandle, minimapHandle, opts) {
    stopRace();
    race = new Race(dotnetRef, sceneHandle, cockpitHandle, minimapHandle, opts || {});
    return true;
}

export function stopRace() {
    if (race) race.dispose();
    race = null;
}

export function pauseRace() { race?.setPaused(true); }
export function resumeRace() { race?.setPaused(false); }
export function pushServerSnapshot(snap) { race?.onServerSnapshot(snap); }
export function updateRaceSettings(settings) { race?.applySettings(settings); }
export function cycleCamera() { race?.cycleCamera(); }

/** Draw the post-race chart into a canvas; returns the text summary. */
export function showTelemetry(canvasId) {
    return race ? race.telemetry(canvasId) : { summary: 'No race recorded.', hasReference: false };
}

export function startReplay() { return race ? race.startReplay() : false; }
export function replayCommand(cmd, value) { race?.replayCommand(cmd, value); }
export function stopReplay() { race?.stopReplay(); }
export function recordClip() { return race ? race.recordClip() : Promise.resolve('unavailable'); }

// ──────────────────────────────────────────────────────────────────────────

class Race {
    constructor(dotnet, scene, cockpit, minimap, opts) {
        this.dotnet = dotnet;
        this.scene = scene;
        this.cockpit = cockpit;
        this.minimap = minimap;
        this.mode = opts.mode || 'solo';
        this.world = opts.world;
        this.track = buildTrack(opts.world);
        this.totalLaps = Number(opts.world?.totalLaps) || 3;
        // Rain grip is a solo-only effect: online, prediction must run the server's numbers.
        this.grip = this.mode === 'net' ? 1 : (currentEnvironment().raining ? 0.85 : 1);
        this.settings = {};
        this.cameraMode = 'cockpit';
        this.demoCameraAt = 0;
        this.paused = false;
        this.disposed = false;
        this.clock = 0;
        this.acc = 0;
        this.lastFrame = null;
        this.finishOrder = 0;
        this.firstFinishAt = -1;
        this.simDone = false;
        this.hudFinishedSent = false;
        this.lastControls = { throttle: 0, brake: 0, steer: 0 };
        this.minimapAt = 0;
        this.replay = null;
        this.rec = null;

        this.input = attachInput({
            touchRoot: 'pocabinetTouch',
            onPause: () => { try { this.dotnet.invokeMethodAsync('OnTogglePause'); } catch { /* disposed */ } },
            onCamera: () => this.cycleCamera(),
        });

        this.cars = this.mode === 'net' ? this.buildNetCars(opts) : this.buildSoloCars(opts);
        this.local = this.cars.find(c => c.isLocal) || null;
        if (this.mode === 'net' && opts.initialSnapshot) this.onServerSnapshot(opts.initialSnapshot);
        this.startRecording();
        this.applySettings(opts.settings || {});

        this.frameCb = (now) => this.frame(now);
        this.scene.onFrame(this.frameCb);
    }

    // ── Setup ────────────────────────────────────────────────────────────

    buildSoloCars(opts) {
        const cars = [];
        const player = this.makeCar({
            id: 0, name: opts.playerName || 'Player', officialId: 'player',
            color: opts.color || '#3a7d44', isPlayer: true, isLocal: true,
        });
        if (this.mode === 'demo') {
            player.persona = ph.AUTOPILOT;
            player.maxSpeed = ph.MAX_SPEED * 0.97;
            player.corneringSkill = 0.8;
        }
        ph.gridSlot(this.track, player.body, PLAYER_SLOT);
        cars.push(player);
        let slot = 0;
        ph.OFFICIALS.forEach((o, i) => {
            if (slot === PLAYER_SLOT) slot++;
            const car = this.makeCar({ id: i + 1, name: o.name, officialId: o.id, color: o.color, isPlayer: false, isLocal: false });
            car.persona = o.persona;
            car.maxSpeed = o.maxSpeed;
            car.corneringSkill = o.corneringSkill;
            ph.gridSlot(this.track, car.body, slot++);
            cars.push(car);
        });
        for (const c of cars) this.savePrev(c);
        // Grid order is race order until the lights go out.
        [...cars].sort((a, b) => b.body.distance - a.body.distance).forEach((c, i) => { c.position = i + 1; });
        return cars;
    }

    buildNetCars(opts) {
        this.net = {
            localId: Number.isInteger(opts.localCarId) ? opts.localCarId : null,
            seq: 0,
            history: [],
            snaps: [],
            offsets: [],
            offset: null,
            started: false,
            finished: false,
            renderOffset: { x: 0, y: 0, h: 0 },
        };
        const snap = opts.initialSnapshot || { cars: [] };
        const cars = (snap.cars || []).map(s => {
            const car = this.makeCar({
                id: s.id, name: s.name, officialId: s.officialId, color: s.color,
                isPlayer: !!s.isPlayer, isLocal: s.id === this.net.localId,
            });
            this.setBodyFromState(car.body, s);
            this.savePrev(car);
            return car;
        });
        return cars;
    }

    makeCar(meta) {
        const car = {
            ...meta,
            body: ph.createBody(),
            prev: { x: 0, y: 0, heading: 0 },
            render: { x: 0, y: 0, heading: 0, speed: 0, along: 0 },
            persona: null, maxSpeed: ph.MAX_SPEED, corneringSkill: 0.7,
            lapsDone: 0, lapStart: 0, lastLap: 0, bestLap: 0,
            finished: false, finishTime: 0, finishOrder: 0, position: meta.id + 1,
            prevDistance: 0,
            mesh: null,
        };
        try {
            car.mesh = mountCar(this.scene.scene, { id: meta.officialId === 'player' ? undefined : meta.officialId, name: meta.name, color: meta.color });
            car.mesh.group.visible = !meta.isLocal;
        } catch { car.mesh = null; }
        return car;
    }

    setBodyFromState(body, s) {
        body.x = Number(s.x) || 0;
        body.y = Number(s.y) || 0;
        body.heading = Number(s.heading) || 0;
        body.speed = (Number(s.speedKmh) || 0) / ph.KMH_PER_UNIT;
        const proj = this.track.project(body.x, body.y, body.segHint);
        body.segHint = proj.index;
        body.along = proj.along;
        body.lateral = proj.lateral;
        body.onGrass = Math.abs(proj.lateral) > this.track.halfWidth;
    }

    savePrev(car) {
        car.prev.x = car.body.x;
        car.prev.y = car.body.y;
        car.prev.heading = car.body.heading;
    }

    applySettings(settings) {
        this.settings = { ...this.settings, ...(settings || {}) };
        this.input.setOptions(this.settings);
        this.scene.setRacingLine?.(!!this.settings.racingLine && !this.replay);
    }

    setPaused(p) {
        // Only solo races pause; the server owns multiplayer time.
        if (this.mode === 'net') return;
        this.paused = !!p;
        if (!this.paused) this.lastFrame = null;
    }

    cycleCamera() {
        if (this.replay) {
            const order = ['chase', 'tv', 'cockpit'];
            this.replay.camera = order[(order.indexOf(this.replay.camera) + 1) % order.length];
            this.pushReplayState(true);
            return;
        }
        this.cameraMode = this.cameraMode === 'cockpit' ? 'chase' : 'cockpit';
    }

    // ── Frame loop ───────────────────────────────────────────────────────

    frame(now) {
        if (this.disposed) return;
        const dt = this.lastFrame === null ? 0 : Math.min(0.1, (now - this.lastFrame) / 1000);
        this.lastFrame = now;

        if (this.replay) {
            this.updateReplay(dt, now);
            return;
        }
        if (!this.paused) {
            this.acc += dt;
            let steps = 0;
            while (this.acc >= TICK && steps < 5) {
                this.tick();
                this.acc -= TICK;
                steps++;
            }
            if (steps === 5) this.acc = 0;
        }
        this.render(dt, now);
    }

    tick() {
        const raw = this.input.read(TICK);
        let controls = raw;
        if (this.local && this.mode !== 'demo') {
            controls = ph.assistControls(this.track, this.local.body, raw,
                { steering: this.settings.steeringAssist, autoBrake: !!this.settings.autoBrake }, this.grip);
        }
        this.lastControls = controls;
        if (this.mode === 'net') this.netTick(controls);
        else this.soloTick(controls);
    }

    soloTick(controls) {
        this.clock += TICK;
        const elapsed = this.clock - COUNTDOWN;
        if (elapsed < 0) {
            this.pushHud(elapsed);
            return;
        }
        const tickStart = Math.max(0, elapsed - TICK);
        const stepDt = elapsed - tickStart;
        const bodies = this.cars.map(c => c.body);
        for (const car of this.cars) {
            this.savePrev(car);
            car.prevDistance = car.body.distance;
            let c;
            if (car.isLocal && !car.finished && this.mode !== 'demo') c = controls;
            else {
                const persona = car.persona || ph.AUTOPILOT;
                c = ph.aiControls(this.track, car.body, persona, car.finished ? car.maxSpeed * 0.6 : car.maxSpeed,
                    car.corneringSkill, bodies, this.grip);
                if (car.isLocal) this.lastControls = c;
            }
            ph.step(this.track, car.body, c, stepDt, this.grip);
        }
        ph.resolveContacts(bodies);
        this.lapBookkeeping(tickStart, stepDt, elapsed);
        this.feedback();
        this.record(elapsed);
        this.pushHud(elapsed);
    }

    lapBookkeeping(tickStart, stepDt, elapsed) {
        const L = this.track.length;
        for (const car of this.cars) {
            if (car.finished) continue;
            while (car.body.distance >= (car.lapsDone + 1) * L) {
                const boundary = (car.lapsDone + 1) * L;
                const span = car.body.distance - car.prevDistance;
                const frac = span > 1e-9 ? Math.min(1, Math.max(0, (boundary - car.prevDistance) / span)) : 1;
                const crossedAt = tickStart + frac * stepDt;
                const lapTime = crossedAt - car.lapStart;
                if (car.isLocal && this.rec) {
                    this.rec.laps.push({ lap: car.lapsDone + 1, startT: car.lapStart, endT: crossedAt, time: lapTime });
                }
                car.lapStart = crossedAt;
                car.lastLap = lapTime;
                if (car.bestLap <= 0 || lapTime < car.bestLap) car.bestLap = lapTime;
                car.lapsDone++;
                if (car.lapsDone >= this.totalLaps) {
                    car.finished = true;
                    car.finishTime = crossedAt;
                    car.finishOrder = ++this.finishOrder;
                    if (this.firstFinishAt < 0) this.firstFinishAt = elapsed;
                    break;
                }
            }
        }
        const order = [...this.cars].sort((a, b) => {
            if (a.finished !== b.finished) return a.finished ? -1 : 1;
            if (a.finished) return a.finishOrder - b.finishOrder;
            return b.body.distance - a.body.distance;
        });
        order.forEach((c, i) => { c.position = i + 1; });
        const everyone = this.cars.every(c => c.finished);
        const grace = this.firstFinishAt >= 0 && elapsed - this.firstFinishAt > FINISH_GRACE;
        if (!this.simDone && (everyone || grace || (this.local?.finished && elapsed - this.local.finishTime > 6))) {
            this.simDone = true;
        }
    }

    netTick(controls) {
        const n = this.net;
        if (!this.local) {
            // Spectating: no car, no inputs — just keep the recording for the replay.
            if (!n.finished) this.record(this.estServerMs() / 1000 - COUNTDOWN);
            return;
        }
        n.seq++;
        const moving = n.started || this.estServerMs() >= COUNTDOWN * 1000;
        const entry = { seq: n.seq, c: controls, moving };
        n.history.push(entry);
        if (n.history.length > 120) n.history.shift();
        try {
            this.dotnet.invokeMethodAsync('OnNetInputAsync', n.seq,
                round3(controls.throttle), round3(controls.brake), round3(controls.steer));
        } catch { /* disposed */ }
        if (moving && !this.local.finished) {
            this.savePrev(this.local);
            ph.step(this.track, this.local.body, controls, TICK, 1);
            this.feedback();
        }
        if (!n.finished) this.record(this.estServerMs() / 1000 - COUNTDOWN);
    }

    feedback() {
        const car = this.local;
        if (!car) return;
        if (car.body.wallImpact > 6) {
            const s = Math.min(1, car.body.wallImpact / 60);
            this.input.rumble(s);
            audio.beep(70 + 40 * s, 0.12, 'sine', 0.06 + 0.1 * s);
        }
    }

    // ── Multiplayer ──────────────────────────────────────────────────────

    estServerMs() {
        const n = this.net;
        if (!n || n.offset === null) return 0;
        return performance.now() - n.offset;
    }

    onServerSnapshot(snap) {
        const n = this.net;
        if (!n || !snap) return;
        const now = performance.now();
        // Clock mapping: the smallest (receive − server) gap seen recently is the
        // least-delayed packet — the best estimate of the one-way offset.
        n.offsets.push(now - Number(snap.serverTimeMs || 0));
        if (n.offsets.length > 40) n.offsets.shift();
        n.offset = Math.min(...n.offsets);
        n.started = !!snap.started;
        n.snaps.push({ t: Number(snap.serverTimeMs || 0), cars: snap.cars || [] });
        if (n.snaps.length > 60) n.snaps.shift();

        for (const s of snap.cars || []) {
            const car = this.cars.find(c => c.id === s.id);
            if (!car) continue;
            car.position = s.position;
            car.finished = !!s.finished;
            car.lapsDone = Math.max(0, (s.lap || 1) - 1);
        }
        if (snap.finished) n.finished = true;
        if (this.local) this.reconcile(snap);
    }

    reconcile(snap) {
        const n = this.net;
        const s = (snap.cars || []).find(c => c.id === n.localId);
        if (!s) return;
        const ack = Number(s.ackSeq) || 0;
        while (n.history.length && n.history[0].seq <= ack) n.history.shift();

        const server = ph.createBody();
        server.segHint = this.local.body.segHint;
        this.setBodyFromState(server, s);
        // Race distance at the SERVER's position: the predicted car's distance minus how far
        // along it is ahead of the server's. Copying the predicted distance straight across
        // double-counted that gap on every snapshot, and online telemetry "laps" came out
        // four seconds long.
        let ahead = this.local.body.along - server.along;
        const half = this.track.length / 2;
        if (ahead > half) ahead -= this.track.length;
        else if (ahead < -half) ahead += this.track.length;
        server.distance = this.local.body.distance - ahead;
        if (snap.started && !s.finished) {
            for (const h of n.history) if (h.moving) ph.step(this.track, server, h.c, TICK, 1);
        }

        const cur = this.local.body;
        const dx = cur.x - server.x, dy = cur.y - server.y;
        if (Math.hypot(dx, dy) > SNAP_DISTANCE) {
            n.renderOffset.x = 0; n.renderOffset.y = 0; n.renderOffset.h = 0;
        } else {
            n.renderOffset.x += dx;
            n.renderOffset.y += dy;
            n.renderOffset.h += wrapAngle(cur.heading - server.heading);
        }
        ph.copyBody(server, cur);
        this.savePrev(this.local);
    }

    /** Remote pose at render time: 100 ms behind the server, interpolated. */
    remotePose(car, renderMs) {
        const snaps = this.net.snaps;
        if (!snaps.length) return null;
        let a = null, b = null;
        for (let i = snaps.length - 1; i >= 0; i--) {
            if (snaps[i].t <= renderMs) { a = snaps[i]; b = snaps[i + 1] || null; break; }
        }
        if (!a) a = snaps[0];
        const sa = a.cars.find(c => c.id === car.id);
        if (!sa) return null;
        const sb = b ? b.cars.find(c => c.id === car.id) : null;
        if (!sb) {
            // Past the newest snapshot: extrapolate briefly along the heading.
            const ahead = Math.min(0.1, Math.max(0, (renderMs - a.t) / 1000));
            const v = (Number(sa.speedKmh) || 0) / ph.KMH_PER_UNIT;
            return { x: sa.x + Math.cos(sa.heading) * v * ahead, y: sa.y + Math.sin(sa.heading) * v * ahead, heading: sa.heading, speed: v };
        }
        const f = b.t > a.t ? Math.min(1, Math.max(0, (renderMs - a.t) / (b.t - a.t))) : 1;
        return {
            x: sa.x + (sb.x - sa.x) * f,
            y: sa.y + (sb.y - sa.y) * f,
            heading: sa.heading + wrapAngle(sb.heading - sa.heading) * f,
            speed: ((Number(sa.speedKmh) || 0) + ((Number(sb.speedKmh) || 0) - (Number(sa.speedKmh) || 0)) * f) / ph.KMH_PER_UNIT,
        };
    }

    // ── Rendering ────────────────────────────────────────────────────────

    render(dt, now) {
        const alpha = Math.min(1, this.acc / TICK);
        const isNet = this.mode === 'net';
        const renderMs = isNet ? this.estServerMs() - INTERP_DELAY_MS : 0;
        if (isNet) {
            const k = Math.exp(-dt / 0.1);
            const o = this.net.renderOffset;
            o.x *= k; o.y *= k; o.h *= k;
        }

        for (const car of this.cars) {
            let pose;
            if (isNet && !car.isLocal) {
                pose = this.remotePose(car, renderMs);
                if (!pose) continue;
            } else {
                const b = car.body;
                pose = {
                    x: car.prev.x + (b.x - car.prev.x) * alpha,
                    y: car.prev.y + (b.y - car.prev.y) * alpha,
                    heading: car.prev.heading + wrapAngle(b.heading - car.prev.heading) * alpha,
                    speed: b.speed,
                };
                if (isNet && car.isLocal) {
                    pose.x += this.net.renderOffset.x;
                    pose.y += this.net.renderOffset.y;
                    pose.heading += this.net.renderOffset.h;
                }
            }
            car.render.x = pose.x;
            car.render.y = pose.y;
            car.render.heading = pose.heading;
            car.render.speed = pose.speed;
            car.mesh?.update({ x: pose.x, y: pose.y, heading: pose.heading, speedKmh: pose.speed * ph.KMH_PER_UNIT });
        }

        // Camera: the local car, or the race leader when spectating.
        let mode = this.cameraMode;
        if (this.mode === 'demo') {
            if (now - this.demoCameraAt > 7000) {
                this.demoCameraAt = now;
                const order = ['cockpit', 'chase', 'tv'];
                this.demoCamera = order[(order.indexOf(this.demoCamera || 'tv') + 1) % order.length];
            }
            mode = this.demoCamera || 'cockpit';
        }
        const focus = this.local || [...this.cars].sort((a, b) => a.position - b.position)[0];
        if (!this.local) mode = 'chase';
        if (focus) {
            const along = this.track.project(focus.render.x, focus.render.y, focus.body.segHint).along;
            this.scene.setView({ ...focus.render, along, mode, dt });
            if (focus.mesh) focus.mesh.group.visible = mode !== 'cockpit' || !focus.isLocal;
        }
        this.cockpit?.setVisible?.(mode === 'cockpit' && !!this.local);

        if (this.local) {
            const kmh = Math.abs(this.local.render.speed) * ph.KMH_PER_UNIT;
            this.cockpit?.updateHud?.({ speedKmh: kmh, steer: this.lastControls.steer });
            const racing = this.mode === 'net' ? (this.net.started && !this.net.finished) : (this.clock > COUNTDOWN && !this.simDone);
            audio.updateEngine(racing ? kmh : 0);
            audio.setSqueal(racing && this.local.body.sliding);
        }

        if (this.minimap && now - this.minimapAt > 66) {
            this.minimapAt = now;
            try {
                this.minimap.update(this.cars.map(c => ({
                    x: c.render.x, y: c.render.y, color: c.color, officialId: c.officialId,
                    isPlayer: c.isLocal, finished: c.finished,
                })));
            } catch { /* decorative */ }
        }
    }

    // ── HUD bridge (solo modes) ──────────────────────────────────────────

    pushHud(elapsed) {
        if (this.hudFinishedSent) return;
        const local = this.local;
        const finished = !!local?.finished;
        const snap = {
            gameCode: 'SOLO',
            serverTimeMs: Math.round(this.clock * 1000),
            elapsedRaceTime: Math.max(0, elapsed),
            started: elapsed >= 0,
            countdownSeconds: elapsed < 0 ? Math.ceil(-elapsed) : 0,
            finished,
            localCarId: local ? local.id : null,
            cars: this.cars.map(c => ({
                id: c.id, name: c.name, officialId: c.officialId, color: c.color,
                x: round2(c.body.x), y: round2(c.body.y), heading: round3(c.body.heading),
                speedKmh: Math.round(Math.abs(c.body.speed) * ph.KMH_PER_UNIT),
                lap: c.lapsDone + 1,
                lapProgress: fraction(c.body.distance / this.track.length),
                position: c.position, isPlayer: c.isLocal, finished: c.finished, ackSeq: 0,
            })),
            latestDialogue: null,
            static: null,
            bestLapSeconds: local && local.bestLap > 0 ? local.bestLap : null,
        };
        if (finished) this.hudFinishedSent = true;
        try { this.dotnet.invokeMethodAsync('OnSoloSnapshotAsync', snap); } catch { /* disposed */ }
    }

    // ── Recording ────────────────────────────────────────────────────────

    startRecording() {
        this.rec = {
            trackId: this.track.id,
            trackLength: this.track.length,
            cars: this.cars.map(c => ({ id: c.id, isLocal: c.isLocal })),
            t: [],
            poses: [],   // per frame: flat [x, y, heading, speed] × cars
            local: { dist: [], kmh: [], thr: [], brk: [], str: [] },
            laps: [],
        };
    }

    record(raceTime) {
        const r = this.rec;
        if (!r || this.simDone || r.t.length >= MAX_RECORD_FRAMES || raceTime < 0) return;
        const isNet = this.mode === 'net';
        const renderMs = isNet ? this.estServerMs() - INTERP_DELAY_MS : 0;
        const frame = [];
        for (const car of this.cars) {
            let p = car.body;
            if (isNet && !car.isLocal) p = this.remotePose(car, renderMs) || car.render;
            frame.push(round2(p.x), round2(p.y), round3(p.heading), round2(p.speed));
        }
        r.t.push(raceTime);
        r.poses.push(frame);
        const l = this.local;
        r.local.dist.push(l ? l.body.distance : 0);
        r.local.kmh.push(l ? Math.abs(l.body.speed) * ph.KMH_PER_UNIT : 0);
        r.local.thr.push(this.lastControls.throttle);
        r.local.brk.push(this.lastControls.brake);
        r.local.str.push(this.lastControls.steer);

        // Online lap boundaries come from the local car's own distance (the server
        // counts the official laps; this only slices the telemetry).
        if (isNet && l) {
            const L = this.track.length;
            const done = r.laps.length;
            if (l.body.distance >= (done + 1) * L && done < this.totalLaps) {
                const startT = done === 0 ? 0 : r.laps[done - 1].endT;
                r.laps.push({ lap: done + 1, startT, endT: raceTime, time: raceTime - startT });
            }
        }
    }

    /**
     * Draw the chart. The comparison is fixed the first time: the reference is the PB
     * trace stored BEFORE this race, then this race's best is saved if it beat it —
     * so redrawing (e.g. after the replay) never ends up comparing the lap to itself.
     */
    telemetry(canvasId) {
        if (!this.telemetryPair) {
            const best = bestTrace(lapTraces(this.rec));
            if (!best) return { summary: 'No complete lap was recorded, so there is no telemetry for this race.', hasReference: false };
            const reference = loadPbTrace(this.track.id);
            savePbTrace(this.track.id, best);
            this.telemetryPair = { best, reference };
        }
        const { best, reference } = this.telemetryPair;
        return { summary: renderTelemetry(canvasId, best, reference), hasReference: !!reference };
    }

    // ── Replay ───────────────────────────────────────────────────────────

    startReplay(fromT) {
        const r = this.rec;
        if (!r || r.t.length < 2) return false;
        const t0 = r.t[0], t1 = r.t[r.t.length - 1];
        this.replay = {
            t: Number.isFinite(fromT) ? Math.max(t0, Math.min(t1, fromT)) : t0,
            t0, t1, playing: true, speed: 1, camera: 'chase', pushedAt: 0, endAt: null,
        };
        this.scene.setRacingLine?.(false);
        audio.updateEngine(0);
        audio.setSqueal(false);
        this.pushReplayState(true);
        return true;
    }

    stopReplay() {
        this.replay = null;
        for (const car of this.cars) if (car.mesh) car.mesh.group.visible = !car.isLocal;
        this.scene.setRacingLine?.(!!this.settings.racingLine);
    }

    replayCommand(cmd, value) {
        const rp = this.replay;
        if (!rp) return;
        if (cmd === 'toggle') {
            if (!rp.playing && rp.t >= rp.t1) rp.t = rp.t0;
            rp.playing = !rp.playing;
        } else if (cmd === 'seek') {
            rp.t = rp.t0 + Math.min(1, Math.max(0, Number(value) || 0)) * (rp.t1 - rp.t0);
        } else if (cmd === 'speed') {
            rp.speed = [0.5, 1, 2].includes(Number(value)) ? Number(value) : 1;
        } else if (cmd === 'camera') {
            rp.camera = ['chase', 'tv', 'cockpit'].includes(value) ? value : 'chase';
        }
        this.pushReplayState(true);
    }

    updateReplay(dt, now) {
        const rp = this.replay, r = this.rec;
        if (rp.playing) {
            rp.t += dt * rp.speed;
            if (rp.endAt !== null && rp.t >= rp.endAt) { rp.t = rp.endAt; rp.playing = false; rp.onEnd?.(); }
            if (rp.t >= rp.t1) { rp.t = rp.t1; rp.playing = false; rp.onEnd?.(); }
        }
        const fi = (rp.t - r.t[0]) / TICK;
        const i0 = Math.max(0, Math.min(r.poses.length - 1, Math.floor(fi)));
        const i1 = Math.min(r.poses.length - 1, i0 + 1);
        const f = Math.min(1, Math.max(0, fi - i0));
        let focus = null;
        this.cars.forEach((car, k) => {
            const a = r.poses[i0], b = r.poses[i1];
            const x = a[k * 4] + (b[k * 4] - a[k * 4]) * f;
            const y = a[k * 4 + 1] + (b[k * 4 + 1] - a[k * 4 + 1]) * f;
            const heading = a[k * 4 + 2] + wrapAngle(b[k * 4 + 2] - a[k * 4 + 2]) * f;
            const speed = a[k * 4 + 3];
            car.render.x = x; car.render.y = y; car.render.heading = heading; car.render.speed = speed;
            car.mesh?.update({ x, y, heading, speedKmh: speed * ph.KMH_PER_UNIT });
            if (car.mesh) car.mesh.group.visible = true;
            if (car.isLocal) focus = car;
        });
        focus = focus || this.cars[0];
        const along = this.track.project(focus.render.x, focus.render.y, focus.body.segHint).along;
        this.scene.setView({ ...focus.render, along, mode: rp.camera, dt });
        if (focus.mesh) focus.mesh.group.visible = rp.camera !== 'cockpit';
        this.cockpit?.setVisible?.(rp.camera === 'cockpit');
        this.pushReplayState(false, now);
    }

    pushReplayState(force, now) {
        const rp = this.replay;
        if (!rp) return;
        const t = now ?? performance.now();
        if (!force && t - rp.pushedAt < 250) return;
        rp.pushedAt = t;
        try {
            this.dotnet.invokeMethodAsync('OnReplayStateAsync', rp.t - rp.t0, rp.t1 - rp.t0, rp.playing, rp.camera, rp.speed);
        } catch { /* disposed */ }
    }

    /**
     * Record the local car's best lap (chase cam, real time) to a video file via
     * MediaRecorder on the canvas stream, then share it or download it.
     * Resolves 'shared' | 'downloaded' | 'unavailable'.
     */
    async recordClip() {
        const canvas = this.scene.canvas;
        if (!canvas || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') return 'unavailable';
        const lap = [...(this.rec?.laps || [])].sort((a, b) => a.time - b.time)[0];
        const from = lap ? lap.startT : this.rec?.t[0];
        const to = lap ? lap.endT : this.rec?.t[this.rec.t.length - 1];
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 'unavailable';

        const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
            .find(m => MediaRecorder.isTypeSupported?.(m)) || '';
        let recorder;
        const chunks = [];
        try {
            recorder = new MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
        } catch {
            return 'unavailable';
        }
        recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise(resolve => { recorder.onstop = resolve; });

        if (!this.replay) this.startReplay(from);
        const rp = this.replay;
        rp.t = from; rp.speed = 1; rp.playing = true; rp.endAt = to;
        if (rp.camera === 'cockpit') rp.camera = 'chase';
        rp.onEnd = () => { rp.onEnd = null; rp.endAt = null; try { recorder.stop(); } catch { /* already stopped */ } };
        recorder.start(250);
        this.pushReplayState(true);
        await stopped;

        const type = recorder.mimeType || mime || 'video/webm';
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(chunks, { type });
        if (!blob.size) return 'unavailable';
        const file = new File([blob], `pocabinet-${this.track.id}-lap.${ext}`, { type });
        try {
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: 'Cabinet — my best lap' });
                return 'shared';
            }
        } catch (e) {
            if (e && e.name === 'AbortError') return 'shared';
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = file.name;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        return 'downloaded';
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.scene.offFrame?.(this.frameCb);
        this.input.detach();
        for (const car of this.cars) if (car.mesh) unmountCar(car.mesh);
        this.cockpit?.setVisible?.(true);
        audio.updateEngine(0);
        audio.setSqueal(false);
    }
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function round3(v) { return Math.round((Number(v) || 0) * 1000) / 1000; }
function fraction(v) { const f = v % 1; return f < 0 ? f + 1 : f; }
