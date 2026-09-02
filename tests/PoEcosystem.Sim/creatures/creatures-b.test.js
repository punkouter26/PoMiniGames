import { describe, expect, it } from 'vitest';
import { TRAIT, dominantTrait, effectiveTrait, randomTraits, setNudge } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/traits.js';
import { canMate, chooseSex, inheritTraits, litterSize } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/genetics.js';
import { createNamer } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/names.js';
import { SPECIES, SPECIES_ID } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';
import { LIFE_STAGE, spawnCreature } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/lifecycle.js';
import { createEntities, NONE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/entities.js';
import { createRng } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/prng.js';
import { NUDGE, TICK_SECONDS, TRAITS, TRAIT_MUTATION_SIGMA } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const wolf = SPECIES[SPECIES_ID.WOLF];

describe('traits', () => {
  it('randomTraits is seeded and bounded; dominantTrait names the max', () => {
    const a = randomTraits(createRng(5)); const b = randomTraits(createRng(5));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(TRAITS.length);
    for (const v of a) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    const e = createEntities(2);
    const i = spawnCreature(e, { speciesId: 0, x: 0, z: 0, tick: 0, traits: new Float32Array([0.1, 0.9, 0.3, 0.2, 0.5]) });
    expect(dominantTrait(e, i)).toBe('sociability');
    expect(TRAIT.SOCIABILITY).toBe(1);
  });

  it('effectiveTrait applies a nudge that decays to zero and never leaves [0,1]', () => {
    const e = createEntities(2);
    const i = spawnCreature(e, { speciesId: 0, x: 0, z: 0, tick: 0, traits: new Float32Array([0.6, 0.5, 0.5, 0.5, 0.5]) });
    const ticksPerNudge = Math.round(NUDGE.decaySeconds / TICK_SECONDS);
    setNudge(e, i, TRAIT.BOLDNESS, 0.25, 100);
    expect(effectiveTrait(e, i, TRAIT.BOLDNESS, 100)).toBeCloseTo(0.85, 6);
    expect(effectiveTrait(e, i, TRAIT.BOLDNESS, 100 + ticksPerNudge / 2)).toBeCloseTo(0.6 + 0.125, 3);
    expect(effectiveTrait(e, i, TRAIT.BOLDNESS, 100 + ticksPerNudge)).toBeCloseTo(0.6, 6);
    expect(effectiveTrait(e, i, TRAIT.BOLDNESS, 100 + ticksPerNudge * 3)).toBeCloseTo(0.6, 6);
    expect(effectiveTrait(e, i, TRAIT.GREED, 100)).toBeCloseTo(0.5, 6);      // other traits untouched
    setNudge(e, i, TRAIT.GREED, -0.9, 200);                                    // over-range deltas are clamped
    expect(effectiveTrait(e, i, TRAIT.GREED, 200)).toBeCloseTo(0.5 - NUDGE.maxDelta, 6);
    expect(e.nudgeTrait[i]).toBe(TRAIT.GREED);                                 // newer nudge replaces older
    expect(effectiveTrait(e, i, TRAIT.BOLDNESS, 200)).toBeCloseTo(0.6, 6);
  });
});

describe('genetics', () => {
  it('offspring traits are the parents’ mean plus small noise, clamped', () => {
    const rng = createRng(11);
    const e = createEntities(4);
    const m = spawnCreature(e, { speciesId: 2, x: 0, z: 0, tick: 0, traits: new Float32Array([0.2, 1.0, 0.5, 0.0, 0.8]) });
    const f = spawnCreature(e, { speciesId: 2, x: 0, z: 0, tick: 0, traits: new Float32Array([0.8, 1.0, 0.5, 0.0, 0.2]) });
    const sums = new Float64Array(TRAITS.length); let n = 0; let spread = 0;
    for (let k = 0; k < 600; k++) {
      const t = inheritTraits(e, m, f, rng);
      for (let j = 0; j < TRAITS.length; j++) { expect(t[j]).toBeGreaterThanOrEqual(0); expect(t[j]).toBeLessThanOrEqual(1); sums[j] += t[j]; }
      spread += Math.abs(t[2] - 0.5);
      n++;
    }
    expect(sums[0] / n).toBeCloseTo(0.5, 1);
    expect(sums[4] / n).toBeCloseTo(0.5, 1);
    expect(sums[1] / n).toBeGreaterThan(0.93);   // clamped at 1 from above
    expect(sums[3] / n).toBeLessThan(0.07);      // clamped at 0 from below
    expect(spread / n).toBeGreaterThan(TRAIT_MUTATION_SIGMA * 0.5);
    expect(spread / n).toBeLessThan(TRAIT_MUTATION_SIGMA * 1.2);
    const solo = inheritTraits(e, m, NONE, rng);
    expect(Math.abs(solo[0] - 0.2)).toBeLessThan(0.4);
  });

  it('litter sizes and sex draws respect the species table', () => {
    const rng = createRng(3);
    const seen = new Set();
    for (let k = 0; k < 200; k++) {
      const s = litterSize(wolf, rng);
      expect(s).toBeGreaterThanOrEqual(wolf.litter[0]); expect(s).toBeLessThanOrEqual(wolf.litter[1]);
      seen.add(s);
    }
    expect(seen.size).toBe(wolf.litter[1] - wolf.litter[0] + 1);
    const sexes = new Set(Array.from({ length: 50 }, () => chooseSex(rng)));
    expect([...sexes].sort()).toEqual([0, 1]);
  });

  it('canMate enforces species, adulthood, sex, condition, gestation and cooldown', () => {
    const e = createEntities(8);
    const tick = 10_000;
    const mk = (over = {}) => spawnCreature(e, { speciesId: SPECIES_ID.WOLF, x: 0, z: 0, tick: 0, age: wolf.matureYears + 1, ...over });
    const a = mk({ sex: 0 }); const b = mk({ sex: 1 });
    expect(e.lifeStage[a]).toBe(LIFE_STAGE.ADULT);
    expect(canMate(e, a, b, tick)).toBe(true);
    expect(canMate(e, a, a, tick)).toBe(false);                               // same individual / same sex
    const c = mk({ sex: 1, speciesId: SPECIES_ID.DEER });
    expect(canMate(e, a, c, tick)).toBe(false);                               // species
    const juvenile = mk({ sex: 1, age: 0.5 });
    expect(canMate(e, a, juvenile, tick)).toBe(false);                        // adulthood
    const hungry = mk({ sex: 1 }); e.hunger[hungry] = 0.8;
    expect(canMate(e, a, hungry, tick)).toBe(false);                          // condition
    const pregnant = mk({ sex: 1 }); e.gestationEndTick[pregnant] = tick + 100;
    expect(canMate(e, a, pregnant, tick)).toBe(false);                        // gestation
    const recent = mk({ sex: 1 }); e.lastMateTick[recent] = tick - 10;
    expect(canMate(e, a, recent, tick)).toBe(false);                          // cooldown
    e.lastMateTick[recent] = tick - Math.round(wolf.mateCooldownSeconds / TICK_SECONDS) - 1;
    expect(canMate(e, a, recent, tick)).toBe(true);
  });
});

describe('names', () => {
  it('generates unique, seeded, species-flavoured names', () => {
    const n1 = createNamer(createRng(9)); const n2 = createNamer(createRng(9));
    const seen = new Set();
    for (let s = 0; s < 4; s++) {
      for (let k = 0; k < 1000; k++) {
        const name = n1.next(s);
        expect(name.length).toBeGreaterThan(1);
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
    expect(n2.next(0)).toBe([...seen][0]);
    const state = n1.getState();
    const n3 = createNamer(createRng(1)); n3.setState(state);
    expect(n3.next(2)).toBe(n1.next(2));
  });
});
