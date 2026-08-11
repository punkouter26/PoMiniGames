// constants.js — match constants shared by BrawlGame and its mixin modules.
//
// These lived in game.js as module-local consts. Once the subsystem modules were
// split out they needed the same values, and the only alternatives were to
// re-declare them (which is how two copies of a tuning number drift apart) or to
// import them back out of game.js (a cycle, since game.js imports the modules).

/** Fixed simulation step. The sim runs at a hard 60 Hz regardless of frame rate. */
export const SIM_DT = 1 / 60;

/** Full health. Region damage and the HUD bars are both expressed against this. */
export const MAX_HP = 100;
