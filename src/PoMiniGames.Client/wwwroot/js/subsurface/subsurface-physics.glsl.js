// WebGL 2.0 GLSL Shaders for Cellular Automata Physics Pipeline
// Sand Multi-Material Engine
//
// Cell packing (RGBA32F):
//   SAND : G = looseness (1 loose grain -> 0 settled cohesive)  B = wetness 0..1, or -1 scorched  A = roof-span stress
//   WATER: G = flow momentum (-1 / 0 / +1)  A = hydrostatic head (pressure)  B unused
//   other: channels zero
//
// Donor/receiver pairing contract: every rule that moves matter is written twice —
// once from the vacating cell and once from the receiving cell — over the SAME
// neighbour reads and the same frame-parity direction, so a move is always a swap
// and total sand/water mass is conserved. Water's momentum-steered lateral flow
// additionally uses a left-donor-wins arbitration (lateralLeftDonorClaims) that
// BOTH the yielding donor and the receiver evaluate over identical samples.
// Editing one side of any pair without its mirror re-introduces duplication.
//
// Concrete is inert here: rigid-body motion, stress fracture, and blast craters
// are resolved on the CPU (subsurface-engine.js) against readback snapshots.

export const vsQuadSource = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
    v_uv = (a_position + 1.0) * 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const fsPhysicsSource = `#version 300 es
precision highp float;

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

#define SPAN_NONE     999.0

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
    return m == MAT_SAND || m == MAT_CONCRETE || m == MAT_BEDROCK || m == MAT_DEBRIS;
}

// Granular movers share the sand movement rules; debris (red bomb-casing
// gravel) is cohesionless — always loose, never forms roofs.
bool isGranular(float m) {
    return m == MAT_SAND || m == MAT_DEBRIS;
}

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
    if (side.r == MAT_CONCRETE || side.r == MAT_BEDROCK) return 0.0;
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
    for (float t = 2.0; t < 360.0; t += 2.0) {
        if (t >= dist - 1.0) break;
        if (isSolid(getCell(floor(from + dir * t)).r)) solidLen += 2.0;
        if (solidLen > 16.0) break;
    }
    return solidLen;
}

// Would a loose-sand grain slide diagonally (parity dir P) into receiver rPos?
// Mirrored by the sand donor's slide rule; used by water claims as a guard.
bool sandSlideTargets(vec2 rPos, float P) {
    if (getCell(rPos + vec2(0.0, 1.0)).r != MAT_AIR) return false;
    vec4 d = getCell(rPos + vec2(-P, 1.0));
    if (!isGranular(d.r) || d.g <= 0.5) return false;
    return isSolid(getCell(rPos + vec2(-P, 0.0)).r);
}

// Would saturated loose sand (mud) at rPos's parity-opposite side creep
// laterally into rPos this pass? Saturated slurry spreads on flat ground like
// a viscous liquid. Shared by the mud donor (self-claim) and the air receiver.
bool mudFlowTargets(vec2 rPos, float P) {
    if (getCell(rPos).r != MAT_AIR) return false;
    vec2 dPos = rPos + vec2(-P, 0.0);
    vec4 D = getCell(dPos);
    if (D.r != MAT_SAND || D.b < 0.9 || D.g < 0.5) return false;   // saturated + loose only
    if (!isSolid(getCell(dPos + vec2(0.0, -1.0)).r)) return false; // falls/swaps instead
    if (getCell(rPos + vec2(0.0, -1.0)).r == MAT_AIR) return false; // donor prefers diag slide
    vec4 rUp = getCell(rPos + vec2(0.0, 1.0));
    if (rUp.r == MAT_WATER) return false;                          // yield to falling water
    if (isGranular(rUp.r) && sandFalls(rUp, rPos.y + 1.0)) return false; // yield to falling grains
    if (sandSlideTargets(rPos, P)) return false;                   // dry slide outranks
    // Viscosity: slurry creeps, it does not race
    if (hash(dPos * 2.3 + vec2(float(u_frame), float(u_subStep))) > 0.4) return false;
    return true;
}

// Pressure-driven rise: a water cell whose stored hydrostatic head exceeds its
// elevation pushes UP into the air above (communicating vessels level out;
// tapped pressurized pockets jet). Donor is the cell below rPos.
bool waterRiseTargets(vec2 rPos, float P) {
    if (getCell(rPos).r != MAT_AIR) return false;
    vec4 W = getCell(rPos + vec2(0.0, -1.0));
    if (W.r != MAT_WATER || W.a <= 3.0) return false;
    if (getCell(rPos + vec2(0.0, -2.0)).r == MAT_AIR) return false; // donor falls instead
    vec4 rUp = getCell(rPos + vec2(0.0, 1.0));
    if (rUp.r == MAT_WATER) return false;                           // yield to falling water
    if (isGranular(rUp.r) && sandFalls(rUp, rPos.y + 1.0)) return false;
    if (sandSlideTargets(rPos, P)) return false;
    if (mudFlowTargets(rPos, P)) return false;                      // mud creep outranks
    return true;
}

// Would a water cell diagonally up-opposite of rPos flow (parity dir P) into
// rPos this pass? Shared verbatim by the diagonal donor, the diagonal receiver,
// and the lateral claims below (which it outranks).
bool waterDiagTargets(vec2 rPos, float P) {
    if (getCell(rPos).r != MAT_AIR) return false;
    if (getCell(rPos + vec2(0.0, 1.0)).r != MAT_AIR) return false;      // donor's parity side
    if (getCell(rPos + vec2(-P, 1.0)).r != MAT_WATER) return false;     // the donor
    if (getCell(rPos + vec2(-P, 0.0)).r == MAT_AIR) return false;       // donor falls instead
    vec4 dAbove = getCell(rPos + vec2(-P, 2.0));
    if (isGranular(dAbove.r) && sandFalls(dAbove, rPos.y + 2.0)) return false; // donor busy swapping
    if (mudFlowTargets(rPos, P)) return false;                      // mud creep outranks
    if (waterRiseTargets(rPos, P)) return false;                    // pressure rise outranks
    if (waterRiseTargets(rPos + vec2(-P, 2.0), P)) return false;    // donor busy rising
    return true;
}

// ARBITRATION CORE: does the water cell LEFT of receiver rPos vacate rightward
// into rPos this pass? Evaluated identically by the air receiver, by the donor
// itself (self-claim), and by a leftward mover deciding to yield — symmetry by
// construction. Any asymmetry duplicates or destroys water.
bool lateralLeftDonorClaims(vec2 rPos, float P) {
    if (getCell(rPos).r != MAT_AIR) return false;
    vec4 L = getCell(rPos + vec2(-1.0, 0.0));
    if (L.r != MAT_WATER) return false;
    if (dirOfWater(L, P) < 0.0) return false;
    vec4 Lup = getCell(rPos + vec2(-1.0, 1.0));
    if (isGranular(Lup.r) && sandFalls(Lup, rPos.y + 1.0)) return false; // busy with buoyancy swap
    if (getCell(rPos + vec2(-1.0, -1.0)).r == MAT_AIR) return false;    // falls instead
    // Donor prefers its parity diagonal when open
    if (P > 0.0) {
        if (getCell(rPos + vec2(0.0, -1.0)).r == MAT_AIR) return false;
    } else {
        if (getCell(rPos + vec2(-2.0, 0.0)).r == MAT_AIR &&
            getCell(rPos + vec2(-2.0, -1.0)).r == MAT_AIR) return false;
    }
    vec4 rUp = getCell(rPos + vec2(0.0, 1.0));
    if (rUp.r == MAT_WATER || isGranular(rUp.r)) return false;          // receiver takes from above
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
    vec4 W = getCell(rPos + vec2(1.0, 0.0));
    if (W.r != MAT_WATER) return false;
    if (dirOfWater(W, P) > 0.0) return false;
    vec4 Wup = getCell(rPos + vec2(1.0, 1.0));
    if (isGranular(Wup.r) && sandFalls(Wup, rPos.y + 1.0)) return false;
    if (getCell(rPos + vec2(1.0, -1.0)).r == MAT_AIR) return false;
    if (P > 0.0) {
        if (getCell(rPos + vec2(2.0, 0.0)).r == MAT_AIR &&
            getCell(rPos + vec2(2.0, -1.0)).r == MAT_AIR) return false;
    } else {
        if (getCell(rPos + vec2(0.0, -1.0)).r == MAT_AIR) return false;
    }
    vec4 rUp = getCell(rPos + vec2(0.0, 1.0));
    if (rUp.r == MAT_WATER || isGranular(rUp.r)) return false;
    if (sandSlideTargets(rPos, P)) return false;
    if (mudFlowTargets(rPos, P)) return false;
    if (waterRiseTargets(rPos, P)) return false;
    if (waterDiagTargets(rPos, P)) return false;
    if (waterRiseTargets(rPos + vec2(1.0, 1.0), P)) return false;       // donor busy rising
    return true;
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
        if (mat == MAT_WATER || isGranular(mat)) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
    }

    // 3. User Brush Application
    if (u_brush.z > 0.0) {
        if (distance(coord, u_brush.xy) <= u_brush.z) {
            float bMat = u_brush.w;
            if (bMat == MAT_AIR) {
                if (isGranular(mat) || mat == MAT_WATER) {
                    fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
                    return;
                }
            } else if (mat != MAT_BEDROCK && mat != MAT_CONCRETE) {
                fragColor = vec4(bMat, bMat == MAT_SAND ? 1.0 : 0.0, 0.0, 0.0);
                return;
            } else if (bMat == MAT_CONCRETE && mat != MAT_BEDROCK) {
                fragColor = vec4(MAT_CONCRETE, 0.0, 0.0, 0.0);
                return;
            }
        }
    }

    // 4. Acoustic blast concussion (crater excavation is CPU-side and conserving).
    //    CONSERVATION: must NOT early-return or change this pass's movement —
    //    the flag merges into the staying-put write and acts next pass so donor
    //    and receiver stay synchronized.
    float concussed = 0.0;
    if (mat == MAT_SAND) {
        for (int i = 0; i < 4; i++) {
            if (i >= u_shockwaveCount) break;
            vec4 sw = u_shockwaves[i];
            if (sw.w <= 0.0) continue;
            if (distance(coord, sw.xy) > sw.z) continue;
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
        if (cellBelow.r == MAT_AIR && falls) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        if (cellBelow.r == MAT_WATER && falls) {
            // Buoyancy swap: sand sinks, displaced water rises into this cell
            fragColor = vec4(MAT_WATER, 0.0, 0.0, 0.0);
            return;
        }
        // Angle-of-repose diagonal slide (parity dir): loose grains only
        if (current.g > 0.5 && isSolid(cellBelow.r) &&
            sideP.r == MAT_AIR && diagDownP.r == MAT_AIR) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // Saturated slurry creeps laterally on flat ground (self-claim)
        if (mat == MAT_SAND && mudFlowTargets(coord + vec2(P, 0.0), P)) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
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
        float loose = isSolid(cellBelow.r) ? max(0.0, current.g - 0.15) : current.g;
        loose = max(loose, max(concussed, scoured ? 1.0 : 0.0));
        fragColor = vec4(MAT_SAND, loose, wet, span);
        return;
    }

    // ---- CONCRETE / BEDROCK: inert to the automaton (CPU island solver) -----
    if (mat == MAT_CONCRETE || mat == MAT_BEDROCK) {
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
        // 2. Fall into air below (momentum rides along via the receiver)
        if (cellBelow.r == MAT_AIR) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // 2.5 Pressure rise: head above my elevation pushes me up (self-claim)
        if (cellAbove.r == MAT_AIR && current.a > 3.0 &&
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
        // 5. Stay: momentum slowly dissipates; hydrostatic head relaxes toward
        //    (connected surface height - elevation) via max-propagation with a
        //    slow decay so stale head bleeds off after the geometry changes.
        float m = current.g;
        if (hash(coord * 1.7 + vec2(float(u_frame), float(u_subStep))) < 0.05) m = 0.0;
        float head = cellAbove.r == MAT_WATER ? cellAbove.a + 1.0 : 0.0;
        head = max(head, cellLeft.r == MAT_WATER ? cellLeft.a : 0.0);
        head = max(head, cellRight.r == MAT_WATER ? cellRight.a : 0.0);
        head = max(head, cellBelow.r == MAT_WATER ? cellBelow.a - 1.0 : 0.0);
        head = clamp(head - 0.03, 0.0, 400.0);
        fragColor = vec4(MAT_WATER, m, 0.0, head);
        return;
    }

    // ---- AIR (receiver side; priority mirrors the donors exactly) -----------
    // 1. Granular matter falling straight down (wetness travels with sand)
    if (isGranular(cellAbove.r) && sandFalls(cellAbove, coord.y + 1.0)) {
        fragColor = vec4(cellAbove.r, 1.0, cellAbove.r == MAT_SAND ? max(cellAbove.b, 0.0) : 0.0, 0.0);
        return;
    }
    // 2. Loose granular matter sliding diagonally down (parity dir)
    if (cellAbove.r == MAT_AIR && isGranular(diagUpOpp.r) && diagUpOpp.g > 0.5 &&
        isSolid(sideOpp.r)) {
        fragColor = vec4(diagUpOpp.r, 1.0, diagUpOpp.r == MAT_SAND ? max(diagUpOpp.b, 0.0) : 0.0, 0.0);
        return;
    }
    // 2.5 Saturated slurry creeping in laterally (parity dir)
    if (mudFlowTargets(coord, P)) {
        fragColor = vec4(MAT_SAND, 1.0, 1.0, 0.0);
        return;
    }
    // 3. Water falling straight down. Mirror the donor: the water above does NOT
    // vacate when it is busy swapping with sinking sand from ITS above cell.
    if (cellAbove.r == MAT_WATER) {
        vec4 above2 = getCell(coord + vec2(0.0, 2.0));
        if (!(isGranular(above2.r) && sandFalls(above2, coord.y + 2.0))) {
            fragColor = vec4(MAT_WATER, cellAbove.g, 0.0, 0.0);
            return;
        }
    }
    // 3.5 Water rising under hydrostatic pressure from below
    if (waterRiseTargets(coord, P)) {
        fragColor = vec4(MAT_WATER, 0.0, 0.0, 0.0);
        return;
    }
    // 4. Water flowing diagonally down (parity dir; donor is up-opposite)
    if (waterDiagTargets(coord, P)) {
        fragColor = vec4(MAT_WATER, P, 0.0, 0.0);
        return;
    }
    // 5. Lateral water arrival: left donor first, then right (same arbitration
    //    the donors themselves ran, over the same samples)
    if (lateralLeftDonorClaims(coord, P)) {
        fragColor = vec4(MAT_WATER, 1.0, 0.0, 0.0);
        return;
    }
    if (lateralRightDonorClaims(coord, P)) {
        fragColor = vec4(MAT_WATER, -1.0, 0.0, 0.0);
        return;
    }

    fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
}
`;
