// Physical scale for SandPlayground. The GPU rules remain dimensionless, but
// deriving them from one scale keeps a second, a grain, and a water column
// internally comparable.
export const SAND_PLAYGROUND_CALIBRATION = Object.freeze({
    cellMeters: 0.025,
    physicsHz: 180,
    maxCatchUpSteps: 8,
    gravityMetersPerSecond2: 9.81,
    waterDensityKgM3: 998,
    quartzDensityKgM3: 2650,
    dynamicViscosityPaS: 0.001,
    medianGrainMeters: 0.00055,
    dryReposeDegrees: 32,
    saturatedReposeDegrees: 27,
    criticalShields: 0.047,
});

// Fixed-rate stepping makes a dam break, avalanche or settling plume advance
// at the same rate on a 30 Hz display as on a 144 Hz one.  The accumulator is
// deliberately bounded: returning from a background tab must not run seconds
// of simulation in one render frame.
export function consumePhysicsSteps(accumulator, deltaMs, singleStep = false) {
    if (singleStep) return { steps: 1, accumulator: 0 };
    const c = SAND_PLAYGROUND_CALIBRATION;
    const boundedDelta = Math.min(Math.max(deltaMs, 0), 1000 / c.physicsHz * c.maxCatchUpSteps);
    accumulator += boundedDelta * c.physicsHz / 1000;
    const steps = Math.min(c.maxCatchUpSteps, Math.floor(accumulator));
    return { steps, accumulator: accumulator - steps };
}

// Reference curves used by diagnostics and tests.  Shader equivalents are
// kept beside their movement rules because GLSL modules cannot import JS.
export function capillaryCohesion(saturation) {
    const s = Math.min(1, Math.max(0, saturation));
    return Math.min(1, s * Math.pow(1 - s, 4) * 12.207);
}

export function effectiveStress(overburden, saturation, pressureHead) {
    const porePressure = Math.max(0, saturation) * Math.max(0, pressureHead);
    return Math.max(0, overburden - porePressure);
}

export function shieldsMobility(flowSpeed, saturation, packing, grainScale = 1) {
    const c = SAND_PLAYGROUND_CALIBRATION;
    const relativeDensity = c.quartzDensityKgM3 / c.waterDensityKgM3 - 1;
    const drive = flowSpeed * flowSpeed /
        Math.max(1e-6, relativeDensity * c.gravityMetersPerSecond2 * c.medianGrainMeters * grainScale);
    const resistance = c.criticalShields * (1 + Math.max(0, packing) * 1.8) +
        capillaryCohesion(saturation) * 0.08;
    return Math.max(0, drive - resistance);
}
