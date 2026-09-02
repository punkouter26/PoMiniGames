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
import { TREE_STATE, chopTree, createTrees, stepTrees } from './flora/trees.js';
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

const THREATS = [[SPECIES_ID.WOLF, SPECIES_ID.HUMAN], [SPECIES_ID.WOLF, SPECIES_ID.HUMAN], [], [SPECIES_ID.WOLF]];
const PREY = [[], [], [SPECIES_ID.RABBIT, SPECIES_ID.DEER], [SPECIES_ID.RABBIT, SPECIES_ID.DEER]];
const GESTATION_TICKS = SPECIES.map(sp => Math.round(sp.gestationSeconds / TICK_SECONDS));

/** Physics stand-in with the full surface; the real one (T10) has the same shape. */
export function nullPhysics() {
  return {
    kind: 'null',
    onDeath() {}, fellTree() {}, spawnRocks() {}, explode() {},
    step() {}, readProps() { return 0; }, dispose() {},
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
  const shoreField = bfsDistanceField(terrain, shoreTiles(terrain), i => isWalkable(terrain.type[i]));
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
    place(SPECIES_ID.WOLF, POPULATION.wolves, wildTiles.length ? wildTiles : grassTiles);
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

    const threats = THREATS[sp.id]; const prey = PREY[sp.id];
    const juvenile = e.lifeStage[i] === LIFE_STAGE.JUVENILE;
    const mother = juvenile ? e.resolve(e.mother[i]) : NONE;
    const father = juvenile ? e.resolve(e.father[i]) : NONE;
    spatial.forEachInRadius(x, z, sp.perception, (j, d2) => {
      if (j === i) return;
      const d = Math.sqrt(d2);
      const sj = e.species[j];
      if (threats.includes(sj) && d < ctx.threatDist) { ctx.threatDist = d; ctx.threatX = e.x[j]; ctx.threatZ = e.z[j]; }
      if (prey.includes(sj) && d < ctx.preyDist) { ctx.preyDist = d; ctx.preyIdx = j; }
      if (sj === sp.id && e.sex[j] !== e.sex[i] && d < ctx.mateDist && !juvenile && canMate(e, i, j, tick)) { ctx.mateDist = d; ctx.mateIdx = j; }
      if ((j === mother || j === father) && d < ctx.parentDist) { ctx.parentDist = d; ctx.parentIdx = j; }
    });

    // Food: grass and ripe bushes in a square around the creature (herbivores + humans for berries).
    if (sp.eats.grass || sp.eats.berries) {
      const tx = tileX(t, size); const tz = tileZ(t, size); const r = WORLD.foodScanTiles;
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
            feed(e, i, carc.food);
            carcasses.splice(k, 1);
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
        if (d <= sp.radius + SPECIES[e.species[prey]].radius + WORLD.reachPadding) {
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
          if ((sp.id === SPECIES_ID.RABBIT || sp.id === SPECIES_ID.DEER) && !isAlerted(e, i, tick)) raiseAlarm(e, spatial, i, BEHAVIOR.herdRadius, tick);
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
          buildHut(e, i, settlement, terrain, tileState, streams.behavior, log, tick);
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
        if (isAlerted(e, i, tick) && c.threatDist === Infinity) c.threatDist = 15;
        chooseGoal(e, i, c);
        commitPlan(i, c);
      }
      act(i, e.goal[i], plans[i], dt);
      moveCreature(e, i, terrain, tileState, dt);
    }

    for (let k = carcasses.length - 1; k >= 0; k--) if (carcasses[k].expires <= tick) carcasses.splice(k, 1);
    phys.step(dt);

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
      default: return false;
    }
  }

  function applyCommand(cmd) {
    if (cmd.type === 'setSpeed') clock.setSpeed(cmd.speed);
  }

  return {
    seed, terrain, tileState, fear, grass, bushes, trees, settlement, entities: e, clock, log, bus, spatial, namer, streams,
    shoreField, carcasses, physics: phys, popHistory,
    step, stats, detail, debug, applyCommand, kill, spawn, memory: MEMORY,
  };
}
