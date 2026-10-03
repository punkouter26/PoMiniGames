import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../src/PoMiniGames.Client/wwwroot/js/poracer/snapshot.js', import.meta.url), 'utf8');
const { prepareSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function field(count = 100) {
    const cars = Array.from({ length: count }, (_, i) => ({
        id: i + 1, x: i + 0.1, y: i + 0.2, heading: i + 0.3, speed: i + 0.4,
        boostGlow: 0.5, skidIntensity: 0.6, damage: 0.7, surface: i % 2 ? 'sand' : 'asphalt',
        position: i + 1, lap: 2, finished: false, drafting: true, drift: 0.8, boostTimer: 0.9,
        currentLapSeconds: 12.345, bestLapSeconds: 11, lastLapSeconds: 13,
    }));
    return {
        snapshot: { cars, serverTimeMs: 10000, elapsedRaceTime: 7, countdownMs: 0,
            countdownSeconds: 0, started: true, paused: false, finished: false },
        roster: cars.map(c => ({ id: c.id })),
    };
}

test('all 100 cars reach rendering, with the original 14-number stride', () => {
    const { snapshot, roster } = field();
    const { flat, hud, lapNow, running } = prepareSnapshot(snapshot, roster, 49);
    assert.equal(flat.length, 1400);
    for (let i = 0; i < snapshot.cars.length; i++) {
        const c = snapshot.cars[i];
        assert.deepEqual([...flat.slice(i * 14, (i + 1) * 14)],
            [c.x, c.y, c.heading, c.speed, c.boostGlow, c.skidIntensity, c.damage,
                c.surface === 'sand' ? 1 : 0, c.position, c.lap, 0, 1, c.drift, c.boostTimer]);
    }
    assert.deepEqual(hud.cars.map(c => c.position), [1, 49, 50, 51]);
    assert.equal(hud.serverTimeMs, snapshot.serverTimeMs);
    assert.equal(hud.cars.find(c => c.id === 50).bestLapSeconds, 11);
    assert.equal(lapNow, 12.345);
    assert.equal(running, true);
    assert.equal(snapshot.cars.length, 100);
});

test('spectators and drivers at either end retain four readable standings', () => {
    const { snapshot, roster } = field();
    for (const [local, positions] of [[-1, [1, 2, 3, 4]], [0, [1, 2, 3, 4]], [99, [1, 98, 99, 100]]]) {
        assert.deepEqual(prepareSnapshot(snapshot, roster, local).hud.cars.map(c => c.position), positions);
    }
    assert.equal(prepareSnapshot(snapshot, roster, -1).lapNow, 0);
});

test('trial and 8-car online fields preserve player, finish, pause and timing', () => {
    for (const count of [1, 8]) {
        const { snapshot, roster } = field(count);
        snapshot.cars[0].finished = true;
        snapshot.paused = true;
        let prepared = prepareSnapshot(snapshot, roster, 0);
        assert.equal(prepared.flat[10], 1);
        assert.equal(prepared.hud.cars.length, Math.min(4, count));
        assert.equal(prepared.running, false);
        snapshot.paused = false; snapshot.finished = true;
        assert.equal(prepareSnapshot(snapshot, roster, 0).running, false);
        snapshot.finished = false; snapshot.started = false;
        assert.equal(prepareSnapshot(snapshot, roster, 0).running, false);
    }
});

test('car IDs are resolved by roster order, not assumed to be positions', () => {
    const { snapshot, roster } = field();
    snapshot.cars[49].position = 1;
    snapshot.cars[0].position = 50;
    const prepared = prepareSnapshot(snapshot, roster, 49);
    assert.equal(prepared.flat[49 * 14 + 8], 1);
    assert.ok(prepared.hud.cars.some(c => c.id === 50));
});

test('invalid field sizes and changed car order fail explicitly', () => {
    const { snapshot, roster } = field();
    assert.throws(() => prepareSnapshot(snapshot, [], -1), /does not match/);
    assert.throws(() => prepareSnapshot({ cars: [] }, [], -1), /does not match/);
    snapshot.cars[0].id = 999;
    assert.throws(() => prepareSnapshot(snapshot, roster, -1), /order changed/);
});
