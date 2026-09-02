// genetics.js — inheritance and mating eligibility. Draws come from the `genetics`
// stream so births never perturb behaviour randomness.
import { TICK_SECONDS, TRAITS, TRAIT_MUTATION_SIGMA } from '../core/config.js';
import { NONE } from '../core/entities.js';
import { LIFE_STAGE } from './lifecycle.js';
import { SPECIES } from './species.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Offspring traits = mean of the parents (or the mother alone) + N(0, sigma), clamped. */
export function inheritTraits(e, mother, father, rng) {
  const out = new Float32Array(TRAITS.length);
  const mo = mother * TRAITS.length;
  const fo = father === NONE ? -1 : father * TRAITS.length;
  for (let k = 0; k < TRAITS.length; k++) {
    const base = fo < 0 ? e.traits[mo + k] : (e.traits[mo + k] + e.traits[fo + k]) * 0.5;
    out[k] = clamp01(base + rng.gaussian() * TRAIT_MUTATION_SIGMA);
  }
  return out;
}

export const chooseSex = (rng) => rng.int(2);

export function litterSize(species, rng) {
  const [lo, hi] = species.litter;
  return lo + rng.int(hi - lo + 1);
}

const fit = (e, i, tick, cooldownTicks) =>
  e.lifeStage[i] !== LIFE_STAGE.JUVENILE
  && e.hunger[i] < 0.7 && e.thirst[i] < 0.7 && e.health[i] > 0.5
  && e.gestationEndTick[i] <= tick
  && (e.lastMateTick[i] === NONE || tick - e.lastMateTick[i] >= cooldownTicks);

export function canMate(e, i, j, tick) {
  if (i === j || e.species[i] !== e.species[j] || e.sex[i] === e.sex[j]) return false;
  const cooldownTicks = Math.round(SPECIES[e.species[i]].mateCooldownSeconds / TICK_SECONDS);
  return fit(e, i, tick, cooldownTicks) && fit(e, j, tick, cooldownTicks);
}
