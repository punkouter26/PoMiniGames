import { describe, expect, it } from 'vitest';
import { createThoughtScheduler } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/thoughts/scheduler.js';
import { buildPrompt, SYSTEM_PROMPT } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/thoughts/prompt.js';
import { templateThought } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/thoughts/templates.js';
import { THOUGHT_SOURCE, applyThought, parseThought } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/thoughts/nudges.js';
import { createWorld } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js';
import { createEntities, NONE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/entities.js';
import { createRng } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/prng.js';
import { spawnCreature } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/lifecycle.js';
import { TRAIT, effectiveTrait } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/traits.js';
import { NUDGE, THOUGHTS, TRAITS } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

describe('thought scheduler', () => {
  it('round-robins every living creature before repeating and lets the selected one jump the queue', () => {
    const e = createEntities(16);
    const ids = [];
    for (let k = 0; k < 10; k++) ids.push(spawnCreature(e, { speciesId: k % 4, x: 0, z: 0, tick: 0 }));
    const s = createThoughtScheduler();
    const seen = new Set();
    for (let k = 0; k < 10; k++) { const h = s.next(e, NONE); expect(h).not.toBe(NONE); seen.add(e.resolve(h)); s.complete(h); }
    expect(seen.size).toBe(10);
    expect(e.resolve(s.next(e, NONE))).toBe(ids[0]);
    s.complete(e.handle(ids[0]));
    const sel = e.handle(ids[7]);
    expect(s.next(e, sel)).toBe(sel);      // preempts once
    s.complete(sel);
    expect(s.next(e, sel)).not.toBe(sel);  // then the rotation resumes
    s.complete(s.pending);
    e.free(ids[2]); e.free(ids[3]);
    for (let k = 0; k < 20; k++) { const h = s.next(e, NONE); expect(e.resolve(h)).not.toBe(NONE); expect([ids[2], ids[3]]).not.toContain(e.resolve(h)); s.complete(h); }
    const state = s.getState();
    const s2 = createThoughtScheduler(); s2.setState(state);
    expect(s2.next(e, NONE)).toBe(s.next(e, NONE));
    expect(s.pending).not.toBe(NONE);      // one in flight until complete()
    expect(createThoughtScheduler().next(createEntities(2), NONE)).toBe(NONE);
  });
});

describe('prompt', () => {
  it('describes the creature within 600 characters and asks for the JSON shape', () => {
    const w = createWorld({ seed: 4 });
    for (let k = 0; k < 40; k++) w.step();
    let longest = 0;
    w.entities.forEachAlive(i => {
      const p = buildPrompt(w, i);
      longest = Math.max(longest, p.length);
      expect(p.length).toBeLessThanOrEqual(THOUGHTS.maxPromptChars);
      expect(p).toContain(w.entities.names[i]);
      for (const t of TRAITS) expect(p.toLowerCase()).toContain(t);
    });
    expect(longest).toBeGreaterThan(200);
    expect(SYSTEM_PROMPT).toContain('"thought"');
    expect(SYSTEM_PROMPT).toContain('"trait"');
    expect(SYSTEM_PROMPT).toContain('"delta"');
  });
});

describe('templates', () => {
  it('produce a seeded, drive- and trait-flavoured line for every species', () => {
    const w = createWorld({ seed: 4 });
    const e = w.entities;
    const rngA = createRng(9); const rngB = createRng(9);
    const seenSpecies = new Set();
    e.forEachAlive(i => {
      const a = templateThought(w, i, rngA); const b = templateThought(w, i, rngB);
      expect(a.length).toBeGreaterThan(8);
      expect(a).toBe(b);
      seenSpecies.add(e.species[i]);
    });
    expect(seenSpecies.size).toBe(4);
    const i = 0;
    e.hunger[i] = 0.95; e.thirst[i] = 0.1;
    const hungry = templateThought(w, i, createRng(1));
    e.hunger[i] = 0.1; e.thirst[i] = 0.95;
    const thirsty = templateThought(w, i, createRng(1));
    expect(hungry).not.toBe(thirsty);
  });
});

describe('nudges', () => {
  it('parses strict or prose-wrapped JSON, rejects bad traits, clamps deltas', () => {
    expect(parseThought('{"thought":"I smell water.","trait":"curiosity","delta":0.1}')).toEqual({ thought: 'I smell water.', trait: 'curiosity', delta: 0.1 });
    expect(parseThought('Sure! Here you go: {"thought": "Run.", "trait": "boldness", "delta": -0.9} ok')).toEqual({ thought: 'Run.', trait: 'boldness', delta: -NUDGE.maxDelta });
    expect(parseThought('{"thought":"x","trait":"luck","delta":0.1}')).toBe(null);
    expect(parseThought('{"thought":"x","trait":"greed","delta":"lots"}')).toBe(null);
    expect(parseThought('not json at all')).toBe(null);
    expect(parseThought('')).toBe(null);
    const long = parseThought(`{"thought":"${'a'.repeat(300)}","trait":"greed","delta":0}`);
    expect(long.thought.length).toBe(THOUGHTS.maxThoughtChars);
    expect(parseThought('{"thought":"","trait":"greed","delta":0.1}')).toBe(null);
  });

  it('applies a valid thought as a bounded nudge and falls back to a template otherwise', () => {
    const w = createWorld({ seed: 4 });
    const e = w.entities;
    const i = 3; const h = e.handle(i); const tick = w.clock.tick;
    const before = effectiveTrait(e, i, TRAIT.GREED, tick);
    const ok = applyThought(w, h, '{"thought":"More berries for me.","trait":"greed","delta":0.6}', THOUGHT_SOURCE.LLM);
    expect(ok.applied).toBe(true);
    expect(e.lastThought[i]).toBe('More berries for me.');
    expect(e.lastThoughtSource[i]).toBe(THOUGHT_SOURCE.LLM);
    expect(effectiveTrait(e, i, TRAIT.GREED, tick) - before).toBeCloseTo(Math.min(NUDGE.maxDelta, 1 - before), 5);
    const d = w.detail(h);
    expect(d.nudge).toEqual({ trait: 'greed', delta: expect.any(Number) });
    expect(Math.abs(d.nudge.delta)).toBeLessThanOrEqual(NUDGE.maxDelta);
    const bad = applyThought(w, h, 'garbage', THOUGHT_SOURCE.LLM);
    expect(bad.applied).toBe(false);
    expect(e.lastThoughtSource[i]).toBe(THOUGHT_SOURCE.TEMPLATE);
    expect(e.lastThought[i].length).toBeGreaterThan(0);
    expect(e.nudgeTrait[i]).toBe(TRAIT.GREED);   // the earlier nudge survives a rejected one
    expect(applyThought(w, NONE, '{}', THOUGHT_SOURCE.LLM).applied).toBe(false);
  });
});

describe('world thought loop', () => {
  it('hands out prompts, accepts results, counts outcomes, and templates on its own cadence', () => {
    const w = createWorld({ seed: 4 });
    for (let k = 0; k < THOUGHTS.templateEveryTicks * 3 + 1; k++) w.step();
    let templated = 0;
    w.entities.forEachAlive(i => { if (w.entities.lastThoughtSource[i] === THOUGHT_SOURCE.TEMPLATE) templated++; });
    expect(templated).toBeGreaterThanOrEqual(3);
    const req = w.thoughts.next(NONE);
    expect(req).not.toBe(null);
    expect(req.prompt.length).toBeGreaterThan(50);
    expect(w.thoughts.next(NONE)).toBe(null);           // one in flight
    const res = w.thoughts.apply(req.handle, '{"thought":"The pack is near.","trait":"sociability","delta":0.2}');
    expect(res.applied).toBe(true);
    expect(w.thoughts.next(NONE)).not.toBe(null);
    const s = w.thoughts.stats();
    expect(s.requested).toBe(2); expect(s.applied).toBe(1); expect(s.rejected).toBe(0);
    w.thoughts.apply(w.thoughts.pending, 'nope');
    expect(w.thoughts.stats().rejected).toBe(1);
    const sel = w.entities.handle(5);
    const r2 = w.thoughts.next(sel);
    expect(r2.handle).toBe(sel);
    w.thoughts.cancel();
    expect(w.thoughts.pending).toBe(NONE);
  });
});
