// WebGL 2.0 GLSL Shaders for Cellular Automata Physics Pipeline
// Sand Multi-Material Engine
//
// Cell packing (RGBA32F):
//   SAND : G = looseness (>1.5 fast free-fall, 1 loose grain -> 0 settled,
//              negative = overburden-compacted down to -0.5)
//          B = wetness 0..1, or -1 scorched / -2 vitrified  A = roof-span stress
//   WATER: G = flow momentum (-1 / 0 / +1)  A = hydrostatic head (pressure)
//          B = flag pack (exact small ints): +1 suspended sediment load,
//              +2 fell-last-pass (fast-fall). Written values: 0, 1, 2, 3.
//   LAVA : G = heat (1 molten -> 0 crusting); insulated cores never cool
//   FIRE : G = remaining fuel/lifetime (non-conserved combustion gas)
//   other: channels zero
//
// Donor/receiver pairing contract: every rule that moves matter is written twice —
// once from the vacating cell and once from the receiving cell — over the SAME
// neighbour reads and the same frame-parity direction, so a move is always a swap
// and total sand/water/lava/oil mass is conserved. Water's momentum-steered lateral
// flow additionally uses a left-donor-wins arbitration (lateralLeftDonorClaims) that
// BOTH the yielding donor and the receiver evaluate over identical samples.
// Editing one side of any pair without its mirror re-introduces duplication.
//
// FAST FALL is a three-cell pairing: matter that fell last pass (fell flag /
// g > 1.5) covers TWO cells of clear air per pass. The donor vacates exactly as
// for a 1-cell fall; the intermediate air cell passes it through (declines to
// receive because fastFallTargets holds for ITS below cell); the cell two down
// receives. fastFallTargets is the highest-priority claim on an air receiver
// and every other claim predicate declines when it holds.
//
// In-place TRANSFORMS (lava quenching to obsidian, lava crusting, oil combusting,
// sand melting, bed erosion into suspended sediment, sediment deposition,
// puddle infiltration) are exempt from pairing only because every MOVEMENT
// receiver that could take the transforming cell re-evaluates the same
// deterministic transform predicate (lavaSolidifies / oilIgnites / sandErodes /
// waterMutates) and declines — a cell never transforms and travels in the same
// pass. FIRE is deliberately non-conserved: flames spawn from burning
// neighbours and decay to air. INFILTRATION is the second deliberate ledger
// exception: a still surface puddle's water cell moves into the sand wetness
// field (waterSoaksIn) and is not individually recoverable. EROSION carries the
// sand ledger inside the water flag: pickup mints one water cell around the
// suspended grain, deposition surrenders it back, so sand + water are conserved
// across every complete erode->deposit cycle.
//
// Concrete is inert here: rigid-body motion, stress fracture, blast cratering
// and blast damage are resolved on the CPU (subsurface-engine.js) against
// readback snapshots.

export const vsQuadSource = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
    v_uv = (a_position + 1.0) * 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Realism tiers (compile-time `#define REALISM n`, see physicsSource below).
// The automaton is written as shared donor/receiver predicates so that both
// sides of every move evaluate identical code; the tier gates live INSIDE
// those predicates, so a disabled feature is disabled for donor and receiver
// alike and conservation holds at every level.
//
// Why tiers exist: GLSL has no real calls — every predicate is inlined at each
// use, and the water arbitration chain (viscFlow -> lateral -> diag -> rise ->
// mud -> slide -> fastFall) multiplies out to thousands of texture fetches.
// ANGLE's D3D11 backend (Windows: Qualcomm Adreno, some Intel) hangs ~100 s in
// the HLSL compiler on the full chain and then fails the link with an empty
// log, killing the context. Medium and Low prune the deepest guards so the
// same shader links in milliseconds there.
//
//   3 High   — everything: erosion/deposition/infiltration, hydrostatic rise,
//              mud creep, fast fall, viscous lava/oil creep, blast occlusion.
//   2 Medium — drops erosion, sediment, infiltration, pressure rise, mud creep
//              and fast fall (fast fall is inlined into every claim predicate
//              and alone pushes the D3D11 link past its 100 s watchdog).
//   1 Low    — Medium minus viscous creep and blast occlusion (lava/oil only
//              fall; concussion ignores line-of-sight).
// Water levelling (dispersion, hydrostatic push, jet fall) is common to all.
export const REALISM_LOW = 1;
export const REALISM_MEDIUM = 2;
export const REALISM_HIGH = 3;

const physicsBody = `precision highp float;

uniform sampler2D u_stateTexture;
uniform vec2 u_resolution;       // (800.0, 600.0)
uniform float u_time;
uniform int u_frame;
uniform int u_subStep;
uniform vec4 u_brush;            // (x, y, radius, materialId)
uniform vec4 u_shockwaves[4];    // (x, y, radius, intensity) per active blast
uniform int u_shockwaveCount;

in vec2 v_uv;
out vec4 fragColor;

#define MAT_AIR       0.0
#define MAT_SAND      1.0
#define MAT_CONCRETE  2.0
#define MAT_WATER     3.0
#define MAT_BEDROCK   4.0
#define MAT_DEBRIS    5.0
#define MAT_LAVA      6.0
#define MAT_OIL       7.0
#define MAT_FIRE      8.0
#define MAT_OBSIDIAN  9.0

#define SPAN_NONE     999.0

// Viscosity gates: probability per pass that a resting liquid creeps laterally.
#define LAVA_VISC     0.22
#define OIL_VISC      0.55

vec4 getCell(vec2 coord) {
    if (coord.x < 0.0 || coord.x >= u_resolution.x || coord.y < 0.0 || coord.y >= u_resolution.y) {
        return vec4(MAT_AIR, 0.0, 0.0, 0.0);
    }
    return texture(u_stateTexture, (coord + 0.5) / u_resolution);
}

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

bool isSolid(float m) {
    return m == MAT_SAND || m == MAT_CONCRETE || m == MAT_BEDROCK || m == MAT_DEBRIS || m == MAT_OBSIDIAN;
}

bool isLiquid(float m) {
    return m == MAT_WATER || m == MAT_LAVA || m == MAT_OIL;
}

// Granular movers share the sand movement rules; debris (red bomb-casing
// gravel) is cohesionless — always loose, never forms roofs.
bool isGranular(float m) {
    return m == MAT_SAND || m == MAT_DEBRIS;
}

// Water B flag pack accessors (values are exact small ints: 0, 1, 2, 3).
float sedBit(float b)  { return (b == 1.0 || b == 3.0) ? 1.0 : 0.0; }
float fellBit(float b) { return b >= 2.0 ? 1.0 : 0.0; }

// Critical unsupported roof span before shear failure. Confinement makes deeper
// soil hold longer spans; saturation (wetness) weakens cohesion toward mud.
float critSpan(float y, float wetness) {
    float depth = max(0.0, 315.0 - y);
    float dry = clamp(9.0 + depth * 0.045, 9.0, 23.0);
    if (wetness < -1.5) return dry * 2.5; // vitrified blast glass: fused solid
    return dry * (1.0 - 0.55 * clamp(wetness, 0.0, 1.0));
}

// A sand cell falls when loose (disturbed grains ignore cohesion) or when its
// accumulated unsupported span exceeds the (wetness-weakened) critical span.
bool sandFalls(vec4 cell, float y) {
    if (cell.r == MAT_DEBRIS) return true;
    return cell.g > 0.5 || cell.a > critSpan(y, cell.b);
}

// Lateral anchor stress contributed by a neighbour when this cell is a roof cell.
float sideSupport(vec4 side) {
    if (side.r == MAT_CONCRETE || side.r == MAT_BEDROCK || side.r == MAT_OBSIDIAN) return 0.0;
    if (side.r == MAT_SAND) return side.a;
    return SPAN_NONE;
}

// Water flow direction: stored momentum wins, else the global parity direction.
float dirOfWater(vec4 w, float P) {
    if (w.g > 0.5) return 1.0;
    if (w.g < -0.5) return -1.0;
    return P;
}

// Path occlusion for the blast concussion (crater excavation itself is CPU-side).
float blastOcclusion(vec2 from, vec2 to) {
    float dist = distance(from, to);
    if (dist < 2.0) return 0.0;
    vec2 dir = (to - from) / dist;
    float solidLen = 0.0;
#if REALISM >= 2
    for (float t = 2.0; t < 360.0; t += 2.0) {
        if (t >= dist - 1.0) break;
        if (isSolid(getCell(floor(from + dir * t)).r)) solidLen += 2.0;
        if (solidLen > 16.0) break;
    }
#endif
    return solidLen;
}

// Does the LAVA cell at pos freeze to obsidian this pass? Deterministic over
// neighbour reads so movement receivers can mirror it exactly. Motion wins:
// free-falling lava never crusts mid-air.
bool lavaSolidifies(vec2 pos, vec4 cell) {
    float dn = getCell(pos + vec2(0.0, -1.0)).r;
    if (dn == MAT_AIR || dn == MAT_FIRE) return false;
    vec4 up = getCell(pos + vec2(0.0, 1.0));
    vec4 lf = getCell(pos + vec2(-1.0, 0.0));
    vec4 rt = getCell(pos + vec2(1.0, 0.0));
    if (up.r == MAT_WATER || dn == MAT_WATER || lf.r == MAT_WATER || rt.r == MAT_WATER) return true;
    bool exposed = up.r == MAT_AIR || lf.r == MAT_AIR || rt.r == MAT_AIR;
    return exposed && cell.g <= 0.001;
}

// Does the OIL cell at pos combust this pass? (fire or lava in contact)
bool oilIgnites(vec2 pos) {
    float up = getCell(pos + vec2(0.0, 1.0)).r;
    float dn = getCell(pos + vec2(0.0, -1.0)).r;
    float lf = getCell(pos + vec2(-1.0, 0.0)).r;
    float rt = getCell(pos + vec2(1.0, 0.0)).r;
    return up == MAT_FIRE || dn == MAT_FIRE || lf == MAT_FIRE || rt == MAT_FIRE ||
           up == MAT_LAVA || dn == MAT_LAVA || lf == MAT_LAVA || rt == MAT_LAVA;
}

// FAST FALL: does the air cell rPos receive the matter TWO cells above it this
// pass? True when rPos and the cell above it are both clear air and the cell
// two up is water or granular matter carrying the fell-last-pass mark. The
// intermediate air cell evaluates this for ITS below cell and passes the
// matter through; every other claim predicate declines when this one holds,
// making it the highest-priority claim on an air receiver.
bool fastFallTargets(vec2 rPos) {
#if REALISM >= 3
    if (getCell(rPos).r != MAT_AIR) return false;
    if (getCell(rPos + vec2(0.0, 1.0)).r != MAT_AIR) return false;
    vec4 D = getCell(rPos + vec2(0.0, 2.0));
    if (D.r == MAT_WATER) {
        if (fellBit(D.b) < 0.5) return false;
        if (abs(D.g) > 0.5) return false;   // carrying lateral momentum: may jet-fall diagonally (waterDiagTargets)
        // Mirror the water donor's rule-1 preemption: a donor busy receiving
        // a buoyancy swap from sinking grains above it does NOT vacate.
        vec4 dUp = getCell(rPos + vec2(0.0, 3.0));
        return !(isGranular(dUp.r) && sandFalls(dUp, rPos.y + 3.0));
    }
    if (isGranular(D.r)) return D.g > 1.5;
    return false;
#else
    return false;
#endif
}

// Angle of repose: probability a loose grain actually takes its diagonal slide
// this pass. Dry sand slides eagerly (shallow ~30 deg piles), damp sand clings
// (steep sandcastle faces), saturated sand slumps, debris gravel always rolls.
// Keyed on the DONOR position so donor, receiver, and every third-party
// arbitration predicate roll the same dice.
float slideProb(vec4 d) {
    if (d.r != MAT_SAND) return 1.0;   // debris: cohesionless
    if (d.b < 0.08) return 0.85;       // dry (scorched counts as dry)
    if (d.b < 0.85) return 0.18;       // damp: holds near-vertical faces
    return 0.75;                       // saturated: slumps
}

bool slideRolls(vec2 dPos, vec4 d) {
    return hash(dPos * 4.7 + vec2(float(u_frame), float(u_subStep))) < slideProb(d);
}

// EROSION PICKUP: does the settled, saturated SAND bed cell at pos get swept
// into suspension by fast water flowing past? In place: the cell becomes
// sediment-laden water (the eroded grain rides the sediment flag; the minted
// water cell is surrendered back when the load deposits). Pairing-safe without
// mirrors because no movement receiver targets a settled, supported,
// non-loose sand cell (mud creep requires a LOOSE donor).
bool sandErodes(vec2 pos, vec4 cell) {
#if REALISM >= 3
    if (cell.r != MAT_SAND || cell.g >= 0.5 || cell.g < -0.15) return false; // settled, not packed
    if (cell.b < 0.9) return false;                                          // saturated bed only
    if (!isSolid(getCell(pos + vec2(0.0, -1.0)).r)) return false;
    vec4 up = getCell(pos + vec2(0.0, 1.0));
    vec4 lf = getCell(pos + vec2(-1.0, 0.0));
    vec4 rt = getCell(pos + vec2(1.0, 0.0));
    bool scoured = (up.r == MAT_WATER && abs(up.g) > 0.5) ||
                   (lf.r == MAT_WATER && abs(lf.g) > 0.5) ||
                   (rt.r == MAT_WATER && abs(rt.g) > 0.5);
    if (!scoured) return false;
    return hash(pos * 9.7 + vec2(float(u_frame), float(u_subStep))) < 0.10;
#else
    return false;
#endif
}

// DEPOSITION: a calm sediment-laden water cell resting on a solid bed drops
// its load — the cell becomes fresh saturated sand.
bool sedimentDeposits(vec2 pos, vec4 cell) {
#if REALISM >= 3
    if (sedBit(cell.b) < 0.5 || abs(cell.g) > 0.5) return false;
    if (!isSolid(getCell(pos + vec2(0.0, -1.0)).r)) return false;
    return hash(pos * 6.1 + vec2(float(u_frame), float(u_subStep))) < 0.02;
#else
    return false;
#endif
}

// INFILTRATION: a still surface puddle (air above, sand directly below, a dry
// wetting front within 3 cells) soaks into the ground. Vitrified blast glass
// is sealed. Deliberately non-conserving — the mass moves into sand wetness.
bool waterSoaksIn(vec2 pos, vec4 cell) {
#if REALISM >= 3
    if (abs(cell.g) > 0.5) return false;
    if (getCell(pos + vec2(0.0, 1.0)).r != MAT_AIR) return false;
    vec4 b1 = getCell(pos + vec2(0.0, -1.0));
    if (b1.r != MAT_SAND || b1.b < -1.5) return false;
    vec4 b2 = getCell(pos + vec2(0.0, -2.0));
    vec4 b3 = getCell(pos + vec2(0.0, -3.0));
    bool dryFront = (b2.r == MAT_SAND && b2.b >= 0.0 && b2.b < 0.5) ||
                    (b3.r == MAT_SAND && b3.b >= 0.0 && b3.b < 0.5);
    if (!dryFront) return false;
    return hash(pos * 8.3 + vec2(float(u_frame), float(u_subStep))) < 0.008;
#else
    return false;
#endif
}

// Combined in-place-transform predicate for WATER, mirrored by every movement
// claim that could otherwise take the transforming cell as its donor.
bool waterMutates(vec2 pos, vec4 cell) {
    if (cell.r != MAT_WATER) return false;
    return sedimentDeposits(pos, cell) || waterSoaksIn(pos, cell);
}

// Would a loose-sand grain slide diagonally (parity dir P) into receiver rPos?
// Mirrored by the sand donor's slide rule; used by water claims as a guard.
bool sandSlideTargets(vec2 rPos, float P) {
    if (fastFallTargets(rPos)) return false;
    if (getCell(rPos + vec2(0.0, 1.0)).r != MAT_AIR) return false;
    vec4 d = getCell(rPos + vec2(-P, 1.0));
    if (!isGranular(d.r) || d.g <= 0.5) return false;
    if (!isSolid(getCell(rPos + vec2(-P, 0.0)).r)) return false;
    return slideRolls(rPos + vec2(-P, 1.0), d);
}

// Would saturated loose sand (mud) at rPos's parity-opposite side creep
// laterally into rPos this pass? Saturated slurry spreads on flat ground like
// a viscous liquid. Shared by the mud donor (self-claim) and the air receiver.
bool mudFlowTargets(vec2 rPos, float P) {
#if REALISM >= 3
    if (getCell(rPos).r != MAT_AIR) return false;
    if (fastFallTargets(rPos)) return false;
    vec2 dPos = rPos + vec2(-P, 0.0);
    vec4 D = getCell(dPos);
    if (D.r != MAT_SAND || D.b < 0.9 || D.g < 0.5) return false;   // saturated + loose only
    if (!isSolid(getCell(dPos + vec2(0.0, -1.0)).r)) return false; // falls/swaps instead
    if (getCell(rPos + vec2(0.0, -1.0)).r == MAT_AIR) return false; // donor prefers diag slide
    vec4 rUp = getCell(rPos + vec2(0.0, 1.0));
    if (isLiquid(rUp.r)) return false;                             // yield to falling liquid
    if (isGranular(rUp.r) && sandFalls(rUp, rPos.y + 1.0)) return false; // yield to falling grains
    if (sandSlideTargets(rPos, P)) return false;                   // dry slide outranks
    // Viscosity: slurry creeps, it does not race
    if (hash(dPos * 2.3 + vec2(float(u_frame), float(u_subStep))) > 0.4) return false;
    return true;
#else
    return false;
#endif
}

// Pressure-driven rise: a water cell whose stored hydrostatic head exceeds its
// elevation pushes UP into the air above (communicating vessels level out to
// within ~1 cell; tapped pressurized pockets jet). Donor is the cell below rPos.
bool waterRiseTargets(vec2 rPos, float P) {
#if REALISM >= 3
    if (getCell(rPos).r != MAT_AIR) return false;
    if (fastFallTargets(rPos)) return false;
    vec4 W = getCell(rPos + vec2(0.0, -1.0));
    if (W.r != MAT_WATER || W.a <= 1.5) return false;
    if (waterMutates(rPos + vec2(0.0, -1.0), W)) return false;      // donor transforming
    float b2 = getCell(rPos + vec2(0.0, -2.0)).r;
    if (b2 == MAT_AIR || b2 == MAT_FIRE || b2 == MAT_OIL) return false; // donor falls or swaps instead
    vec4 rUp = getCell(rPos + vec2(0.0, 1.0));
    if (isLiquid(rUp.r)) return false;                              // yield to falling liquid
    if (isGranular(rUp.r) && sandFalls(rUp, rPos.y + 1.0)) return false;
    if (sandSlideTargets(rPos, P)) return false;
    if (mudFlowTargets(rPos, P)) return false;                      // mud creep outranks
    return true;
#else
    return false;
#endif
}

// Would a water cell diagonally up-opposite of rPos flow (parity dir P) into
// rPos this pass? Shared verbatim by the diagonal donor, the diagonal receiver,
// and the lateral claims below (which it outranks).
bool waterDiagTargets(vec2 rPos, float P) {
    if (getCell(rPos).r != MAT_AIR) return false;
    if (fastFallTargets(rPos)) return false;
    if (getCell(rPos + vec2(0.0, 1.0)).r != MAT_AIR) return false;      // donor's parity side
    vec4 D = getCell(rPos + vec2(-P, 1.0));
    if (D.r != MAT_WATER) return false;                                 // the donor
    if (waterMutates(rPos + vec2(-P, 1.0), D)) return false;            // donor transforming
    float dB = getCell(rPos + vec2(-P, 0.0)).r;
    if (dB == MAT_FIRE || dB == MAT_OIL) return false;                  // donor falls through flame / swaps instead
    // JET FALL: a falling donor normally drops straight (its below receiver
    // takes it), but one carrying momentum in the parity direction keeps
    // moving sideways as it drops and comes in here instead — the below
    // receiver mirrors this exact test. Without it every cell shed from a
    // face fell straight down along that face and re-blocked the row under
    // it, a self-sustaining sawtooth that stalled a standing body of water.
    if (dB == MAT_AIR && D.g * P < 0.5) return false;
    // FACE RULE (hydrostatics): a pressurized cell (head > 1.5, i.e. water
    // stacked above it) standing on more water is part of a vertical face.
    // Only the BOTTOM cell of a face may leave sideways; the cells above it
    // sink into the hole next pass via the plain fall rule, so the body drains
    // from its base and its surface drops. Without this every face cell slid
    // out diagonally in the same pass, and the detached column fell and slid
    // straight back — water stood in domes like sand.
    if (D.a > 1.5 && dB == MAT_WATER) return false;
    vec4 dAbove = getCell(rPos + vec2(-P, 2.0));
    if (isGranular(dAbove.r) && sandFalls(dAbove, rPos.y + 2.0)) return false; // donor busy swapping
    if (mudFlowTargets(rPos, P)) return false;                      // mud creep outranks
    if (waterRiseTargets(rPos, P)) return false;                    // pressure rise outranks
    if (waterRiseTargets(rPos + vec2(-P, 2.0), P)) return false;    // donor busy rising
    return true;
}

// ---- Lateral dispersion (levelling) --------------------------------------
// The automaton's one-cell moves only ever peel the top corners of a water
// pile, so a body of water heaped up like sand at a 45-degree angle of repose.
// Real levelling needs the classic falling-sand "dispersion rate": a water
// cell resting on something, with water behind it, slides up to DISPERSION
// cells along a clear, floored run in the parity direction in ONE pass.
// Pairing: the donor's forward scan and the receiver's backward scan read the
// same cells, so both agree on the (donor, target) pair by construction. The
// target is the last run cell, pulled back by one when the cell beyond it is
// water, so it can never collide with that water's own lateral move. A run of
// a single cell is the lateral rule's job (which yields to runs of two+).
#define DISPERSION 6.0
// Probability per pass that a pressurized face cell shoves straight out of
// the face (see lateralLeftDonorClaims).
#define PUSH_RATE 0.3

// Air with something (not air/flame) under it: water can slide across it.
bool isRunCell(vec2 c) {
    if (getCell(c).r != MAT_AIR) return false;
    float f = getCell(c + vec2(0.0, -1.0)).r;
    return f != MAT_AIR && f != MAT_FIRE;
}

// Where the water donor at D slides to in direction P; D itself when the
// run is shorter than two cells.
vec2 dispersionTarget(vec2 D, float P) {
    float k = 0.0;
    for (float i = 1.0; i <= DISPERSION + 1.0; i += 1.0) {
        if (!isRunCell(D + vec2(P * i, 0.0))) break;
        k = i;
    }
    if (k > DISPERSION) return D + vec2(P * DISPERSION, 0.0);        // capped: the cell beyond is air
    if (getCell(D + vec2(P * (k + 1.0), 0.0)).r == MAT_WATER) k -= 1.0; // yield to that water's lateral move
    if (k < 2.0) return D;
    return D + vec2(P * k, 0.0);
}

// Does the water donor at D (contents Dc) really vacate into R this pass?
// Evaluated identically by the donor and by the receiver.
bool dispersionClaims(vec2 D, vec4 Dc, vec2 R, float P) {
    if (Dc.g * P < -0.5) return false;                              // momentum against the pass direction
    if (getCell(D - vec2(P, 0.0)).r != MAT_WATER) return false;     // lone droplets keep the plain rules
    vec4 Dup = getCell(D + vec2(0.0, 1.0));
    if (isGranular(Dup.r) && sandFalls(Dup, D.y + 1.0)) return false; // buoyancy swap first
    float Ddn = getCell(D + vec2(0.0, -1.0)).r;
    if (Ddn == MAT_AIR || Ddn == MAT_FIRE || Ddn == MAT_OIL) return false; // falls or swaps instead
    if (waterMutates(D, Dc)) return false;                          // donor transforming
    if (Dup.r == MAT_AIR && Dc.a > 1.5 && waterRiseTargets(D + vec2(0.0, 1.0), P)) return false; // donor rising
    // Receiver side: nothing of higher priority claims R (its parity-side
    // neighbour is a run cell, so mud creep, lateral and viscous claims on
    // it are impossible and need no check)
    if (fastFallTargets(R)) return false;
    vec4 rUp = getCell(R + vec2(0.0, 1.0));
    if (isLiquid(rUp.r) || isGranular(rUp.r)) return false;         // receiver takes from above
    if (sandSlideTargets(R, P)) return false;
    if (waterRiseTargets(R, P)) return false;
    if (waterDiagTargets(R, P)) return false;
    return true;
}

// ARBITRATION CORE: does the water cell LEFT of receiver rPos vacate rightward
// into rPos this pass? Evaluated identically by the air receiver, by the donor
// itself (self-claim), and by a leftward mover deciding to yield — symmetry by
// construction. Any asymmetry duplicates or destroys water.
bool lateralLeftDonorClaims(vec2 rPos, float P) {
    if (getCell(rPos).r != MAT_AIR) return false;
    if (fastFallTargets(rPos)) return false;
    vec4 L = getCell(rPos + vec2(-1.0, 0.0));
    if (L.r != MAT_WATER) return false;
    if (waterMutates(rPos + vec2(-1.0, 0.0), L)) return false;          // donor transforming
    if (dirOfWater(L, P) < 0.0) return false;
    // A droplet with a one-cell gap behind it to more water waits for that
    // water to close the gap instead of running ahead in lockstep with it
    if (getCell(rPos + vec2(-2.0, 0.0)).r == MAT_AIR &&
        getCell(rPos + vec2(-3.0, 0.0)).r == MAT_WATER) return false;
    vec4 Lup = getCell(rPos + vec2(-1.0, 1.0));
    if (isGranular(Lup.r) && sandFalls(Lup, rPos.y + 1.0)) return false; // busy with buoyancy swap
    float Ldn = getCell(rPos + vec2(-1.0, -1.0)).r;
    if (Ldn == MAT_AIR || Ldn == MAT_FIRE || Ldn == MAT_OIL) return false; // falls or swaps instead
    // Dispersion outranks the single step (see dispersionTarget)
    if (P > 0.0 && L.g > -0.5 && isRunCell(rPos + vec2(1.0, 0.0)) &&
        getCell(rPos + vec2(2.0, 0.0)).r != MAT_WATER &&
        getCell(rPos + vec2(-2.0, 0.0)).r == MAT_WATER) return false;
    // HYDROSTATIC PUSH: a pressurized donor (water stacked above it, head >
    // 1.5) sometimes shoves straight out of a vertical face even though its
    // parity diagonal is open or the receiver has nothing under it. The cell
    // above it then sinks into the hole through the plain fall rule, so mass
    // leaves the face at a rate proportional to its height and the body
    // slumps flat — instead of peeling one grain per pass off its top corner
    // and standing in a dome like sand. Sparse and random on purpose: every
    // face cell pushing at once opens a full-height hole column that sucks
    // the shed column straight back (and a stepped face jams on itself).
    bool push = L.a > 1.5 && hash(rPos * 3.1 + vec2(float(u_frame), float(u_subStep))) < PUSH_RATE;
    // Otherwise the donor prefers its parity diagonal when open
    if (!push) {
        if (P > 0.0) {
            if (getCell(rPos + vec2(0.0, -1.0)).r == MAT_AIR) return false;
        } else {
            if (getCell(rPos + vec2(-2.0, 0.0)).r == MAT_AIR &&
                getCell(rPos + vec2(-2.0, -1.0)).r == MAT_AIR) return false;
        }
    }
    vec4 rUp = getCell(rPos + vec2(0.0, 1.0));
    if (isLiquid(rUp.r) || isGranular(rUp.r)) return false;             // receiver takes from above
    if (sandSlideTargets(rPos, P)) return false;                        // sand slide outranks
    if (mudFlowTargets(rPos, P)) return false;                          // mud creep outranks
    if (waterRiseTargets(rPos, P)) return false;                        // pressure rise outranks
    if (waterDiagTargets(rPos, P)) return false;                        // diagonal flow outranks
    if (waterRiseTargets(rPos + vec2(-1.0, 1.0), P)) return false;      // donor busy rising
    return true;
}

// Mirror: does the water cell RIGHT of rPos vacate leftward into rPos?
// (Only effective after the left donor declined — left donor wins ties.)
bool lateralRightDonorClaims(vec2 rPos, float P) {
    if (getCell(rPos).r != MAT_AIR) return false;
    if (fastFallTargets(rPos)) return false;
    vec4 W = getCell(rPos + vec2(1.0, 0.0));
    if (W.r != MAT_WATER) return false;
    if (waterMutates(rPos + vec2(1.0, 0.0), W)) return false;           // donor transforming
    if (dirOfWater(W, P) > 0.0) return false;
    if (getCell(rPos + vec2(2.0, 0.0)).r == MAT_AIR &&
        getCell(rPos + vec2(3.0, 0.0)).r == MAT_WATER) return false;    // waits for the droplet behind
    vec4 Wup = getCell(rPos + vec2(1.0, 1.0));
    if (isGranular(Wup.r) && sandFalls(Wup, rPos.y + 1.0)) return false;
    float Wdn = getCell(rPos + vec2(1.0, -1.0)).r;
    if (Wdn == MAT_AIR || Wdn == MAT_FIRE || Wdn == MAT_OIL) return false; // falls or swaps instead
    if (P < 0.0 && W.g < 0.5 && isRunCell(rPos + vec2(-1.0, 0.0)) &&
        getCell(rPos + vec2(-2.0, 0.0)).r != MAT_WATER &&
        getCell(rPos + vec2(2.0, 0.0)).r == MAT_WATER) return false;    // dispersion outranks
    bool push = W.a > 1.5 && hash(rPos * 3.1 + vec2(float(u_frame), float(u_subStep))) < PUSH_RATE; // hydrostatic push mirror
    if (!push) {
        if (P > 0.0) {
            if (getCell(rPos + vec2(2.0, 0.0)).r == MAT_AIR &&
                getCell(rPos + vec2(2.0, -1.0)).r == MAT_AIR) return false;
        } else {
            if (getCell(rPos + vec2(0.0, -1.0)).r == MAT_AIR) return false;
        }
    }
    vec4 rUp = getCell(rPos + vec2(0.0, 1.0));
    if (isLiquid(rUp.r) || isGranular(rUp.r)) return false;
    if (sandSlideTargets(rPos, P)) return false;
    if (mudFlowTargets(rPos, P)) return false;
    if (waterRiseTargets(rPos, P)) return false;
    if (waterDiagTargets(rPos, P)) return false;
    if (waterRiseTargets(rPos + vec2(1.0, 1.0), P)) return false;       // donor busy rising
    return true;
}

// Would the viscous liquid 'liq' at rPos+(-P,0) creep laterally into air rPos?
// Shared verbatim by the liquid donor (self-claim) and the air receiver. Defers
// to every sand/mud/water claim on rPos, so it can never race a water move.
bool viscFlowTargets(vec2 rPos, float P, float liq, float visc) {
#if REALISM >= 2
    if (getCell(rPos).r != MAT_AIR) return false;
    if (fastFallTargets(rPos)) return false;
    vec2 dPos = rPos + vec2(-P, 0.0);
    vec4 D = getCell(dPos);
    if (D.r != liq) return false;
    float dBelow = getCell(dPos + vec2(0.0, -1.0)).r;
    if (dBelow == MAT_AIR || dBelow == MAT_FIRE) return false;       // falls instead
    if (liq == MAT_LAVA && lavaSolidifies(dPos, D)) return false;    // freezing in place
    if (liq == MAT_OIL) {
        if (oilIgnites(dPos)) return false;                          // combusting in place
        if (getCell(dPos + vec2(0.0, 1.0)).r == MAT_WATER) return false; // busy buoyancy swap
    }
    vec4 rUp = getCell(rPos + vec2(0.0, 1.0));
    if (isLiquid(rUp.r)) return false;                               // yield to falling liquid
    if (isGranular(rUp.r) && sandFalls(rUp, rPos.y + 1.0)) return false;
    if (sandSlideTargets(rPos, P)) return false;
    if (mudFlowTargets(rPos, P)) return false;
    if (waterRiseTargets(rPos, P)) return false;
    if (waterDiagTargets(rPos, P)) return false;
    if (lateralLeftDonorClaims(rPos, P)) return false;               // water outranks
    if (lateralRightDonorClaims(rPos, P)) return false;
    return hash(dPos * 3.7 + vec2(float(u_frame), float(u_subStep))) <= visc;
#else
    return false;
#endif
}

void main() {
    vec2 coord = floor(gl_FragCoord.xy);
    vec4 current = getCell(coord);
    float mat = current.r;

    // 1. Bedrock Baseline (bottom rows in WebGL coordinates = DOM row 599)
    if (coord.y <= 2.0) {
        fragColor = vec4(MAT_BEDROCK, 0.0, 0.0, 0.0);
        return;
    }

    // 2. Lateral Drainage Channels (Col 0 and Col 799): loose matter drains out
    if (coord.x <= 0.0 || coord.x >= u_resolution.x - 1.0) {
        if (isLiquid(mat) || isGranular(mat) || mat == MAT_FIRE) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
    }

    // 3. User Brush Application
    if (u_brush.z > 0.0) {
        if (distance(coord, u_brush.xy) <= u_brush.z) {
            float bMat = u_brush.w;
            if (bMat == MAT_AIR) {
                if (isGranular(mat) || isLiquid(mat) || mat == MAT_FIRE || mat == MAT_OBSIDIAN) {
                    fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
                    return;
                }
            } else if (mat != MAT_BEDROCK && mat != MAT_CONCRETE) {
                // Sand paints loose; lava paints fully molten (G is heat)
                float g = (bMat == MAT_SAND || bMat == MAT_LAVA) ? 1.0 : 0.0;
                fragColor = vec4(bMat, g, 0.0, 0.0);
                return;
            } else if (bMat == MAT_CONCRETE && mat != MAT_BEDROCK) {
                fragColor = vec4(MAT_CONCRETE, 0.0, 0.0, 0.0);
                return;
            }
        }
    }

    // 4. Acoustic blast concussion (crater excavation is CPU-side and conserving).
    //    Rides the WAVEFRONT: only the expanding annulus of the pressure wave
    //    destabilizes soil, so loosening visibly races outward over the frames
    //    after a detonation instead of applying everywhere at once.
    //    CONSERVATION: must NOT early-return or change this pass's movement —
    //    the flag merges into the staying-put write and acts next pass so donor
    //    and receiver stay synchronized.
    float concussed = 0.0;
    if (mat == MAT_SAND) {
        for (int i = 0; i < 4; i++) {
            if (i >= u_shockwaveCount) break;
            vec4 sw = u_shockwaves[i];
            if (sw.w <= 0.0) continue;
            float dsw = distance(coord, sw.xy);
            if (dsw > sw.z || dsw < sw.z - 70.0) continue;
            if (blastOcclusion(sw.xy, coord) < 14.0) {
                concussed = 1.0;
                break;
            }
        }
    }

    // Neighbourhood reads shared by every donor/receiver pair below
    vec4 cellBelow  = getCell(coord + vec2(0.0, -1.0));
    vec4 cellAbove  = getCell(coord + vec2(0.0, 1.0));
    vec4 cellLeft   = getCell(coord + vec2(-1.0, 0.0));
    vec4 cellRight  = getCell(coord + vec2(1.0, 0.0));

    // Global parity direction: alternates every sub-step.
    float P = mod(float(u_frame * 2 + u_subStep), 2.0) < 1.0 ? 1.0 : -1.0;
    vec4 sideP       = P > 0.0 ? cellRight : cellLeft;     // parity-side neighbour
    vec4 diagDownP   = getCell(coord + vec2(P, -1.0));
    vec4 diagUpOpp   = getCell(coord + vec2(-P, 1.0));
    vec4 sideOpp     = P > 0.0 ? cellLeft : cellRight;

    // ---- SAND / DEBRIS (granular donor side) --------------------------------
    if (isGranular(mat)) {
        bool falls = sandFalls(current, coord.y);
        if ((cellBelow.r == MAT_AIR || cellBelow.r == MAT_FIRE) && falls) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        if (cellBelow.r == MAT_WATER && falls) {
            // Buoyancy swap: sand sinks, displaced water rises into this cell
            // (carrying its suspended-sediment flag so no load is lost)
            fragColor = vec4(MAT_WATER, 0.0, sedBit(cellBelow.b), 0.0);
            return;
        }
        // Angle-of-repose diagonal slide (parity dir): loose grains only,
        // gated by the wetness-graded repose dice (mirrored via slideRolls on
        // the donor position) and yielding to a fast-fall claim on the target
        if (current.g > 0.5 && isSolid(cellBelow.r) &&
            sideP.r == MAT_AIR && diagDownP.r == MAT_AIR &&
            slideRolls(coord, current) &&
            !fastFallTargets(coord + vec2(P, -1.0))) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // Saturated slurry creeps laterally on flat ground (self-claim)
        if (mat == MAT_SAND && mudFlowTargets(coord + vec2(P, 0.0), P)) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }

        // Erosion pickup: fast water sweeps a settled saturated bed cell into
        // suspension. In-place transform (see sandErodes for the ledger).
        if (mat == MAT_SAND && sandErodes(coord, current)) {
            fragColor = vec4(MAT_WATER, 0.0, 1.0, 0.0);
            return;
        }

        // Lava contact melts SETTLED sand into fresh molten rock. In-place
        // transform: safe without pairing because movement receivers only take
        // FALLING or LOOSE grains (g > 0.5) and this requires settled g < 0.5.
        bool nearLava = cellAbove.r == MAT_LAVA || cellBelow.r == MAT_LAVA ||
                        cellLeft.r == MAT_LAVA || cellRight.r == MAT_LAVA;
        if (mat == MAT_SAND && nearLava && isSolid(cellBelow.r) && current.g < 0.5 &&
            hash(coord * 5.3 + vec2(float(u_frame), float(u_subStep))) < 0.0015) {
            fragColor = vec4(MAT_LAVA, 1.0, 0.0, 0.0);
            return;
        }

        // Debris gravel never settles cohesively: stays loose, no stress state
        if (mat == MAT_DEBRIS) {
            fragColor = vec4(MAT_DEBRIS, 1.0, 0.0, 0.0);
            return;
        }
        // Staying put: update stress, wetness, erosion destabilization, settle
        float span;
        if (isSolid(cellBelow.r)) {
            span = 0.0;
        } else {
            span = min(min(sideSupport(cellLeft), sideSupport(cellRight)) + 1.0, SPAN_NONE);
        }
        // Seepage is gravity-driven: water above or beside saturates the sand,
        // but water BELOW does not wick upward — pocket roofs stay dry (and
        // load-bearing) instead of instantly liquefying over every reservoir.
        bool touchingWater = cellAbove.r == MAT_WATER ||
                             cellLeft.r == MAT_WATER || cellRight.r == MAT_WATER;
        // Erosion: fast-flowing water scours the sand it rushes past
        bool scoured = (cellLeft.r == MAT_WATER && abs(cellLeft.g) > 0.5) ||
                       (cellRight.r == MAT_WATER && abs(cellRight.g) > 0.5) ||
                       (cellAbove.r == MAT_WATER && abs(cellAbove.g) > 0.5);
        float wet = touchingWater ? 1.0 : (current.b > 0.0 ? current.b - 0.008 : current.b);
        if (concussed > 0.5 && wet > 0.0) wet = 0.0; // blast heat flash-dries the soil
        if (nearLava && wet >= 0.0) wet = -1.0;      // radiant heat chars the contact face
        // Landing kills fall speed; settled grains then pack slowly under
        // overburden (deeper packs harder — the floor deepens with burial).
        // Blasts (concussion) and scour re-loosen packed ground.
        float loose = current.g;
        if (isSolid(cellBelow.r)) {
            float floorG = -clamp((300.0 - coord.y) * 0.003, 0.0, 0.5);
            loose = loose > 0.0 ? max(0.0, min(loose, 1.0) - 0.15)
                                : max(floorG, loose - 0.0004);
        }
        loose = max(loose, max(concussed, scoured ? 1.0 : 0.0));
        fragColor = vec4(MAT_SAND, loose, wet, span);
        return;
    }

    // ---- CONCRETE / BEDROCK / OBSIDIAN: inert to the automaton --------------
    // (concrete islands move via the CPU solver; obsidian is fused in place)
    if (mat == MAT_CONCRETE || mat == MAT_BEDROCK || mat == MAT_OBSIDIAN) {
        fragColor = current;
        return;
    }

    // ---- WATER (donor + swap-receiver side) ---------------------------------
    if (mat == MAT_WATER) {
        // 1. Receive sinking granular matter from above (buoyancy swap)
        if (isGranular(cellAbove.r) && sandFalls(cellAbove, coord.y + 1.0)) {
            fragColor = vec4(cellAbove.r, 1.0, cellAbove.r == MAT_SAND ? 1.0 : 0.0, 0.0);
            return;
        }
        // 1.5 Oil below is lighter: swap it up through me — declined while I
        //     carry suspended sediment (the load cannot ride into oil; the oil
        //     branch mirrors this sediment guard exactly)
        if (cellBelow.r == MAT_OIL && sedBit(current.b) < 0.5 &&
            !oilIgnites(coord + vec2(0.0, -1.0))) {
            float b2 = getCell(coord + vec2(0.0, -2.0)).r;
            if (b2 != MAT_AIR && b2 != MAT_FIRE) {
                fragColor = vec4(MAT_OIL, 0.0, 0.0, 0.0);
                return;
            }
        }
        // 2. Fall into air (or through flame) below
        if (cellBelow.r == MAT_AIR || cellBelow.r == MAT_FIRE) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // 2.2 In-place transforms (every claim that could take me mirrors
        //     these through waterMutates): suspended load settles onto the bed
        //     as fresh saturated sand...
        if (sedimentDeposits(coord, current)) {
            fragColor = vec4(MAT_SAND, 0.0, 1.0, 0.0);
            return;
        }
        //     ...and a still surface puddle soaks into the dry bed below
        //     (deliberate ledger exception: the mass moves into sand wetness)
        if (waterSoaksIn(coord, current)) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // 2.5 Pressure rise: head above my elevation pushes me up (self-claim)
        if (cellAbove.r == MAT_AIR && current.a > 1.5 &&
            waterRiseTargets(coord + vec2(0.0, 1.0), P)) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // 3. Parity diagonal-down: fast slope flow (shared predicate with the
        //    receiver, evaluated on my own diagonal target)
        if (diagDownP.r == MAT_AIR && waterDiagTargets(coord + vec2(P, -1.0), P)) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // 4. Momentum-steered lateral flow: vacate exactly when the receiver's
        //    arbitration would take from me (self-claim through the same code)
        float D = dirOfWater(current, P);
        if (D > 0.0) {
            if (lateralLeftDonorClaims(coord + vec2(1.0, 0.0), P)) {
                fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
                return;
            }
        } else {
            vec2 tPos = coord + vec2(-1.0, 0.0);
            if (!lateralLeftDonorClaims(tPos, P) && lateralRightDonorClaims(tPos, P)) {
                fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
                return;
            }
        }
        // 4.5 Dispersion: slide along a clear floored run (shared pairing)
        vec2 T = dispersionTarget(coord, P);
        if (T != coord && dispersionClaims(coord, current, T, P)) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // 5. Stay: momentum slowly dissipates; hydrostatic head relaxes toward
        //    (connected surface height - elevation) via max-propagation with a
        //    slow decay so stale head bleeds off after the geometry changes.
        //    The fell flag clears (I did not fall); the sediment flag persists.
        float m = current.g;
        if (hash(coord * 1.7 + vec2(float(u_frame), float(u_subStep))) < 0.05) m = 0.0;
        float head = cellAbove.r == MAT_WATER ? cellAbove.a + 1.0 : 0.0;
        head = max(head, cellLeft.r == MAT_WATER ? cellLeft.a : 0.0);
        head = max(head, cellRight.r == MAT_WATER ? cellRight.a : 0.0);
        head = max(head, cellBelow.r == MAT_WATER ? cellBelow.a - 1.0 : 0.0);
        head = clamp(head - 0.03, 0.0, 400.0);
        fragColor = vec4(MAT_WATER, m, sedBit(current.b), head);
        return;
    }

    // ---- LAVA (viscous molten rock) -----------------------------------------
    if (mat == MAT_LAVA) {
        // Quench on water contact / crust when a cooled surface (in place;
        // movement receivers mirror lavaSolidifies before taking this cell)
        if (lavaSolidifies(coord, current)) {
            fragColor = vec4(MAT_OBSIDIAN, 0.0, 0.0, 0.0);
            return;
        }
        // Fall into air (or through flame) below
        if (cellBelow.r == MAT_AIR || cellBelow.r == MAT_FIRE) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // Viscous lateral creep (self-claim through the shared predicate)
        if (viscFlowTargets(coord + vec2(P, 0.0), P, MAT_LAVA, LAVA_VISC)) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // Stay: surface radiates heat away; insulated cores stay molten forever
        float heat = current.g;
        bool exposed = cellAbove.r == MAT_AIR || cellLeft.r == MAT_AIR || cellRight.r == MAT_AIR;
        if (exposed) heat = max(0.0, heat - 0.0006);
        fragColor = vec4(MAT_LAVA, heat, 0.0, 0.0);
        return;
    }

    // ---- OIL (light flammable liquid) ---------------------------------------
    if (mat == MAT_OIL) {
        // Combustion (in place; movement receivers mirror oilIgnites)
        if (oilIgnites(coord)) {
            fragColor = vec4(MAT_FIRE, 1.0, 0.0, 0.0);
            return;
        }
        // Fall into air (or through flame) below
        if (cellBelow.r == MAT_AIR || cellBelow.r == MAT_FIRE) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // Buoyant rise: water directly above swaps down through me (mirror of
        // the water branch rule 1.5 — reaching here implies my below is not
        // AIR/FIRE and I am not igniting, matching that side's guards; the
        // sediment guard mirrors the water side declining while laden)
        if (cellAbove.r == MAT_WATER && sedBit(cellAbove.b) < 0.5) {
            vec4 above2 = getCell(coord + vec2(0.0, 2.0));
            if (!(isGranular(above2.r) && sandFalls(above2, coord.y + 2.0))) {
                fragColor = vec4(MAT_WATER, 0.0, 0.0, 0.0);
                return;
            }
        }
        // Lateral spread (self-claim through the shared predicate)
        if (viscFlowTargets(coord + vec2(P, 0.0), P, MAT_OIL, OIL_VISC)) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        fragColor = vec4(MAT_OIL, 0.0, 0.0, 0.0);
        return;
    }

    // ---- FIRE (non-conserved combustion gas) --------------------------------
    if (mat == MAT_FIRE) {
        // RECEIVES FIRST: falling matter snuffs the flame and takes the cell
        // (mirrors each donor's below==FIRE vacate rule — a receive must never
        // be preempted by the douse transform below, or the donor's matter is
        // destroyed). Matter arriving through flame keeps its fall speed mark.
        if (isGranular(cellAbove.r) && sandFalls(cellAbove, coord.y + 1.0)) {
            fragColor = vec4(cellAbove.r, 2.0, cellAbove.r == MAT_SAND ? max(cellAbove.b, 0.0) : 0.0, 0.0);
            return;
        }
        if (cellAbove.r == MAT_WATER) {
            vec4 above2 = getCell(coord + vec2(0.0, 2.0));
            if (!(isGranular(above2.r) && sandFalls(above2, coord.y + 2.0))) {
                fragColor = vec4(MAT_WATER, cellAbove.g, sedBit(cellAbove.b) + 2.0, 0.0);
                return;
            }
        }
        if (cellAbove.r == MAT_LAVA && !lavaSolidifies(coord + vec2(0.0, 1.0), cellAbove)) {
            fragColor = vec4(MAT_LAVA, cellAbove.g, 0.0, 0.0);
            return;
        }
        // Doused by side/below water (in-place transform; water ABOVE was
        // handled by the receive rule instead)
        if (cellLeft.r == MAT_WATER || cellRight.r == MAT_WATER || cellBelow.r == MAT_WATER) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // Burn down and go out
        float fuel = current.g - 0.005;
        if (fuel <= 0.0) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        fragColor = vec4(MAT_FIRE, fuel, 0.0, 0.0);
        return;
    }

    // ---- AIR (receiver side; priority mirrors the donors exactly) -----------
    // 0. FAST FALL receive: matter that fell last pass covers two cells of
    //    clear air this pass; the cell between us passes it through. Highest
    //    priority — every claim predicate declines when this holds, so it is
    //    checked once here and never re-tested below.
    if (fastFallTargets(coord)) {
        vec4 FD = getCell(coord + vec2(0.0, 2.0));
        if (FD.r == MAT_WATER) {
            fragColor = vec4(MAT_WATER, FD.g, sedBit(FD.b) + 2.0, 0.0);
        } else {
            fragColor = vec4(FD.r, 2.0, FD.r == MAT_SAND ? max(FD.b, 0.0) : 0.0, 0.0);
        }
        return;
    }
    // 1. Granular matter falling straight down (wetness travels with sand; the
    //    fell mark primes next pass's fast fall). Declines when the cell below
    //    me takes it at fast-fall speed instead (pass-through).
    if (isGranular(cellAbove.r) && sandFalls(cellAbove, coord.y + 1.0) &&
        !fastFallTargets(coord + vec2(0.0, -1.0))) {
        fragColor = vec4(cellAbove.r, 2.0, cellAbove.r == MAT_SAND ? max(cellAbove.b, 0.0) : 0.0, 0.0);
        return;
    }
    // 2. Loose granular matter sliding diagonally down (parity dir), gated by
    //    the same repose dice the donor rolled on its own position
    if (cellAbove.r == MAT_AIR && isGranular(diagUpOpp.r) && diagUpOpp.g > 0.5 &&
        isSolid(sideOpp.r) && slideRolls(coord + vec2(-P, 1.0), diagUpOpp)) {
        fragColor = vec4(diagUpOpp.r, 1.0, diagUpOpp.r == MAT_SAND ? max(diagUpOpp.b, 0.0) : 0.0, 0.0);
        return;
    }
    // 2.5 Saturated slurry creeping in laterally (parity dir)
    if (mudFlowTargets(coord, P)) {
        fragColor = vec4(MAT_SAND, 1.0, 1.0, 0.0);
        return;
    }
    // 3. Water falling straight down. Mirror the donor: the water above does NOT
    // vacate when it is busy swapping with sinking sand from ITS above cell;
    // and I pass it through when my below cell takes it at fast-fall speed.
    // A falling cell carrying momentum in the parity direction takes the
    // diagonal instead when it can (jet fall, see waterDiagTargets).
    if (cellAbove.r == MAT_WATER && !fastFallTargets(coord + vec2(0.0, -1.0)) &&
        !(cellAbove.g * P > 0.5 && waterDiagTargets(coord + vec2(P, 0.0), P))) {
        vec4 above2 = getCell(coord + vec2(0.0, 2.0));
        if (!(isGranular(above2.r) && sandFalls(above2, coord.y + 2.0))) {
            fragColor = vec4(MAT_WATER, cellAbove.g, sedBit(cellAbove.b) + 2.0, 0.0);
            return;
        }
    }
    // 3.5 Water rising under hydrostatic pressure from below (sediment rides)
    if (waterRiseTargets(coord, P)) {
        fragColor = vec4(MAT_WATER, 0.0, sedBit(cellBelow.b), 0.0);
        return;
    }
    // 4. Water flowing diagonally down (parity dir; donor is up-opposite)
    if (waterDiagTargets(coord, P)) {
        fragColor = vec4(MAT_WATER, P, sedBit(diagUpOpp.b), 0.0);
        return;
    }
    // 5. Lateral water arrival: left donor first, then right (same arbitration
    //    the donors themselves ran, over the same samples)
    //    Momentum is only kept by a cell arriving out of a body (water behind
    //    its donor); a lone droplet arrives still, else every stray cell of a
    //    thin film re-arms its momentum on each step and the film marches to
    //    the map edge and drains (the classic ~.~.~ conveyor).
    if (lateralLeftDonorClaims(coord, P)) {
        float m = getCell(coord + vec2(-2.0, 0.0)).r == MAT_WATER ? 1.0 : 0.0;
        fragColor = vec4(MAT_WATER, m, sedBit(cellLeft.b), 0.0);
        return;
    }
    if (lateralRightDonorClaims(coord, P)) {
        float m = getCell(coord + vec2(2.0, 0.0)).r == MAT_WATER ? -1.0 : 0.0;
        fragColor = vec4(MAT_WATER, m, sedBit(cellRight.b), 0.0);
        return;
    }
    // 5.5 Dispersion arrival: the nearest water cell back along the run
    //     (two to DISPERSION cells away) whose target is exactly this cell
    {
        float d = 0.0;
        for (float i = 1.0; i <= DISPERSION; i += 1.0) {
            vec2 c = coord - vec2(P * i, 0.0);
            float m = getCell(c).r;
            if (m == MAT_WATER) { d = i; break; }
            if (!isRunCell(c)) break;
        }
        if (d >= 2.0) {
            vec2 D = coord - vec2(P * d, 0.0);
            vec4 Dc = getCell(D);
            if (dispersionTarget(D, P) == coord && dispersionClaims(D, Dc, coord, P)) {
                fragColor = vec4(MAT_WATER, P, sedBit(Dc.b), 0.0);
                return;
            }
        }
    }
    // 6. Lava / oil falling straight in (donor vacates unconditionally when its
    //    below is air — all higher-priority claims above declined because our
    //    above cell is a liquid, so this receive is guaranteed to pair)
    if (cellAbove.r == MAT_LAVA && !lavaSolidifies(coord + vec2(0.0, 1.0), cellAbove)) {
        fragColor = vec4(MAT_LAVA, cellAbove.g, 0.0, 0.0);
        return;
    }
    if (cellAbove.r == MAT_OIL && !oilIgnites(coord + vec2(0.0, 1.0))) {
        fragColor = vec4(MAT_OIL, 0.0, 0.0, 0.0);
        return;
    }
    // 7. Viscous lateral creep arrival (heat rides along with lava)
    if (viscFlowTargets(coord, P, MAT_LAVA, LAVA_VISC)) {
        fragColor = vec4(MAT_LAVA, getCell(coord + vec2(-P, 0.0)).g, 0.0, 0.0);
        return;
    }
    if (viscFlowTargets(coord, P, MAT_OIL, OIL_VISC)) {
        fragColor = vec4(MAT_OIL, 0.0, 0.0, 0.0);
        return;
    }
    // 8. Flames lick upward from a burning cell below (fire is non-conserved
    //    gas: spawned only after every matter claim declined, decays to air)
    if (cellBelow.r == MAT_FIRE && cellBelow.g > 0.35 &&
        hash(coord * 7.1 + vec2(float(u_frame), float(u_subStep))) < 0.35) {
        fragColor = vec4(MAT_FIRE, cellBelow.g - 0.3, 0.0, 0.0);
        return;
    }

    fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
}
`;

// `#version` must be the first line of the source, so the tier define is
// spliced in between it and the body.
export function physicsSource(realism) {
    const level = Math.min(REALISM_HIGH, Math.max(REALISM_LOW, realism | 0));
    return `#version 300 es
#define REALISM ${level}
` + physicsBody;
}

export const fsPhysicsSource = physicsSource(REALISM_HIGH);
