// world.js — composition root. Everything the host or a test touches goes through
// createWorld(): step() advances one fixed tick, stats()/detail() read, debug() pokes.
//
// Determinism contract (SPEC §13 criterion 4): every rule below reads only sim state
// and the seeded streams. `physics` is write-only — the world tells it about deaths,
// felled trees and rocks and reads back prop poses for the frame, never for a rule.
import { BEHAVIOR, CREATURE_CAP, FLORA, MEMORY, POPULATION, TICK_SECONDS, TRAITS, WORLD } from './core/config.js';
import { createClock } from './core/clock.js';
import { NONE, createEntities } from './core/entities.js';
import { createBus, createEventLog } from './core/events.js';
import { createStreams } from './core/prng.js';
import { createSpatialHash } from './core/spatial.js';
import { generateIsland } from './terrain/island.js';
import { bfsDistanceField, descendStep, shoreTiles } from './terrain/pathing.js';
import { TILE, TILE_STATE, isWalkable, tileIndex, tileX, tileZ } from './terrain/tiles.js';
import { createGrass, grazeAt, stepGrass } from './flora/grass.js';
import { createBushes, isRipe, stepBushes, stripBush } from './flora/bushes.js';
import { TREE_STATE, burnTree, chopTree, createTrees, stepTrees } from './flora/trees.js';
import { SPECIES, SPECIES_ID } from './creatures/species.js';
import { drink, feed, stepDrives } from './creatures/drives.js';
import { DEATH_CAUSE, LIFE_STAGE, checkVitals, killCreature, oldAgeDeathChance, spawnCreature, updateLifeStage } from './creatures/lifecycle.js';
import { TRAIT, activeNudge, effectiveTrait, randomTraits } from './creatures/traits.js';
import { canMate, chooseSex, inheritTraits, litterSize } from './creatures/genetics.js';
import { createNamer } from './creatures/names.js';
import { MEMORY_KIND, forget, recall, remember } from './behavior/memory.js';
import { fleeFrom, moveCreature, seekTo, stop, wander } from './behavior/steering.js';
import { GOAL, GOAL_NAMES, chooseGoal } from './behavior/utility.js';
import { herdCohesion, isAlerted, isOrphan, packLeader, raiseAlarm, scatterDirection, shareKill } from './behavior/social.js';
import { addHut, buildHut, chooseHutSite, giveLogs, isNight, nearestHut, needsHut } from './behavior/humans.js';
import { EVENT_KIND, createEventScheduler } from './events/scheduler.js';
import { pickStrikeTile, strikeLightning } from './events/lightning.js';
import { stepCorridors, triggerRockslide } from './events/rockslide.js';
import { stepFire } from './events/fire.js';
import { erupt, stepLava } from './events/volcano.js';
import { createThoughtScheduler } from './thoughts/scheduler.js';
import { buildPrompt } from './thoughts/prompt.js';
import { templateThought } from './thoughts/templates.js';
import { THOUGHT_SOURCE, applyThought } from './thoughts/nudges.js';
import { THOUGHTS } from './core/config.js';
import { isFlammable } from './terrain/tiles.js';
import { EVENTS } from './core/config.js';

const PREY = [[], [], [SPECIES_ID.RABBIT, SPECIES_ID.DEER], [SPECIES_ID.RABBIT, SPECIES_ID.DEER]];
const GESTATION_TICKS = SPECIES.map(sp => Math.round(sp.gestationSeconds / TICK_SECONDS));

/** Physics stand-in with the full surface; the real one (T10) has the same shape. */
export function nullPhysics() {
  return {
    kind: 'null',
    onDeath() {}, fellTree() {}, spawnRocks() {}, explode() {},
    step() {}, readProps() { return 0; }, dispose() {},
    snapshot() { return []; }, restore() {},
  };
}

export function createWorld({ seed = 1, caps = {}, physics = null } = {}) {
  const cap = caps.creatureCap ?? CREATURE_CAP;
  const streams = createStreams(seed);
  const terrain = generateIsland(seed);
  const { size } = terrain;
  const tileState = new Uint8Array(size * size);
  const fear = new Float32Array(size * size);
  const grass = createGrass(terrain);
  const bushes = createBushes(terrain, streams.terrain);
  const trees = createTrees(terrain, streams.terrain);
  const settlement = { ...{ huts: [], carried: new Uint8Array(cap) } };
  const e = createEntities(cap);
  const clock = createClock();
  const log = createEventLog(200);
  const bus = createBus();
  const spatial = createSpatialHash(size);
  const namer = createNamer(streams.names);
  // Distance-to-drinkable-water field. Passability includes the tile state, so a hut
  // (or later a boulder / lava) on a shore tile never becomes a route creatures can't
  // take; it is rebuilt whenever such a tile changes (rare: huts, rockslides, eruptions).
  const shore = shoreTiles(terrain);
  const passableTile = (i) => isWalkable(terrain.type[i]) && tileState[i] !== TILE_STATE.HUT && tileState[i] !== TILE_STATE.BOULDER && tileState[i] !== TILE_STATE.LAVA;
  let shoreField = bfsDistanceField(terrain, shore, passableTile);
  const rebuildShoreField = () => { shoreField = bfsDistanceField(terrain, shore, passableTile); };
  const phys = physics ?? nullPhysics();
  const carcasses = [];
  let nextCarcassId = 1;
  const popHistory = [];
  // Per-creature plan: what perceive()/chooseGoal() decided at the last rescore, held as
  // handles so a target that died in between resolves to NONE and forces a rescore.
  const plans = Array.from({ length: cap }, () => ({}));
  const dirty = new Uint8Array(cap);
  const PLAN_KEYS = ['foodDist', 'foodKind', 'foodTile', 'foodIdx', 'carcassDist', 'carcassId', 'threatDist', 'threatX', 'threatZ', 'parentDist', 'homeDist', 'treeIdx'];
  function commitPlan(i, c) {
    const p = plans[i];
    for (const k of PLAN_KEYS) p[k] = c[k];
    p.prey = c.preyIdx === NONE ? NONE : e.handle(c.preyIdx);
    p.mate = c.mateIdx === NONE ? NONE : e.handle(c.mateIdx);
    p.parent = c.parentIdx === NONE ? NONE : e.handle(c.parentIdx);
    dirty[i] = 0;
  }
  const carcassIndex = (id) => { for (let k = 0; k < carcasses.length; k++) if (carcasses[k].id === id) return k; return -1; };
  const counts = [0, 0, 0, 0];
  const extinct = [false, false, false, false];
  let lastFullTick = -1e9;
  let lastStanding = NONE;
  let silent = false;
  // Natural events: the scheduler, rockslide corridors in flight, boulders blocking tiles,
  // and burning / burnt tiles (T12's fire spread extends the same lists).
  const scheduler = createEventScheduler(streams.events);
  const corridors = [];
  const boulders = [];
  const fires = [];   // { tile, ticksLeft }
  const burnt = [];   // { tile, ticksLeft }
  const secsToTicks = (s) => Math.round(s / TICK_SECONDS);
  const naturalEvents = { lightning: 0, rockslide: 0, eruption: 0 };
  // Thoughts: the LLM round-robin (driven by the host) and the template cadence (ours).
  const thoughtScheduler = createThoughtScheduler();
  const thoughtStats = { requested: 0, applied: 0, rejected: 0 };
  let templateCursor = 0;

  const tileOf = (i) => tileIndex(e.x[i], e.z[i], size);
  const centre = (t) => [tileX(t, size) + 0.5, tileZ(t, size) + 0.5];
  const dist = (i, x, z) => Math.hypot(e.x[i] - x, e.z[i] - z);
  const nameOf = (i) => e.names[i] || `${SPECIES[e.species[i]].name} #${i}`;

  // ── population bookkeeping ───────────────────────────────────────────
  function recount() {
    counts.fill(0);
    e.forEachAlive(i => counts[e.species[i]]++);
  }

  function spawn(speciesId, x, z, { age = 0, traits = null, mother = NONE, father = NONE } = {}) {
    const i = spawnCreature(e, {
      speciesId, x, z, tick: clock.tick, age, mother, father,
      sex: chooseSex(streams.genetics),
      traits: traits ?? randomTraits(streams.genetics),
      name: namer.next(speciesId),
    });
    if (i < 0) return -1;
    e.y[i] = terrain.heightAt(x, z);
    e.yaw[i] = streams.genetics.range(0, Math.PI * 2);
    if (speciesId === SPECIES_ID.HUMAN) { const h = nearestHut(settlement, x, z); e.homeTile[i] = h ? h.tile : NONE; }
    counts[speciesId]++;
    dirty[i] = 1;
    return i;
  }

  /** Set a flammable tile burning (lightning, later lava and spread). */
  function ignite(tile, force = false) {
    if (!isFlammable(terrain.type[tile])) return false;
    const s = tileState[tile];
    if (s !== TILE_STATE.NORMAL && s !== TILE_STATE.STUMP && !(force && s === TILE_STATE.BURNT)) return false;
    tileState[tile] = TILE_STATE.FIRE;
    fires.push({ tile, ticksLeft: secsToTicks(EVENTS.fireSeconds) });
    const k = trees.byTile[tile];
    if (k >= 0 && trees.state[k] === TREE_STATE.STANDING) { burnTree(trees, k, tileState); tileState[tile] = TILE_STATE.FIRE; }
    return true;
  }

  function fireNaturalEvent(kind) {
    naturalEvents[kind] = (naturalEvents[kind] ?? 0) + 1;
    if (kind === EVENT_KIND.LIGHTNING) {
      const tile = pickStrikeTile(terrain, streams.events);
      if (tile >= 0) strikeLightning(world, tile, streams.events);
    } else if (kind === EVENT_KIND.ROCKSLIDE) {
      triggerRockslide(world, streams.events);
    } else if (kind === EVENT_KIND.ERUPTION && world.erupt) {
      world.erupt();
    }
  }

  function kill(i, cause, extra = '') {
    const sp = SPECIES[e.species[i]];
    carcasses.push({ id: nextCarcassId++, x: e.x[i], z: e.z[i], species: sp.id, food: sp.foodValue * WORLD.carcassFoodFraction, expires: clock.tick + Math.round(WORLD.carcassSeconds / TICK_SECONDS) });
    phys.onDeath({ x: e.x[i], y: e.y[i], z: e.z[i], yaw: e.yaw[i], species: sp.id, scale: e.scale[i], handle: e.handle(i) }, cause, streams.cosmetic);
    bus.emit('death', { index: i, handle: e.handle(i), species: sp.id, cause });
    killCreature(e, i, cause, log, clock.tick, extra);
    settlement.carried[i] = 0;
    counts[sp.id]--;
  }

  // ── initial world ────────────────────────────────────────────────────
  {
    for (let k = 0; k < POPULATION.huts; k++) {
      const site = chooseHutSite(settlement, terrain, tileState, streams.terrain);
      if (site !== NONE) addHut(settlement, terrain, tileState, site);
    }
    rebuildShoreField();
    const grassTiles = []; const wildTiles = [];
    for (let i = 0; i < terrain.type.length; i++) {
      if (terrain.type[i] === TILE.GRASS && tileState[i] === TILE_STATE.NORMAL) grassTiles.push(i);
      else if (terrain.type[i] === TILE.FOREST || terrain.type[i] === TILE.HILL) wildTiles.push(i);
    }
    const place = (speciesId, n, pool) => {
      const sp = SPECIES[speciesId];
      for (let k = 0; k < n; k++) {
        const t = pool[streams.terrain.int(pool.length)];
        const [x, z] = centre(t);
        spawn(speciesId, x + streams.terrain.range(-0.4, 0.4), z + streams.terrain.range(-0.4, 0.4), { age: streams.genetics.range(0, sp.maxAgeYears * POPULATION.initialAgeFraction) });
      }
    };
    place(SPECIES_ID.RABBIT, POPULATION.rabbits, grassTiles);
    place(SPECIES_ID.DEER, POPULATION.deer, grassTiles);
    // Wolves start as one pack: scattered singles never meet a mate on a 200 m island.
    const denPool = wildTiles.length ? wildTiles : grassTiles;
    const den = denPool[streams.terrain.int(denPool.length)];
    const pack = [];
    for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
      const x = tileX(den, size) + dx; const z = tileZ(den, size) + dz;
      if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
      const t = z * size + x;
      if (isWalkable(terrain.type[t]) && tileState[t] === TILE_STATE.NORMAL) pack.push(t);
    }
    place(SPECIES_ID.WOLF, POPULATION.wolves, pack.length ? pack : denPool);
    const village = [];
    if (settlement.huts.length) {
      const o = settlement.huts[0];
      for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
        const x = tileX(o.tile, size) + dx; const z = tileZ(o.tile, size) + dz;
        if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
        const t = z * size + x;
        if (isWalkable(terrain.type[t]) && tileState[t] === TILE_STATE.NORMAL) village.push(t);
      }
    }
    place(SPECIES_ID.HUMAN, POPULATION.humans, village.length ? village : grassTiles);
    recount();
    popHistory.push(counts.slice());
  }

  // ── perception ───────────────────────────────────────────────────────
  const ctx = {};
  function perceive(i) {
    const sp = SPECIES[e.species[i]];
    const x = e.x[i]; const z = e.z[i]; const tick = clock.tick;
    const t = tileOf(i);
    ctx.tick = tick;
    ctx.threatDist = Infinity; ctx.threatX = 0; ctx.threatZ = 0;
    ctx.preyDist = Infinity; ctx.preyIdx = NONE;
    ctx.mateDist = Infinity; ctx.mateIdx = NONE;
    ctx.parentDist = Infinity; ctx.parentIdx = NONE;
    ctx.foodDist = Infinity; ctx.foodKind = ''; ctx.foodTile = NONE; ctx.foodIdx = NONE;
    ctx.carcassDist = Infinity; ctx.carcassId = NONE;
    ctx.waterDist = Infinity; ctx.homeDist = Infinity; ctx.hasHome = false; ctx.needsHut = false; ctx.logsCarried = 0;
    ctx.treeDist = Infinity; ctx.treeIdx = NONE;
    ctx.night = isNight(clock.dayFraction());
    ctx.fear = fear[t];

    const flees = sp.flees; const prey = PREY[sp.id];
    const juvenile = e.lifeStage[i] === LIFE_STAGE.JUVENILE;
    const mother = juvenile ? e.resolve(e.mother[i]) : NONE;
    const father = juvenile ? e.resolve(e.father[i]) : NONE;
    spatial.forEachInRadius(x, z, sp.perception, (j, d2) => {
      if (j === i) return;
      const d = Math.sqrt(d2);
      const sj = e.species[j];
      const fleeAt = flees[sj];
      if (fleeAt !== undefined && d <= fleeAt && d < ctx.threatDist) { ctx.threatDist = d; ctx.threatX = e.x[j]; ctx.threatZ = e.z[j]; }
      if (prey.includes(sj) && d < ctx.preyDist) { ctx.preyDist = d; ctx.preyIdx = j; }
      if (sj === sp.id && e.sex[j] !== e.sex[i] && d < ctx.mateDist && !juvenile && canMate(e, i, j, tick)) { ctx.mateDist = d; ctx.mateIdx = j; }
      if ((j === mother || j === father) && d < ctx.parentDist) { ctx.parentDist = d; ctx.parentIdx = j; }
    });
    // Carnivores remember where they last saw prey, so a hungry wolf with nothing in
    // sight roams back toward the herds instead of random-walking the beach.
    if (ctx.preyIdx !== NONE) remember(e, i, MEMORY_KIND.FOOD, tileOf(ctx.preyIdx), tick);

    // Food: grass and ripe bushes in a square around the creature (herbivores + humans for berries).
    if (sp.eats.grass || sp.eats.berries) {
      const tx = tileX(t, size); const tz = tileZ(t, size); const r = sp.foodScanTiles || WORLD.foodScanTiles;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = tx + dx; const zz = tz + dz;
          if (xx < 0 || zz < 0 || xx >= size || zz >= size) continue;
          const tt = zz * size + xx;
          if (!isWalkable(terrain.type[tt]) || tileState[tt] === TILE_STATE.FIRE || tileState[tt] === TILE_STATE.LAVA) continue;
          const d = Math.hypot(dx, dz);
          if (sp.eats.grass && grass.biomass[tt] >= WORLD.foodBiomassMin && d < ctx.foodDist) { ctx.foodDist = d; ctx.foodKind = 'grass'; ctx.foodTile = tt; }
          if (sp.eats.berries) {
            const b = bushes.byTile[tt];
            if (b >= 0 && isRipe(bushes, b) && d < ctx.foodDist) { ctx.foodDist = d; ctx.foodKind = 'bush'; ctx.foodTile = tt; ctx.foodIdx = b; }
          }
        }
      }
      if (ctx.foodDist === Infinity) {
        const mem = recall(e, i, MEMORY_KIND.FOOD, tick);
        if (mem !== NONE) {
          if (sp.eats.grass && grass.biomass[mem] >= WORLD.foodBiomassMin) { const [cx, cz] = centre(mem); ctx.foodDist = dist(i, cx, cz); ctx.foodKind = 'grass'; ctx.foodTile = mem; }
          else forget(e, i, MEMORY_KIND.FOOD);
        }
      }
    }
    if (sp.eats.carcass) {
      for (let k = 0; k < carcasses.length; k++) {
        const c = carcasses[k];
        const d = dist(i, c.x, c.z);
        if (d <= sp.perception && d < ctx.carcassDist) { ctx.carcassDist = d; ctx.carcassId = c.id; }
      }
    }
    const wf = shoreField[t];
    if (wf >= 0) ctx.waterDist = wf;
    else {
      const mem = recall(e, i, MEMORY_KIND.WATER, tick);
      if (mem !== NONE) { const [cx, cz] = centre(mem); ctx.waterDist = dist(i, cx, cz); }
    }
    if (sp.id === SPECIES_ID.HUMAN) {
      const h = nearestHut(settlement, x, z);
      ctx.hasHome = !!h;
      if (h) ctx.homeDist = dist(i, h.x, h.z);
      ctx.needsHut = needsHut(settlement, counts[SPECIES_ID.HUMAN]);
      ctx.logsCarried = settlement.carried[i];
      if (ctx.needsHut && ctx.logsCarried < FLORA.logsPerTree) {
        const tx = tileX(t, size); const tz = tileZ(t, size); const r = WORLD.treeScanTiles;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          const xx = tx + dx; const zz = tz + dz;
          if (xx < 0 || zz < 0 || xx >= size || zz >= size) continue;
          const k = trees.byTile[zz * size + xx];
          if (k < 0 || trees.state[k] !== TREE_STATE.STANDING) continue;
          const d = Math.hypot(dx, dz);
          if (d < ctx.treeDist) { ctx.treeDist = d; ctx.treeIdx = k; }
        }
      }
    }
    return ctx;
  }

  // ── acting ───────────────────────────────────────────────────────────
  function act(i, goal, c, dt) {
    const sp = SPECIES[e.species[i]];
    const tick = clock.tick;
    switch (goal) {
      case GOAL.REST: stop(e, i); return;
      case GOAL.WANDER: {
        const carnivore = PREY[sp.id].length > 0;
        if (carnivore && e.hunger[i] > 0.4) {
          // Roam: head for the last place prey was seen, otherwise sweep in long straight
          // lines at full walking speed so the search actually covers ground.
          const mem = recall(e, i, MEMORY_KIND.FOOD, tick);
          if (mem !== NONE) {
            const [cx, cz] = centre(mem);
            if (dist(i, cx, cz) < 4) forget(e, i, MEMORY_KIND.FOOD);
            else { seekTo(e, i, cx, cz, sp.walkSpeed); return; }
          }
          e.yaw[i] += (streams.behavior.next() - 0.5) * 0.15;
          e.vx[i] = Math.sin(e.yaw[i]) * sp.walkSpeed; e.vz[i] = Math.cos(e.yaw[i]) * sp.walkSpeed;
          return;
        }
        wander(e, i, streams.behavior, sp.walkSpeed * 0.6);
        const social = effectiveTrait(e, i, TRAIT.SOCIABILITY, tick);
        if (social > 0.3) {
          const h = herdCohesion(e, spatial, i, BEHAVIOR.herdRadius);
          if (h.n > 0) {
            const d = dist(i, h.cx, h.cz);
            if (d > 5) {
              const w = social * 0.6;
              e.vx[i] = e.vx[i] * (1 - w) + (h.cx - e.x[i]) / d * sp.walkSpeed * 0.6 * w;
              e.vz[i] = e.vz[i] * (1 - w) + (h.cz - e.z[i]) / d * sp.walkSpeed * 0.6 * w;
            }
          }
        }
        return;
      }
      case GOAL.EAT: {
        const carnivoreFood = sp.eats.carcass && c.carcassId !== NONE && c.carcassDist <= c.foodDist;
        if (carnivoreFood) {
          const k = carcassIndex(c.carcassId);
          if (k < 0) { dirty[i] = 1; stop(e, i); return; }
          const carc = carcasses[k];
          if (dist(i, carc.x, carc.z) <= WORLD.interactDistance) {
            const bite = Math.min(sp.mealValue, carc.food);
            feed(e, i, bite);
            carc.food -= bite;
            if (carc.food <= 0.05) carcasses.splice(k, 1);
            dirty[i] = 1;
            stop(e, i);
          } else seekTo(e, i, carc.x, carc.z, sp.walkSpeed);
          return;
        }
        if (c.foodKind === 'grass') {
          const t = tileOf(i);
          if (grass.biomass[t] >= WORLD.foodBiomassMin) {
            const eaten = grazeAt(grass, t, WORLD.grazeRate * dt);
            feed(e, i, eaten);
            remember(e, i, MEMORY_KIND.FOOD, t, tick);
            stop(e, i);
          } else if (t === c.foodTile || grass.biomass[c.foodTile] < WORLD.foodBiomassMin) { dirty[i] = 1; stop(e, i); }
          else { const [cx, cz] = centre(c.foodTile); seekTo(e, i, cx, cz, sp.walkSpeed); }
          return;
        }
        if (c.foodKind === 'bush') {
          const [cx, cz] = centre(c.foodTile);
          if (dist(i, cx, cz) <= WORLD.interactDistance) {
            feed(e, i, stripBush(bushes, c.foodIdx));
            remember(e, i, MEMORY_KIND.FOOD, c.foodTile, tick);
            dirty[i] = 1;
            stop(e, i);
          } else if (!isRipe(bushes, c.foodIdx)) { dirty[i] = 1; stop(e, i); }
          else seekTo(e, i, cx, cz, sp.walkSpeed);
          return;
        }
        dirty[i] = 1;
        stop(e, i);
        return;
      }
      case GOAL.DRINK: {
        const t = tileOf(i);
        if (shoreField[t] === 0) {
          drink(e, i, WORLD.drinkRate * dt);
          remember(e, i, MEMORY_KIND.WATER, t, tick);
          stop(e, i);
        } else if (shoreField[t] > 0) {
          const [cx, cz] = centre(descendStep(terrain, shoreField, t));
          seekTo(e, i, cx, cz, sp.walkSpeed);
        } else {
          const mem = recall(e, i, MEMORY_KIND.WATER, tick);
          if (mem !== NONE) { const [cx, cz] = centre(mem); seekTo(e, i, cx, cz, sp.walkSpeed); } else stop(e, i);
        }
        return;
      }
      case GOAL.HUNT: {
        let prey = e.resolve(c.prey);
        if (sp.id === SPECIES_ID.WOLF) {
          const leader = packLeader(e, spatial, i, BEHAVIOR.packRadius);
          if (leader !== i) { const lt = e.resolve(e.target[leader]); if (lt !== NONE && PREY[sp.id].includes(e.species[lt])) prey = lt; }
        }
        if (prey === NONE) { dirty[i] = 1; stop(e, i); return; }
        e.target[i] = e.handle(prey);
        const d = dist(i, e.x[prey], e.z[prey]);
        if (d <= sp.radius + SPECIES[e.species[prey]].radius + WORLD.reachPadding + sp.huntReach) {
          const food = SPECIES[e.species[prey]].foodValue;
          const preyName = nameOf(prey);
          kill(prey, DEATH_CAUSE.PREDATION, ` by ${nameOf(i)}`);
          if (sp.id === SPECIES_ID.WOLF) shareKill(e, spatial, i, BEHAVIOR.packRadius, food);
          else feed(e, i, Math.min(sp.mealValue, food));
          bus.emit('kill', { killer: i, preyName });
          e.target[i] = NONE;
          dirty[i] = 1;
          stop(e, i);
        } else seekTo(e, i, e.x[prey], e.z[prey], sp.runSpeed);
        return;
      }
      case GOAL.FLEE: {
        if (c.threatDist !== Infinity) {
          if (sp.id === SPECIES_ID.RABBIT) {
            const d = scatterDirection(e, i, c.threatX, c.threatZ, streams.behavior);
            e.vx[i] = d.x * sp.runSpeed; e.vz[i] = d.z * sp.runSpeed;
          } else fleeFrom(e, i, c.threatX, c.threatZ, sp.runSpeed);
          if ((sp.id === SPECIES_ID.RABBIT || sp.id === SPECIES_ID.DEER) && !isAlerted(e, i, tick)) raiseAlarm(e, spatial, i, BEHAVIOR.herdRadius, tick, c.threatX, c.threatZ);
        } else if (Math.hypot(e.vx[i], e.vz[i]) < 0.1) {
          wander(e, i, streams.behavior, sp.runSpeed);
        }
        return;
      }
      case GOAL.MATE: {
        const m = e.resolve(c.mate);
        if (m === NONE) { dirty[i] = 1; stop(e, i); return; }
        if (dist(i, e.x[m], e.z[m]) <= WORLD.interactDistance) {
          if (canMate(e, i, m, tick)) {
            e.lastMateTick[i] = tick; e.lastMateTick[m] = tick;
            const female = e.sex[i] === 1 ? i : m; const male = female === i ? m : i;
            e.gestationEndTick[female] = tick + GESTATION_TICKS[sp.id];
            e.pendingFather[female] = e.handle(male);
          }
          dirty[i] = 1;
          stop(e, i);
        } else seekTo(e, i, e.x[m], e.z[m], sp.walkSpeed);
        return;
      }
      case GOAL.FOLLOW_PARENT: {
        const p = e.resolve(c.parent);
        if (p === NONE) { dirty[i] = 1; stop(e, i); return; }
        if (dist(i, e.x[p], e.z[p]) <= 2.5) { stop(e, i); return; }
        seekTo(e, i, e.x[p], e.z[p], sp.walkSpeed);
        return;
      }
      case GOAL.RETURN_HOME: {
        const h = nearestHut(settlement, e.x[i], e.z[i]);
        if (!h || dist(i, h.x, h.z) <= WORLD.interactDistance) { stop(e, i); return; }
        seekTo(e, i, h.x, h.z, sp.walkSpeed);
        return;
      }
      case GOAL.CHOP: {
        const k = c.treeIdx;
        if (k === NONE || trees.state[k] !== TREE_STATE.STANDING) { dirty[i] = 1; stop(e, i); return; }
        const [cx, cz] = centre(trees.tile[k]);
        if (dist(i, cx, cz) <= WORLD.interactDistance) {
          stop(e, i);
          if (tick - e.goalSince[i] >= Math.round(WORLD.chopSeconds / TICK_SECONDS)) {
            if (chopTree(trees, k, tileState)) {
              giveLogs(settlement, i, FLORA.logsPerTree);
              phys.fellTree({ x: cx, y: terrain.heightAt(cx, cz), z: cz, dirX: cx - e.x[i], dirZ: cz - e.z[i] }, streams.cosmetic);
              log.push({ tick, kind: 'chop', text: `${nameOf(i)} felled a tree`, tile: trees.tile[k] });
            }
            e.goalSince[i] = tick;
          }
        } else seekTo(e, i, cx, cz, sp.walkSpeed);
        return;
      }
      case GOAL.BUILD: {
        const o = settlement.huts[0];
        if (!o) { stop(e, i); return; }
        if (dist(i, o.x, o.z) <= BEHAVIOR.hutSiteRadius) {
          stop(e, i);
          if (buildHut(e, i, settlement, terrain, tileState, streams.behavior, log, tick)) rebuildShoreField();
          dirty[i] = 1;
        } else seekTo(e, i, o.x, o.z, sp.walkSpeed);
        return;
      }
      default: stop(e, i);
    }
  }

  // ── births ───────────────────────────────────────────────────────────
  function giveBirth(mother) {
    const sp = SPECIES[e.species[mother]];
    const father = e.resolve(e.pendingFather[mother]);
    const n = litterSize(sp, streams.genetics);
    const motherHandle = e.handle(mother);
    const fatherHandle = father === NONE ? NONE : e.handle(father);
    const fatherName = father === NONE ? null : nameOf(father);
    for (let k = 0; k < n; k++) {
      if (e.count >= cap) {
        if (clock.tick - lastFullTick >= Math.round(WORLD.fullLogCooldownSeconds / TICK_SECONDS)) {
          lastFullTick = clock.tick;
          log.push({ tick: clock.tick, kind: 'full', text: 'The island is full — births are on hold' });
        }
        break;
      }
      const a = streams.genetics.range(0, Math.PI * 2);
      let x = e.x[mother] + Math.cos(a) * WORLD.birthOffset; let z = e.z[mother] + Math.sin(a) * WORLD.birthOffset;
      if (!isWalkable(terrain.type[tileIndex(x, z, size)])) { x = e.x[mother]; z = e.z[mother]; }
      const traits = inheritTraits(e, mother, father, streams.genetics);
      const i = spawn(sp.id, x, z, { traits, mother: motherHandle, father: fatherHandle });
      if (i < 0) break;
      log.push({ tick: clock.tick, kind: 'birth', species: sp.id, creature: e.handle(i), text: `${nameOf(i)} (${sp.name.toLowerCase()}) born to ${nameOf(mother)}${fatherName ? ' + ' + fatherName : ''}` });
      bus.emit('birth', { index: i, mother });
    }
    e.gestationEndTick[mother] = NONE;
    e.pendingFather[mother] = NONE;
  }

  // ── the tick ─────────────────────────────────────────────────────────
  function step() {
    clock.step();
    const dt = TICK_SECONDS; const tick = clock.tick;
    stepGrass(grass, terrain, tileState, dt);
    stepBushes(bushes, dt);
    stepTrees(trees, tileState, dt);
    spatial.rebuild(e);

    for (let i = 0; i < e.high; i++) {
      if (!e.alive[i]) continue;
      const sp = SPECIES[e.species[i]];
      stepDrives(e, i, sp, dt);
      if (isOrphan(e, i)) e.hunger[i] = Math.min(1, e.hunger[i] + sp.hungerRate * dt * (BEHAVIOR.orphanHungerMultiplier - 1));
      updateLifeStage(e, i, sp);
      if (tileState[tileOf(i)] === TILE_STATE.FIRE || tileState[tileOf(i)] === TILE_STATE.LAVA) e.health[i] -= 0.5 * dt;
      const vital = checkVitals(e, i);
      if (vital) { kill(i, tileState[tileOf(i)] === TILE_STATE.LAVA ? DEATH_CAUSE.ERUPTION : tileState[tileOf(i)] === TILE_STATE.FIRE ? DEATH_CAUSE.FIRE : vital); continue; }
      const oldAge = oldAgeDeathChance(e, i, sp, dt);
      if (oldAge > 0 && streams.behavior.next() < oldAge) { kill(i, DEATH_CAUSE.OLD_AGE); continue; }
      if (e.gestationEndTick[i] !== NONE && tick >= e.gestationEndTick[i]) giveBirth(i);

      if (dirty[i] || (tick + i) % BEHAVIOR.rescoreEveryTicks === 0) {
        const c = perceive(i);
        // Alerted but can't see the predator: run from where the alarm said it was, not
        // from the origin of the map (which is what an unset threatX/threatZ would mean).
        if (isAlerted(e, i, tick) && c.threatDist === Infinity) {
          c.threatX = e.alertX[i]; c.threatZ = e.alertZ[i];
          c.threatDist = Math.max(1, Math.hypot(e.x[i] - c.threatX, e.z[i] - c.threatZ));
        }
        chooseGoal(e, i, c);
        commitPlan(i, c);
      }
      act(i, e.goal[i], plans[i], dt);
      moveCreature(e, i, terrain, tileState, dt);
    }

    for (let k = carcasses.length - 1; k >= 0; k--) if (carcasses[k].expires <= tick) carcasses.splice(k, 1);

    // Natural events: scheduled strikes/slides, rolling rocks, fires, fading fear.
    const due = scheduler.poll(tick);
    if (due) fireNaturalEvent(due);
    if (stepCorridors(world)) rebuildShoreField();
    stepFire(world);
    if (stepLava(world)) rebuildShoreField();
    if (tick % 20 === 0) {
      const decay = EVENTS.fearDecayPerSecond;
      for (let t = 0; t < fear.length; t++) if (fear[t] > 0) fear[t] = fear[t] > decay ? fear[t] - decay : 0;
    }
    phys.step(dt);

    // A template thought lands on the next creature in turn every few seconds, so the
    // inspector always has something to show even with the model off.
    if (tick % THOUGHTS.templateEveryTicks === 0 && e.count > 0) {
      for (let n = 0; n < e.cap; n++) {
        const i = (templateCursor + n) % e.cap;
        if (!e.alive[i]) continue;
        templateCursor = (i + 1) % e.cap;
        if (e.lastThoughtSource[i] !== THOUGHT_SOURCE.LLM || tick - e.nudgeEndTick[i] > 0) {
          e.lastThought[i] = templateThought(world, i, streams.cosmetic);
          e.lastThoughtSource[i] = THOUGHT_SOURCE.TEMPLATE;
        }
        break;
      }
    }

    // Extinctions, last species standing, population history.
    let living = 0; let lastId = NONE;
    for (let s = 0; s < 4; s++) {
      if (counts[s] === 0) {
        if (!extinct[s]) { extinct[s] = true; log.push({ tick, kind: 'extinction', species: s, text: `${SPECIES[s].plural} are extinct` }); bus.emit('extinction', { species: s }); }
      } else { extinct[s] = false; living++; lastId = s; }
    }
    lastStanding = living === 1 ? lastId : NONE;
    silent = living === 0;
    if (tick % WORLD.popSampleTicks === 0) {
      popHistory.push(counts.slice());
      if (popHistory.length > WORLD.popHistoryMax) popHistory.shift();
    }
  }

  // ── reads ────────────────────────────────────────────────────────────
  function stats() {
    return {
      seed, terrainHash: terrain.hash, tick: clock.tick, speed: clock.speed,
      year: clock.year(), day: clock.day(), dayFraction: clock.dayFraction(),
      counts: counts.slice(), alive: e.count, huts: settlement.huts.length,
      extinct: extinct.slice(), lastStanding, silent, popHistory, carcasses: carcasses.length,
      naturalEvents: { ...naturalEvents },
    };
  }

  function detail(handle) {
    const i = e.resolve(handle);
    if (i === NONE) return null;
    const sp = SPECIES[e.species[i]]; const tick = clock.tick;
    const traits = []; const baseTraits = [];
    for (let k = 0; k < TRAITS.length; k++) { traits.push(effectiveTrait(e, i, k, tick)); baseTraits.push(e.traits[i * TRAITS.length + k]); }
    const nudgeTrait = e.nudgeTrait[i];
    const nudge = nudgeTrait >= 0 && activeNudge(e, i, nudgeTrait, tick) !== 0 ? { trait: TRAITS[nudgeTrait], delta: activeNudge(e, i, nudgeTrait, tick) } : null;
    const parentName = (h) => { const p = e.resolve(h); return p === NONE ? '' : nameOf(p); };
    return {
      handle, name: nameOf(i), species: sp.id, speciesName: sp.name, sex: e.sex[i],
      ageYears: e.age[i], lifeStage: e.lifeStage[i], hunger: e.hunger[i], thirst: e.thirst[i], health: e.health[i],
      traits, baseTraits, nudge, goal: GOAL_NAMES[e.goal[i]] ?? 'Idle', goalSince: e.goalSince[i],
      lastThought: e.lastThought[i], lastThoughtSource: e.lastThoughtSource[i],
      mother: parentName(e.mother[i]), father: parentName(e.father[i]), x: e.x[i], y: e.y[i], z: e.z[i],
    };
  }

  function debug(op, arg = {}) {
    switch (op) {
      case 'massKill': {
        const targets = [];
        e.forEachAlive(i => { if (arg.species === undefined || e.species[i] === arg.species) targets.push(i); });
        for (const i of targets) kill(i, DEATH_CAUSE.DEBUG);
        return targets.length;
      }
      case 'lightning': {
        const tile = arg.tile ?? pickStrikeTile(terrain, streams.events);
        if (tile < 0) return false;
        scheduler.markFired(EVENT_KIND.LIGHTNING, clock.tick);
        naturalEvents.lightning++;
        return strikeLightning(world, tile, streams.events);
      }
      case 'rockslide': {
        scheduler.markFired(EVENT_KIND.ROCKSLIDE, clock.tick);
        naturalEvents.rockslide++;
        return triggerRockslide(world, streams.events);
      }
      case 'erupt': {
        if (!world.erupt) return false;
        scheduler.markFired(EVENT_KIND.ERUPTION, clock.tick);
        naturalEvents.eruption++;
        return world.erupt();
      }
      default: return false;
    }
  }

  function applyCommand(cmd) {
    if (cmd.type === 'setSpeed') clock.setSpeed(cmd.speed);
  }

  // ── save / restore (persistence/snapshot.js wraps these) ─────────────
  const ENTITY_COLS = e.columns();
  function getState() {
    const cols = {};
    for (const c of ENTITY_COLS) cols[c] = e[c].slice();
    return {
      clock: clock.getState(), rng: streams.getState(), namer: namer.getState(), log: log.getState(),
      scheduler: scheduler.getState(), thoughtScheduler: thoughtScheduler.getState(), thoughtStats: { ...thoughtStats },
      templateCursor, nextCarcassId, lastFullTick, naturalEvents: { ...naturalEvents }, extinct: extinct.slice(),
      popHistory: popHistory.map(r => r.slice()),
      tileState: tileState.slice(), fear: fear.slice(),
      grass: { biomass: grass.biomass.slice(), cursor: grass.cursor },
      bushes: bushes.ripeness.slice(), trees: { state: trees.state.slice(), regrow: trees.regrow.slice() },
      settlement: { huts: settlement.huts.map(h => ({ ...h })), carried: settlement.carried.slice() },
      entities: { high: e.high, count: e.count, free: e.getFreeList(), cols, names: e.names.slice(), lastThought: e.lastThought.slice() },
      plans: plans.slice(0, e.high).map(p => ({ ...p })), dirty: dirty.slice(),
      carcasses: carcasses.map(c => ({ ...c })), corridors: corridors.map(r => ({ ...r, corridor: r.corridor.slice() })),
      boulders: boulders.map(b => ({ ...b })), fires: fires.map(f => ({ ...f })), burnt: burnt.map(b => ({ ...b })),
      lava: world.lava ? { front: world.lava.front.slice(), tiles: world.lava.tiles.slice(), endTick: world.lava.endTick, nextCreep: world.lava.nextCreep } : null,
    };
  }
  function setState(s) {
    clock.setState(s.clock); streams.setState(s.rng); namer.setState(s.namer); log.setState(s.log);
    scheduler.setState(s.scheduler); thoughtScheduler.setState(s.thoughtScheduler);
    Object.assign(thoughtStats, s.thoughtStats); templateCursor = s.templateCursor | 0; nextCarcassId = s.nextCarcassId | 0; lastFullTick = s.lastFullTick;
    Object.assign(naturalEvents, s.naturalEvents); for (let k = 0; k < 4; k++) extinct[k] = !!s.extinct[k];
    popHistory.length = 0; for (const r of s.popHistory) popHistory.push(r.slice());
    tileState.set(s.tileState); fear.set(s.fear);
    grass.biomass.set(s.grass.biomass); grass.cursor = s.grass.cursor | 0;
    bushes.ripeness.set(s.bushes); trees.state.set(s.trees.state); trees.regrow.set(s.trees.regrow);
    settlement.huts.length = 0; for (const h of s.settlement.huts) settlement.huts.push({ ...h });
    settlement.carried.set(s.settlement.carried);
    for (const c of ENTITY_COLS) e[c].set(s.entities.cols[c]);
    e.high = s.entities.high; e.count = s.entities.count; e.setFreeList(s.entities.free);
    for (let i = 0; i < e.cap; i++) { e.names[i] = s.entities.names[i] ?? ''; e.lastThought[i] = s.entities.lastThought[i] ?? ''; }
    for (let i = 0; i < e.cap; i++) { const p = plans[i]; for (const k of Object.keys(p)) delete p[k]; if (s.plans[i]) Object.assign(p, s.plans[i]); }
    dirty.set(s.dirty);
    carcasses.length = 0; for (const c of s.carcasses) carcasses.push({ ...c });
    corridors.length = 0; for (const r of s.corridors) corridors.push({ ...r, corridor: r.corridor.slice() });
    boulders.length = 0; for (const b of s.boulders) boulders.push({ ...b });
    fires.length = 0; for (const f of s.fires) fires.push({ ...f });
    burnt.length = 0; for (const b of s.burnt) burnt.push({ ...b });
    world.lava = s.lava ? { front: s.lava.front.slice(), tiles: s.lava.tiles.slice(), endTick: s.lava.endTick, nextCreep: s.lava.nextCreep } : null;
    recount();
    rebuildShoreField();
    spatial.rebuild(e);
  }

  const world = {
    seed, terrain, tileState, fear, grass, bushes, trees, settlement, entities: e, clock, log, bus, spatial, namer, streams,
    get shoreField() { return shoreField; }, carcasses, physics: phys, popHistory,
    scheduler, corridors, boulders, fires, burnt, ignite, rebuildShoreField, lava: null,
    erupt: () => erupt(world),
    senses: (i) => ({ ...perceive(i) }),
    thoughts: {
      get pending() { return thoughtScheduler.pending; },
      next(selected = NONE) {
        const h = thoughtScheduler.next(e, selected);
        if (h === NONE) return null;
        thoughtStats.requested++;
        return { handle: h, prompt: buildPrompt(world, e.resolve(h)) };
      },
      apply(handle, text) {
        const r = applyThought(world, handle, text, THOUGHT_SOURCE.LLM);
        thoughtScheduler.complete(handle);
        if (r.applied) thoughtStats.applied++; else thoughtStats.rejected++;
        return r;
      },
      cancel() { thoughtScheduler.cancel(); },
      /**
       * Give one creature a template thought now. The rotation takes minutes to reach
       * everyone, so the inspector would otherwise open on an empty quote for a creature
       * that has not had its turn. Never overwrites a live LLM thought.
       */
      template(handle) {
        const i = e.resolve(handle);
        if (i === NONE) return false;
        if (e.lastThoughtSource[i] === THOUGHT_SOURCE.LLM && e.nudgeEndTick[i] > clock.tick) return false;
        e.lastThought[i] = templateThought(world, i, streams.cosmetic);
        e.lastThoughtSource[i] = THOUGHT_SOURCE.TEMPLATE;
        return true;
      },
      stats() { return { ...thoughtStats }; },
      scheduler: thoughtScheduler,
    },
    step, stats, detail, debug, applyCommand, kill, spawn, memory: MEMORY, getState, setState,
  };
  return world;
}
