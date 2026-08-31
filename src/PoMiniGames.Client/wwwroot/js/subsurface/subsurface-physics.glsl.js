// WebGL 2.0 GLSL Shaders for Cellular Automata Physics Pipeline
// Sub-Surface Multi-Material Engine

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
uniform vec4 u_shockwave;        // (x, y, radius, intensity)

in vec2 v_uv;
out vec4 fragColor;

// Material IDs
#define MAT_AIR       0.0
#define MAT_SAND      1.0
#define MAT_CONCRETE  2.0
#define MAT_WATER     3.0
#define MAT_BEDROCK   4.0

vec4 getCell(vec2 coord) {
    if (coord.x < 0.0 || coord.x >= u_resolution.x || coord.y < 0.0 || coord.y >= u_resolution.y) {
        return vec4(MAT_AIR, 0.0, 0.0, 0.0);
    }
    return texture(u_stateTexture, coord / u_resolution);
}

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

void main() {
    vec2 coord = floor(gl_FragCoord.xy);
    vec4 current = getCell(coord);
    float mat = current.r;

    // 1. Bedrock Baseline (Row 0 in WebGL coordinate where bottom is row 0)
    if (coord.y <= 1.0) {
        fragColor = vec4(MAT_BEDROCK, 0.0, 0.0, 1.0);
        return;
    }

    // 2. Lateral Drainage Channels (Col 0 and Col 799)
    if (coord.x <= 0.0 || coord.x >= u_resolution.x - 1.0) {
        if (mat == MAT_WATER || mat == MAT_SAND) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
    }

    // 3. User Brush Application
    if (u_brush.z > 0.0) {
        vec2 bPos = u_brush.xy;
        float bRadius = u_brush.z;
        float bMat = u_brush.w;

        if (distance(coord, bPos) <= bRadius) {
            if (bMat == MAT_AIR) {
                // Dig Vacuum: erases sand and water, leaves concrete and bedrock intact
                if (mat == MAT_SAND || mat == MAT_WATER) {
                    fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
                    return;
                }
            } else if (mat != MAT_BEDROCK) {
                // Paint brush
                fragColor = vec4(bMat, 0.0, 0.0, 1.0);
                return;
            }
        }
    }

    // 4. Acoustic Blast Shockwave & Soil Pulverization
    if (u_shockwave.w > 0.0) {
        vec2 sPos = u_shockwave.xy;
        float sRadius = u_shockwave.z;
        float dist = distance(coord, sPos);
        if (dist <= sRadius) {
            if (mat == MAT_SAND) {
                // Pulverize cohesive sand into dissipating void
                fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
                return;
            } else if (mat == MAT_CONCRETE && dist <= sRadius * 0.6) {
                // Shatter concrete close to blast center
                fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
                return;
            }
        }
    }

    // Cellular Automata Multi-Material Rules
    vec4 cellBelow  = getCell(coord + vec2(0.0, -1.0));
    vec4 cellAbove  = getCell(coord + vec2(0.0, 1.0));
    vec4 cellLeft   = getCell(coord + vec2(-1.0, 0.0));
    vec4 cellRight  = getCell(coord + vec2(1.0, 0.0));
    vec4 cellDownL  = getCell(coord + vec2(-1.0, -1.0));
    vec4 cellDownR  = getCell(coord + vec2(1.0, -1.0));
    vec4 cellUpL    = getCell(coord + vec2(-1.0, 1.0));
    vec4 cellUpR    = getCell(coord + vec2(1.0, 1.0));

    // A. Sand Dynamics (Mohr-Coulomb granular flow + cohesion)
    if (mat == MAT_SAND) {
        // Fall directly down into Air or Water (buoyancy displacement)
        if (cellBelow.r == MAT_AIR || cellBelow.r == MAT_WATER) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }

        // Shear failure angle of repose (~30 degrees)
        float h = hash(coord + vec2(float(u_frame), float(u_subStep)));
        if (h > 0.5) {
            if (cellDownL.r == MAT_AIR && cellLeft.r == MAT_AIR) {
                fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
                return;
            }
        } else {
            if (cellDownR.r == MAT_AIR && cellRight.r == MAT_AIR) {
                fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
                return;
            }
        }
    }

    // Receive Sand from above
    if (cellAbove.r == MAT_SAND && (mat == MAT_AIR || mat == MAT_WATER)) {
        fragColor = vec4(MAT_SAND, 0.0, 0.0, 1.0);
        return;
    }
    if (cellUpR.r == MAT_SAND && cellRight.r == MAT_AIR && mat == MAT_AIR && hash(coord + vec2(float(u_frame), 1.0)) > 0.5) {
        fragColor = vec4(MAT_SAND, 0.0, 0.0, 1.0);
        return;
    }
    if (cellUpL.r == MAT_SAND && cellLeft.r == MAT_AIR && mat == MAT_AIR && hash(coord + vec2(float(u_frame), 2.0)) <= 0.5) {
        fragColor = vec4(MAT_SAND, 0.0, 0.0, 1.0);
        return;
    }

    // B. Water Dynamics (Incompressible Eulerian fluid flow)
    if (mat == MAT_WATER) {
        // Water flows down into Air
        if (cellBelow.r == MAT_AIR) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
        // Lateral spread into Air
        float h = hash(coord + vec2(float(u_frame), float(u_subStep) * 3.7));
        if (h > 0.5 && cellLeft.r == MAT_AIR) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        } else if (cellRight.r == MAT_AIR) {
            fragColor = vec4(MAT_AIR, 0.0, 0.0, 0.0);
            return;
        }
    }

    // Receive Water from Above or Sides
    if (mat == MAT_AIR) {
        if (cellAbove.r == MAT_WATER) {
            fragColor = vec4(MAT_WATER, 0.0, 0.0, 1.0);
            return;
        }
        if (cellRight.r == MAT_WATER && (cellRight.r == MAT_WATER || cellBelow.r != MAT_AIR)) {
            fragColor = vec4(MAT_WATER, 0.0, 0.0, 1.0);
            return;
        }
        if (cellLeft.r == MAT_WATER && (cellLeft.r == MAT_WATER || cellBelow.r != MAT_AIR)) {
            fragColor = vec4(MAT_WATER, 0.0, 0.0, 1.0);
            return;
        }
    }

    fragColor = current;
}
`;
