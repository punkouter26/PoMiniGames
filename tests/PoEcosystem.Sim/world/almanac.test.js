import { describe, expect, it } from 'vitest';
import { createWorld } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js';
import { snapshotWorld, restoreWorld } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/persistence/snapshot.js';
import { DEATH_CAUSE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/lifecycle.js';
import { SPECIES, SPECIES_ID } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';
import { POPULATION } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';
import { THOUGHT_SOURCE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/thoughts/nudges.js';

const stepN = (w, n) => { for (let k = 0; k < n; k++) w.step(); };
const INITIAL = [POPULATION.rabbits, POPULATION.deer, POPULATION.wolves, POPULATION.humans];

describe('almanac', () => {
  it('counts births, deaths, causes and the age pyramid without breaking conservation', () => {
    const w = createWorld({ seed: 3 });
    stepN(w, 900);   // 45 s of sim time: births and natural deaths have happened
    const s = w.stats();
    const a = s.almanac;
    expect(a.born.reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
    expect(a.died.reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
    expect(Object.keys(a.byCause).length).toBeGreaterThan(0);
    for (let sp = 0; sp < 4; sp++) {
      expect(a.born[sp] - a.died[sp]).toBe(s.counts[sp] - INITIAL[sp]);
    }
    expect(a.stages.reduce((x, y) => x + y, 0)).toBe(s.alive);
    expect(a.oldestAge).toBeGreaterThan(0);
    expect(a.oldestName.length).toBeGreaterThan(0);
  });

  it('reports zeroed counters on a fresh world and records a debug wipe', () => {
    const w = createWorld({ seed: 5 });
    const fresh = w.stats().almanac;
    expect(fresh.born).toEqual([0, 0, 0, 0]);
    expect(fresh.byCause).toEqual({});

    const rabbits = w.stats().counts[SPECIES_ID.RABBIT];
    w.debug('massKill', { species: SPECIES_ID.RABBIT });
    const a = w.stats().almanac;
    expect(a.died[SPECIES_ID.RABBIT]).toBe(rabbits);
    expect(a.byCause.debug).toBe(rabbits);
    expect(w.stats().counts[SPECIES_ID.RABBIT]).toBe(0);
  });
});

describe('telemetry ledger', () => {
  it('records one death per creature with cause, drives, movement and traits', () => {
    const w = createWorld({ seed: 6 });
    stepN(w, 400);
    const diedBefore = w.telemetry.count;
    expect(diedBefore).toBeGreaterThanOrEqual(0);

    // A known predator kill: pick two living creatures and record a predation death.
    const alive = [];
    w.entities.forEachAlive(i => alive.push(i));
    expect(alive.length).toBeGreaterThan(1);
    const [predator, prey] = alive;
    const preySpecies = w.entities.species[prey];
    const predatorSpecies = w.entities.species[predator];
    const preyName = w.entities.names[prey];
    w.kill(prey, DEATH_CAUSE.PREDATION, ' by test', predator);

    const ex = w.telemetry.export({ seed: w.seed, tick: w.clock.tick, year: w.clock.year(), alive: w.stats().counts });
    const record = ex.creatures.find(c => c.name === preyName);
    expect(record).toBeDefined();
    expect(record.cause).toBe('predation');
    expect(record.killer).toBe(SPECIES[predatorSpecies].name);
    expect(record.ageYears).toBeGreaterThanOrEqual(0);
    expect(record.distanceM).toBeGreaterThanOrEqual(0);
    expect(record.avgSpeed).toBeGreaterThanOrEqual(0);
    expect(record.traits.length).toBe(5);
    expect(ex.summary.diet[SPECIES[predatorSpecies].name][SPECIES[preySpecies].name]).toBeGreaterThanOrEqual(1);
    expect(ex.summary.species[SPECIES[preySpecies].name].causes.predation).toBeGreaterThanOrEqual(1);
    expect(ex.units.secondsPerYear).toBe(30);
  });

  it('survives a snapshot round trip with exact records and rollups', () => {
    const w = createWorld({ seed: 7 });
    stepN(w, 700);
    const restored = restoreWorld(snapshotWorld(w));
    expect(restored).not.toBe(null);
    expect(restored.telemetry.getState()).toEqual(w.telemetry.getState());
    const ex1 = w.telemetry.export({ alive: w.stats().counts });
    const ex2 = restored.telemetry.export({ alive: restored.stats().counts });
    expect(ex2.summary).toEqual(ex1.summary);
    expect(ex2.creatures).toEqual(ex1.creatures);
    // And the almanac rides the same snapshot.
    expect(restored.stats().almanac).toEqual(w.stats().almanac);
  });
});

describe('thought feed', () => {
  it('streams template thoughts with name and source', () => {
    const w = createWorld({ seed: 8 });
    stepN(w, 200);   // templateEveryTicks = 40 → several template thoughts by now
    expect(w.thoughtFeed.count).toBeGreaterThan(0);
    for (const t of w.thoughtFeed.all()) {
      expect(t.kind).toBe('thought');
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.source).toBe(THOUGHT_SOURCE.TEMPLATE);
      expect(t.text.length).toBeGreaterThan(0);
    }
  });

  it('records LLM answers with the AI source badge', () => {
    const w = createWorld({ seed: 9 });
    const req = w.thoughts.next();
    expect(req).not.toBe(null);
    w.thoughts.apply(req.handle, '{"thought":"Test nudge","trait":"curiosity","delta":0.1}');
    const entries = w.thoughtFeed.all();
    const last = entries[entries.length - 1];
    expect(last.source).toBe(THOUGHT_SOURCE.LLM);
    expect(last.text).toBe('Test nudge');
    expect(last.handle).toBe(req.handle);
  });
});
