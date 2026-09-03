// nudges.js — the only door from an LLM into the simulation. Whatever the model says is
// parsed defensively, the trait must be one of the five, the delta is clamped to
// ±NUDGE.maxDelta, and the nudge decays over NUDGE.decaySeconds (traits.js). A bad answer
// costs nothing: the creature gets a template thought and keeps any earlier nudge.
import { NUDGE, THOUGHTS, TRAITS } from '../core/config.js';
import { NONE } from '../core/entities.js';
import { setNudge } from '../creatures/traits.js';
import { templateThought } from './templates.js';

export const THOUGHT_SOURCE = Object.freeze({ NONE: 0, TEMPLATE: 1, LLM: 2 });

/** Extract and validate {thought, trait, delta} from model text; null when unusable. */
export function parseThought(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let obj = null;
  for (let end = text.indexOf('}', start); end >= 0; end = text.indexOf('}', end + 1)) {
    try { obj = JSON.parse(text.slice(start, end + 1)); break; } catch { /* keep looking for a longer candidate */ }
  }
  if (!obj || typeof obj !== 'object') return null;
  const thought = typeof obj.thought === 'string' ? obj.thought.trim() : '';
  const trait = typeof obj.trait === 'string' ? obj.trait.trim().toLowerCase() : '';
  const delta = typeof obj.delta === 'number' ? obj.delta : Number(obj.delta);
  if (!thought || !TRAITS.includes(trait) || !Number.isFinite(delta)) return null;
  return {
    thought: thought.length > THOUGHTS.maxThoughtChars ? thought.slice(0, THOUGHTS.maxThoughtChars) : thought,
    trait,
    delta: Math.max(-NUDGE.maxDelta, Math.min(NUDGE.maxDelta, delta)),
  };
}

/**
 * Apply model text to a creature. Returns { applied, parsed }. `applied` is true only when
 * an LLM answer passed validation and its nudge was set.
 */
export function applyThought(world, handle, text, source) {
  const e = world.entities;
  const i = e.resolve(handle);
  if (i === NONE) return { applied: false, parsed: null };
  const parsed = source === THOUGHT_SOURCE.LLM ? parseThought(text) : null;
  if (parsed) {
    setNudge(e, i, TRAITS.indexOf(parsed.trait), parsed.delta, world.clock.tick);
    e.lastThought[i] = parsed.thought;
    e.lastThoughtSource[i] = THOUGHT_SOURCE.LLM;
    return { applied: true, parsed };
  }
  e.lastThought[i] = templateThought(world, i, world.streams.cosmetic);
  e.lastThoughtSource[i] = THOUGHT_SOURCE.TEMPLATE;
  return { applied: false, parsed: null };
}
