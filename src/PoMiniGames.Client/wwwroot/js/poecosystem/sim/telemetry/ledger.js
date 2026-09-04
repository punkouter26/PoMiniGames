// ledger.js — lifetime animal telemetry (the export an external AI reads to rebalance
// the island). One completed record per creature that has ever died: how long it lived,
// what killed it and who the killer was, how far it moved and how fast, how many offspring
// it left, its drives at death and its personality. Plus a species×species predation
// matrix and per-species rollups so the summary is consumable without touching the raw
// records.
//
// Pure bookkeeping: no RNG draws, no rule ever reads the ledger, so worlds stay
// bit-identical with it on or off. The world snapshot carries getState(), so telemetry
// survives Resume for free; the host exports it on demand (never autosaved separately).
import { TICK_SECONDS, YEAR_SECONDS, TRAITS } from '../core/config.js';
import { SPECIES } from '../creatures/species.js';

export const LEDGER_VERSION = 1;
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;

export function createLedger({ cap = 20000 } = {}) {
  const creatures = [];                                   // death records, oldest first
  const diet = SPECIES.map(() => SPECIES.map(() => 0));   // diet[predator][prey] = kills
  const lifespanSum = SPECIES.map(() => 0);               // raw sums behind the export means
  const distSum = SPECIES.map(() => 0);
  const speedSum = SPECIES.map(() => 0);
  const hungerSum = SPECIES.map(() => 0);
  const thirstSum = SPECIES.map(() => 0);
  const offspringSum = SPECIES.map(() => 0);
  const causes = SPECIES.map(() => ({}));
  const maxLifespan = SPECIES.map(() => 0);
  const diedCount = SPECIES.map(() => 0);
  let dropped = 0;

  function death(rec) {
    const s = rec.species;
    const age = Math.max(0, rec.ageYears);
    const speed = rec.distance / (Math.max(1, rec.diedTick - rec.bornTick) * TICK_SECONDS);
    // Records keep raw values: setState rebuilds the rollups from these on Resume, and
    // any rounding here would drift the re-derived means (e.g. avgLifespanYears, averages
    // of hunger/thirst) by ±0.01 once hundreds of deaths accumulate. Rounding is the
    // export layer's job — see exportCreature below.
    creatures.push({
      name: rec.name,
      species: SPECIES[s]?.name ?? String(s),
      sex: rec.sex === 1 ? 'female' : 'male',
      bornTick: rec.bornTick, diedTick: rec.diedTick,
      ageYears: age,
      lifeFraction: rec.maxAgeYears > 0 ? Math.min(1, age / rec.maxAgeYears) : null,
      cause: rec.cause,
      killer: rec.killer === null || rec.killer === undefined ? null : (SPECIES[rec.killer]?.name ?? String(rec.killer)),
      killerName: rec.killerName ?? null,
      offspring: rec.offspring | 0,
      distanceM: rec.distance,
      avgSpeed: speed,
      hungerAtDeath: rec.hunger,
      thirstAtDeath: rec.thirst,
      traits: Array.from(rec.traits),
    });
    if (creatures.length > cap) { creatures.shift(); dropped++; }
    fold(s, age, rec.distance, speed, rec.hunger, rec.thirst, rec.offspring | 0, rec.cause);
  }

  /** Fold one death into the rollups (used by death() and by setState's replay). */
  function fold(s, age, distance, speed, hunger, thirst, offspring, cause) {
    diedCount[s]++;
    lifespanSum[s] += age;
    distSum[s] += distance;
    speedSum[s] += speed;
    hungerSum[s] += hunger;
    thirstSum[s] += thirst;
    offspringSum[s] += offspring;
    if (age > maxLifespan[s]) maxLifespan[s] = age;
    causes[s][cause] = (causes[s][cause] ?? 0) + 1;
  }

  function kill(predator, prey) {
    if (diet[predator] && diet[predator][prey] !== undefined) diet[predator][prey]++;
  }

  const namedDiet = () => {
    const out = {};
    SPECIES.forEach((pred, k) => {
      const row = {};
      SPECIES.forEach((prey, j) => { if (diet[k][j] > 0) row[prey.name] = diet[k][j]; });
      if (Object.keys(row).length) out[pred.name] = row;
    });
    return out;
  };

  const mean = (sum, s) => (diedCount[s] === 0 ? 0 : r2(sum[s] / diedCount[s]));

  // Public view of a stored death record: round the float-bearing fields the way the
  // consumer-facing JSON has always shown them. Stored records stay raw so setState's
  // re-fold matches the original death() fold bit-for-bit.
  const exportCreature = (c) => ({
    ...c,
    ageYears: r2(c.ageYears),
    lifeFraction: c.lifeFraction === null ? null : r2(c.lifeFraction),
    distanceM: r1(c.distanceM),
    avgSpeed: r2(c.avgSpeed),
    hungerAtDeath: r2(c.hungerAtDeath),
    thirstAtDeath: r2(c.thirstAtDeath),
    traits: c.traits.map(r2),
  });

  return {
    get count() { return creatures.length; },
    get dropped() { return dropped; },
    death, kill,
    /** The full export: self-describing, units included, ready to hand to a model. */
    export({ seed, tick, year, alive } = {}) {
      const speciesSummary = {};
      SPECIES.forEach((sp, s) => {
        speciesSummary[sp.name] = {
          alive: alive?.[s] ?? null,
          died: diedCount[s],
          avgLifespanYears: mean(lifespanSum, s),
          maxLifespanYears: r2(maxLifespan[s]),
          avgOffspring: mean(offspringSum, s),
          avgDistanceM: diedCount[s] === 0 ? 0 : r1(distSum[s] / diedCount[s]),
          avgSpeed: mean(speedSum, s),
          avgHungerAtDeath: mean(hungerSum, s),
          avgThirstAtDeath: mean(thirstSum, s),
          causes: { ...causes[s] },
        };
      });
      return {
        schemaVersion: LEDGER_VERSION,
        generatedAt: new Date().toISOString(),
        world: { seed, tick, year },
        units: { tickSeconds: TICK_SECONDS, secondsPerYear: YEAR_SECONDS, distanceUnit: 'metres', speedUnit: 'metresPerSecond' },
        traitNames: [...TRAITS],
        species: SPECIES.map(sp => ({ id: sp.id, name: sp.name, maxAgeYears: sp.maxAgeYears })),
        summary: { species: speciesSummary, diet: namedDiet() },
        creatures: creatures.map(exportCreature),
        recordsDropped: dropped,
      };
    },
    getState() { return { creatures: creatures.slice(), diet: diet.map(r => r.slice()), dropped }; },
    setState(s) {
      creatures.length = 0;
      diet.forEach((r, k) => diet[k] = (Array.isArray(s?.diet) ? (s.diet[k] ?? []) : r).slice());
      dropped = s?.dropped ?? 0;
      // Rollups are rebuilt from the records so the export means stay exact after Resume.
      diedCount.fill(0); lifespanSum.fill(0); distSum.fill(0); speedSum.fill(0);
      hungerSum.fill(0); thirstSum.fill(0); offspringSum.fill(0); maxLifespan.fill(0);
      for (let k = 0; k < SPECIES.length; k++) causes[k] = {};
      for (const c of s?.creatures ?? []) {
        creatures.push(c);
        const k = SPECIES.findIndex(sp => sp.name === c.species);
        if (k < 0) continue;
        fold(k, c.ageYears, c.distanceM, c.avgSpeed, c.hungerAtDeath, c.thirstAtDeath, c.offspring, c.cause);
      }
    },
  };
}
