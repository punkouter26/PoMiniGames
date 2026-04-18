/**
 * PoMphConverter.ts — Rapier world-unit ↔ mph conversion utilities.
 *
 * Research D-002: Rapier uses SI units (1 world unit = 1 metre).
 * 1 mph ≈ 0.44704 m/s.
 * `impulseUnits` here refers to the magnitude of a Rapier impulse vector (kg·m/s)
 * applied to the ball RigidBody.  Because the ball mass is 1 kg in PoSeedService,
 * the impulse magnitude equals the velocity change in m/s immediately after release.
 *
 * Calibration constant PO_IMPULSE_TO_MPS is tuned so that:
 *   - Minimum detectable swipe (≈1 impulse unit) → ≈8 mph
 *   - Maximum swipe (≈13 impulse units)           → ≈28 mph
 * (Source: spec.md FR-008, research D-002)
 */

const PO_MPS_TO_MPH = 2.23694; // 1 m/s = 2.23694 mph

/**
 * Convert a raw Rapier impulse magnitude to mph display value.
 * The impulse magnitude is assumed to equal the post-release velocity in m/s
 * (ball mass = 1 kg; see PoSeedService.seedBalls).
 */
export function poToMph(impulseUnits: number): number {
  return impulseUnits * PO_MPS_TO_MPH;
}

/**
 * Convert mph back to Rapier impulse units (inverse of poToMph).
 * Useful for calibration and test assertions.
 */
export function poFromMph(mph: number): number {
  return mph / PO_MPS_TO_MPH;
}
