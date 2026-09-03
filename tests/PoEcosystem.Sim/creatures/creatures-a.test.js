import { describe, expect, it } from 'vitest';
import { SPECIES, SPECIES_ID, speciesOf } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';
import { dominantDrive, drink, feed, stepDrives } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/drives.js';
import { DEATH_CAUSE, LIFE_STAGE, checkVitals, killCreature, oldAgeDeathChance, spawnCreature, updateLifeStage } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/lifecycle.js';
import { createEntities, NONE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/entities.js';
import { createEventLog } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/events.js';
import { TICK_SECONDS, TRAITS, YEAR_SECONDS } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const rabbit = SPECIES[SPECIES_ID.RABBIT];
const spawn = (e, over = {}) => spawnCreature(e, { speciesId: SPECIES_ID.RABBIT, x: 10, z: 10, tick: 0, ...over });

describe('species table (SPEC §7.2)', () => {
  it('matches the specification for the four species', () => {
    const rows = [
      ['RABBIT', 6, 1, 3, 6, 20, [1, 3]],
      ['DEER', 12, 2, 4, 8, 30, [1, 2]],
      ['WOLF', 12, 2, 4.5, 9, 30, [2, 3]],
      ['HUMAN', 24, 4, 2, 4, 40, [1, 1]],
    ];
    for (const [name, maxAge, mature, walk, run, gestation, litter] of rows) {
      const s = SPECIES[SPECIES_ID[name]];
      expect(s.name.toUpperCase()).toBe(name);
      expect(s.maxAgeYears).toBe(maxAge);
      expect(s.matureYears).toBe(mature);
      expect(s.walkSpeed).toBe(walk);
      expect(s.runSpeed).toBe(run);
      expect(s.gestationSeconds).toBe(gestation);
      expect(s.litter).toEqual(litter);
      expect(s.id).toBe(SPECIES_ID[name]);
    }
    expect(SPECIES[SPECIES_ID.RABBIT].eats.grass).toBe(true);
    expect(SPECIES[SPECIES_ID.WOLF].eats.rabbit).toBe(true);
    expect(SPECIES[SPECIES_ID.WOLF].eats.grass).toBeFalsy();
    expect(SPECIES[SPECIES_ID.HUMAN].eats.berries && SPECIES[SPECIES_ID.HUMAN].eats.deer).toBe(true);
    expect(SPECIES[SPECIES_ID.DEER].eats.rabbit).toBeFalsy();
    expect(speciesOf(SPECIES_ID.HUMAN)).toBe(SPECIES[3]);
  });
});

describe('drives', () => {
  it('starves in about 75 s and dehydrates at the species thirst rate from empty (SPEC §7.3)', () => {
    const dehydrateSeconds = 1 / rabbit.thirstRate;
    const e = createEntities(4);
    const i = spawn(e);
    e.hunger[i] = 0; e.thirst[i] = 0;
    let t = 0; let hungerFull = null; let thirstFull = null;
    while ((hungerFull === null || thirstFull === null) && t < 300) {
      stepDrives(e, i, rabbit, TICK_SECONDS); t += TICK_SECONDS;
      if (hungerFull === null && e.hunger[i] >= 1) hungerFull = t;
      if (thirstFull === null && e.thirst[i] >= 1) thirstFull = t;
    }
    expect(hungerFull).toBeGreaterThan(72); expect(hungerFull).toBeLessThan(78);
    expect(thirstFull).toBeGreaterThan(dehydrateSeconds - 2); expect(thirstFull).toBeLessThan(dehydrateSeconds + 2);
  });

  it('drains health above 0.9 hunger or thirst and kills within a bounded time', () => {
    const e = createEntities(4);
    const i = spawn(e);
    e.hunger[i] = 0.95; e.thirst[i] = 0;
    let t = 0;
    while (e.health[i] > 0 && t < 120) { stepDrives(e, i, rabbit, TICK_SECONDS); t += TICK_SECONDS; }
    expect(e.health[i]).toBeLessThanOrEqual(0);
    expect(t).toBeGreaterThan(5); expect(t).toBeLessThan(40);
    expect(checkVitals(e, i)).toBe(DEATH_CAUSE.STARVATION);
    const j = spawn(e);
    e.hunger[j] = 0.2; e.thirst[j] = 0.99; e.health[j] = 0;
    expect(checkVitals(e, j)).toBe(DEATH_CAUSE.DEHYDRATION);
    const k = spawn(e);
    e.health[k] = 0.5;
    expect(checkVitals(e, k)).toBe(null);
  });

  it('feeding and drinking clamp, and a fed creature regenerates health', () => {
    const e = createEntities(2);
    const i = spawn(e);
    e.hunger[i] = 0.8; e.thirst[i] = 0.7; e.health[i] = 0.4;
    feed(e, i, 0.5); drink(e, i, 2);
    expect(e.hunger[i]).toBeCloseTo(0.3, 5);
    expect(e.thirst[i]).toBe(0);
    for (let s = 0; s < 20 / TICK_SECONDS; s++) stepDrives(e, i, rabbit, TICK_SECONDS);
    expect(e.health[i]).toBeGreaterThan(0.4);
    expect(e.health[i]).toBeLessThanOrEqual(1);
    feed(e, i, 5);
    expect(e.hunger[i]).toBe(0);
  });

  it('ages in years and reports the dominant drive', () => {
    const e = createEntities(2);
    const i = spawn(e);
    for (let s = 0; s < YEAR_SECONDS / TICK_SECONDS; s++) stepDrives(e, i, rabbit, TICK_SECONDS);
    expect(e.age[i]).toBeCloseTo(1, 3);
    e.hunger[i] = 0.7; e.thirst[i] = 0.2;
    expect(dominantDrive(e, i)).toBe('hunger');
    e.thirst[i] = 0.9;
    expect(dominantDrive(e, i)).toBe('thirst');
    e.hunger[i] = 0.1; e.thirst[i] = 0.1;
    expect(dominantDrive(e, i)).toBe('content');
  });
});

describe('lifecycle', () => {
  it('spawns with sane defaults, given traits and parents', () => {
    const e = createEntities(4);
    const traits = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const m = spawn(e, { name: 'Fern', sex: 0 });
    const i = spawn(e, { name: 'Clover', traits, mother: m, father: NONE, tick: 400, age: 0 });
    expect(e.alive[i]).toBe(1);
    expect(e.health[i]).toBe(1);
    expect(e.hunger[i]).toBeGreaterThan(0); expect(e.hunger[i]).toBeLessThan(0.6);
    expect(e.names[i]).toBe('Clover');
    expect(e.mother[i]).toBe(m); expect(e.father[i]).toBe(NONE);
    expect(e.birthTick[i]).toBe(400);
    expect(Array.from(e.traits.subarray(i * TRAITS.length, (i + 1) * TRAITS.length))).toEqual(Array.from(traits));
    expect(e.lifeStage[i]).toBe(LIFE_STAGE.JUVENILE);
    expect(e.scale[i]).toBeLessThan(1);
    expect(e.y[i]).toBe(0);
    expect(spawnCreature(createEntities(0), { speciesId: 0, x: 0, z: 0, tick: 0 })).toBe(-1);
  });

  it('moves through juvenile → adult → elder and scales up', () => {
    const e = createEntities(2);
    const i = spawn(e, { age: 0 });
    updateLifeStage(e, i, rabbit);
    expect(e.lifeStage[i]).toBe(LIFE_STAGE.JUVENILE);
    const juvScale = e.scale[i];
    e.age[i] = rabbit.matureYears;
    updateLifeStage(e, i, rabbit);
    expect(e.lifeStage[i]).toBe(LIFE_STAGE.ADULT);
    expect(e.scale[i]).toBeGreaterThan(juvScale);
    expect(e.scale[i]).toBe(1);
    e.age[i] = rabbit.maxAgeYears * 0.86;
    updateLifeStage(e, i, rabbit);
    expect(e.lifeStage[i]).toBe(LIFE_STAGE.ELDER);
  });

  it('old-age death is impossible before 85 % of max age and certain by 115 %', () => {
    const e = createEntities(2);
    const i = spawn(e);
    e.age[i] = rabbit.maxAgeYears * 0.84;
    expect(oldAgeDeathChance(e, i, rabbit, 1)).toBe(0);
    e.age[i] = rabbit.maxAgeYears * 0.9;
    const p = oldAgeDeathChance(e, i, rabbit, 1);
    expect(p).toBeGreaterThan(0); expect(p).toBeLessThan(1);
    e.age[i] = rabbit.maxAgeYears * 1.15;
    expect(oldAgeDeathChance(e, i, rabbit, 1)).toBe(1);
  });

  it('killCreature frees the slot and logs the cause with the name', () => {
    const e = createEntities(2);
    const log = createEventLog(10);
    const i = spawn(e, { name: 'Ember', speciesId: SPECIES_ID.WOLF });
    const h = e.handle(i);
    killCreature(e, i, DEATH_CAUSE.LIGHTNING, log, 123);
    expect(e.alive[i]).toBe(0);
    expect(e.resolve(h)).toBe(NONE);
    const ev = log.all()[0];
    expect(ev.kind).toBe('death');
    expect(ev.tick).toBe(123);
    expect(ev.text).toMatch(/Ember/);
    expect(ev.text).toMatch(/lightning/i);
    expect(ev.species).toBe(SPECIES_ID.WOLF);
    expect(ev.cause).toBe(DEATH_CAUSE.LIGHTNING);
    expect(Object.keys(DEATH_CAUSE)).toEqual(expect.arrayContaining(['STARVATION', 'DEHYDRATION', 'OLD_AGE', 'PREDATION', 'FIRE', 'LIGHTNING', 'ROCKFALL', 'ERUPTION', 'DROWNING']));
  });
});
