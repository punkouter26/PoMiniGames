// traits.js — the five heritable personality traits, each in [0, 1].
import { TRAITS } from '../core/config.js';

export const TRAIT = Object.freeze({ BOLDNESS: 0, SOCIABILITY: 1, CURIOSITY: 2, GREED: 3, DILIGENCE: 4 });

export function randomTraits(rng) {
  const t = new Float32Array(TRAITS.length);
  for (let k = 0; k < TRAITS.length; k++) t[k] = rng.next();
  return t;
}

export const baseTrait = (e, i, k) => e.traits[i * TRAITS.length + k];

export function dominantTrait(e, i) {
  let best = 0;
  for (let k = 1; k < TRAITS.length; k++) if (baseTrait(e, i, k) > baseTrait(e, i, best)) best = k;
  return TRAITS[best];
}
