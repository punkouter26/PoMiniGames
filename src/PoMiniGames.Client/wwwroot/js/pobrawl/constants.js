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

// Frame-data table. cancelInto = minimum stateT to transition into each named
// state. { idle: 0 } means recovery auto-completes when stateT reaches the end.
// Damage tuned to 10/15 (was 40/60) so matches last ~4x longer — roughly
// 25-40 exchanges. The damage-derived FEEL scalars (stagger threshold,
// reaction power, audio power) are rescaled to match so hits still land hard.
// `reach` reflects the REAL polygon contact range now: the striker capsules
// ride the actual fist/shoe meshes (see hitboxes.js), so root-to-root hit
// distance ≈ limb extension + lunge. The old values assumed a half-meter of
// invisible forward reach.
// 2026-09-13 (user request: "punch for speed, kick when they want a powerful
// hit"). The punch is now HALF of what it was on both axes it competes on —
// half the damage and half the energy toll (`energyMul`, applied to
// ATTACK_ENERGY_COST at the swing) — so the two buttons stop being "the same
// trade at two speeds" and become an actual choice: the punch buys tempo and
// costs almost nothing to throw, the kick is the only way to take a real bite
// out of the bar. Damage per unit of energy is deliberately left about even
// between them; what differs is how much of the fight each swing commits to.
export const ATTACKS = {
  punch: { name: 'punch', windup: 0.06, active: 0.06, recover: 0.15, dmg: 3.75, reach: 1.2,
           energyMul: 0.5,
           cancelInto: { idle: 0.22, punch: 0.16, kick: 0.20, block: 0.24 } },
  kick:  { name: 'kick',  windup: 0.12, active: 0.12, recover: 0.30, dmg: 15, reach: 1.45,
           energyMul: 1.0,
           cancelInto: { idle: 0.42, punch: 0.34, kick: 0.36, block: 0.40 } },
};

// Fighters never leave their feet before the final blow — heavy hits get a
// hard stagger (extra knockback + lean) instead of a mid-fight knockdown.
// The KO ragdoll is the only way to the canvas.
export const HEAVY_HIT_DMG = 13; // threshold for the amplified stagger reaction (¼ of the old 50, matching the ¼ damage table)
