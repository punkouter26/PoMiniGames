// species.js — the four species (SPEC §7.2). Rates are per real second at 1× speed.
// Ages are in years (YEAR_SECONDS); speeds in metres per second on the 1 m tile grid.

export const SPECIES_ID = Object.freeze({ RABBIT: 0, DEER: 1, WOLF: 2, HUMAN: 3 });

const STARVE_SECONDS = 75;   // hunger 0 → 1
const DEHYDRATE_SECONDS = 50; // thirst 0 → 1

function species(o) {
  return Object.freeze({
    hungerRate: 1 / STARVE_SECONDS,
    thirstRate: 1 / DEHYDRATE_SECONDS,
    starveDamage: 0.05,        // health per second while hunger or thirst > 0.9 (death in ~20 s)
    regenRate: 0.01,           // health per second while both drives < 0.5
    oldAgeStart: 0.85,         // fraction of maxAge where old-age hazard begins
    juvenileScale: 0.55,
    ...o,
  });
}

export const SPECIES = Object.freeze([
  species({
    id: 0, name: 'Rabbit', plural: 'Rabbits',
    maxAgeYears: 6, matureYears: 1, walkSpeed: 3, runSpeed: 6,
    eats: Object.freeze({ grass: true, berries: true }),
    gestationSeconds: 20, litter: Object.freeze([2, 4]), mateCooldownSeconds: 25,
    radius: 0.25, mass: 2, perception: 12, mealValue: 0.35, foodValue: 0.5, sprintSeconds: 2,
  }),
  species({
    id: 1, name: 'Deer', plural: 'Deer',
    maxAgeYears: 12, matureYears: 2, walkSpeed: 4, runSpeed: 8,
    eats: Object.freeze({ grass: true, berries: true }),
    gestationSeconds: 30, litter: Object.freeze([1, 2]), mateCooldownSeconds: 40,
    radius: 0.6, mass: 60, perception: 18, mealValue: 0.3, foodValue: 1.0, sprintSeconds: 4,
  }),
  species({
    id: 2, name: 'Wolf', plural: 'Wolves',
    maxAgeYears: 12, matureYears: 2, walkSpeed: 4.5, runSpeed: 9,
    eats: Object.freeze({ rabbit: true, deer: true, carcass: true }),
    gestationSeconds: 30, litter: Object.freeze([2, 3]), mateCooldownSeconds: 45,
    radius: 0.5, mass: 40, perception: 25, mealValue: 0.6, foodValue: 0.8, sprintSeconds: 5,
  }),
  species({
    id: 3, name: 'Human', plural: 'Humans',
    maxAgeYears: 24, matureYears: 4, walkSpeed: 1.5, runSpeed: 3,
    eats: Object.freeze({ berries: true, rabbit: true, deer: true, carcass: true }),
    gestationSeconds: 40, litter: Object.freeze([1, 1]), mateCooldownSeconds: 60,
    radius: 0.4, mass: 70, perception: 22, mealValue: 0.5, foodValue: 0, sprintSeconds: 6,
  }),
]);

export const speciesOf = (id) => SPECIES[id];
export const SPECIES_COUNT = SPECIES.length;
