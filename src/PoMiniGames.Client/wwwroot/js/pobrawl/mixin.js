// mixin.js — prototype composition for BrawlGame.
//
// BrawlGame was a single 5,400-line class. Its behaviour splits cleanly along
// subsystem lines (personality/super, VFX, the KO sequence + camera), but those
// methods reach across ~40 fields of shared match state, so turning them into
// free functions would mean threading a `game` argument through several hundred
// call sites — a large diff with real risk for no behavioural gain.
//
// Instead each subsystem is written as an ordinary class whose prototype is mixed
// into BrawlGame's. Every method body is unchanged and every `this._foo()` call
// site still resolves exactly as before; only the file it lives in has moved.
//
// getOwnPropertyDescriptors rather than Object.assign: class methods are
// NON-enumerable, so Object.assign copies nothing at all from a class prototype.
// Copying descriptors also preserves that non-enumerability, so the mixed-in
// methods behave identically to BrawlGame's own under for-in and JSON walks.

/**
 * Copy every method from each source prototype onto `target`.
 * @param {object} target  usually SomeClass.prototype
 * @param {...object} sources  prototypes produced by the subsystem modules
 */
export function mixin(target, ...sources) {
  for (const src of sources) {
    const descriptors = Object.getOwnPropertyDescriptors(src);
    // Every class prototype carries its own `constructor`; copying it would
    // repoint BrawlGame.prototype.constructor at the subsystem shell.
    delete descriptors.constructor;
    Object.defineProperties(target, descriptors);
  }
}
