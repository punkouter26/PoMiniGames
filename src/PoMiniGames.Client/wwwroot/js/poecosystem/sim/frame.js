// frame.js — the render frame layout shared by the sim (encoder) and the main thread
// (decoder). One transferable ArrayBuffer per frame:
//   Int32[8] header · Int32[cap] handles · Float32[cap*13] creatures · Float32[propCap*8] props
// Creature stride: x, y, z, yaw, scale, speciesId, goal, lifeStage, then the five BASE traits
// (boldness, sociability, curiosity, greed, diligence). The traits ride the frame so the
// renderer can tint every creature by one of them (the evolution view) without a second
// channel; they are the base values, not the nudged ones, because inheritance is what the
// tint is meant to show.
// Prop stride:     x, y, z, qx, qy, qz, qw, propKind (kind*8 + sizeIndex).
import { NONE } from './core/entities.js';
import { TRAITS } from './core/config.js';

export const FRAME = Object.freeze({
  HEADER_INTS: 8,
  H_TICK: 0, H_COUNT: 1, H_PROPS: 2, H_FLAGS: 3, H_SELECTED: 4, H_SPEED: 5, H_YEAR: 6, H_DAY_MILLI: 7,
  FLAG_PAUSED: 1, FLAG_LLM_READY: 2,
  CREATURE_STRIDE: 13,
  PROP_STRIDE: 8,
  TRAIT_OFFSET: 8,
  bytes(cap, propCap) { return 8 * 4 + cap * 4 + cap * 13 * 4 + propCap * 8 * 4; },
});

export const createFrameBuffer = (cap, propCap) => new ArrayBuffer(FRAME.bytes(cap, propCap));

export function frameViews(buffer, cap, propCap) {
  let offset = 0;
  const header = new Int32Array(buffer, offset, FRAME.HEADER_INTS); offset += FRAME.HEADER_INTS * 4;
  const handles = new Int32Array(buffer, offset, cap); offset += cap * 4;
  const creatures = new Float32Array(buffer, offset, cap * FRAME.CREATURE_STRIDE); offset += cap * FRAME.CREATURE_STRIDE * 4;
  const props = new Float32Array(buffer, offset, propCap * FRAME.PROP_STRIDE);
  return { header, handles, creatures, props };
}

export function encodeFrame(world, buffer, { selected = NONE, flags = 0 } = {}) {
  const e = world.entities;
  const propCap = (buffer.byteLength - 8 * 4 - e.cap * 4 - e.cap * FRAME.CREATURE_STRIDE * 4) / (FRAME.PROP_STRIDE * 4);
  const v = frameViews(buffer, e.cap, propCap);
  let k = 0;
  for (let i = 0; i < e.high; i++) {
    if (!e.alive[i]) continue;
    v.handles[k] = e.handle(i);
    const o = k * FRAME.CREATURE_STRIDE;
    v.creatures[o] = e.x[i]; v.creatures[o + 1] = e.y[i]; v.creatures[o + 2] = e.z[i];
    v.creatures[o + 3] = e.yaw[i]; v.creatures[o + 4] = e.scale[i];
    v.creatures[o + 5] = e.species[i]; v.creatures[o + 6] = e.goal[i]; v.creatures[o + 7] = e.lifeStage[i];
    const t = i * TRAITS.length;
    for (let f = 0; f < TRAITS.length; f++) v.creatures[o + FRAME.TRAIT_OFFSET + f] = e.traits[t + f];
    k++;
  }
  const props = world.physics.readProps(v.props, propCap);
  const h = v.header;
  h[FRAME.H_TICK] = world.clock.tick; h[FRAME.H_COUNT] = k; h[FRAME.H_PROPS] = props;
  h[FRAME.H_FLAGS] = flags | (world.clock.speed === 0 ? FRAME.FLAG_PAUSED : 0);
  h[FRAME.H_SELECTED] = selected; h[FRAME.H_SPEED] = world.clock.speed;
  h[FRAME.H_YEAR] = world.clock.year(); h[FRAME.H_DAY_MILLI] = Math.round(world.clock.dayFraction() * 1000);
  return v;
}
