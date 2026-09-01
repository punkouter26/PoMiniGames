// WebGL 2.0 Retro Pixel-Art Palette & Shockwave Visualizer Render Shader
// Sand Multi-Material Engine

// Ballistic ejecta grains: blast-displaced sand/water cells fly as gl.POINTS
// drawn over the material pass, then re-enter the grid where they land.
export const vsGrainSource = `#version 300 es
layout(location = 0) in vec3 a_grain;   // (x, y, materialId)
uniform vec2 u_resolution;
flat out float v_mat;

void main() {
    v_mat = a_grain.z;
    vec2 clip = (a_grain.xy / u_resolution) * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
    gl_PointSize = 2.0;
}
`;

export const fsGrainSource = `#version 300 es
precision highp float;
flat in float v_mat;
out vec4 fragColor;

void main() {
    // z encodes material + dust flag: mat (1 sand, 2 concrete, 3 water,
    // 5 red bomb debris) + 10 if it is a fine slow-settling particle.
    bool dusty = v_mat >= 10.0;
    float m = dusty ? v_mat - 10.0 : v_mat;
    vec3 col;
    if (m < 1.5) {
        col = dusty ? vec3(0.82, 0.75, 0.62) : vec3(0.86, 0.71, 0.47);  // sand / dust
    } else if (m < 2.5) {
        col = vec3(0.55, 0.60, 0.68);                                   // concrete rubble
    } else if (m < 4.0) {
        col = dusty ? vec3(0.78, 0.88, 0.96) : vec3(0.30, 0.60, 0.92);  // water / steam
    } else {
        col = vec3(0.80, 0.18, 0.13);                                   // red bomb-casing debris
    }
    fragColor = vec4(col, 1.0);
}
`;

export const fsRenderSource = `#version 300 es
precision highp float;

uniform sampler2D u_stateTexture;
uniform vec2 u_resolution;       // (800.0, 600.0)
uniform float u_time;
uniform vec4 u_shockwaves[4];    // (x, y, radius, intensity)
uniform int u_shockwaveCount;
uniform vec4 u_projectiles[16];  // (x, y, radius, kind) kind: 0 TNT lit, 1 TNT extinguished, 2 balloon
uniform int u_projectileCount;
uniform vec4 u_aim;              // (originX, originY, currentX, currentY)
uniform int u_aimActive;

in vec2 v_uv;
out vec4 fragColor;

#define MAT_AIR       0.0
#define MAT_SAND      1.0
#define MAT_CONCRETE  2.0
#define MAT_WATER     3.0
#define MAT_BEDROCK   4.0
#define MAT_DEBRIS    5.0

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float distToSegment(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.0001), 0.0, 1.0);
    return distance(p, a + ab * t);
}

void main() {
    vec2 coord = floor(gl_FragCoord.xy);
    vec4 cell = texture(u_stateTexture, v_uv);
    float mat = cell.r;

    vec3 col = vec3(0.0);
    float noise = hash(coord) * 0.08 - 0.04;

    if (mat == MAT_AIR) {
        // Sky gradient in top half (Row 300 to 599 in WebGL coords) vs Cavern void in bottom half
        if (coord.y >= 300.0) {
            float t = (coord.y - 300.0) / 300.0;
            // Clear blue sky: lighter at the horizon, deeper blue at the top
            col = mix(vec3(0.44, 0.68, 0.94), vec3(0.15, 0.36, 0.72), t);
        } else {
            // Dark underground excavated cavern void
            col = vec3(0.06, 0.05, 0.09) + noise * 0.5;
        }
    } else if (mat == MAT_SAND) {
        // Warm light-brown cohesive sand pixel palette with organic grain variation
        vec3 sandLight = vec3(0.91, 0.78, 0.58);
        vec3 sandDark  = vec3(0.74, 0.57, 0.37);
        float pattern = hash(coord * 1.5);
        col = mix(sandDark, sandLight, pattern) + noise;
        // Loose airborne/settling grains read slightly dusty
        col = mix(col, vec3(0.82, 0.70, 0.52), cell.g * 0.35);
        if (cell.b < -1.5) {
            // Vitrified blast glass: fused, glossy, faintly green-black
            float sheen = hash(coord * 0.9) * 0.12;
            col = mix(col, vec3(0.10, 0.14, 0.12), 0.85) + sheen;
        } else if (cell.b < -0.5) {
            // Blast-scorched crater lining: charred, ashen
            col = mix(col, vec3(0.24, 0.21, 0.19), 0.75);
        } else if (cell.b > 0.0) {
            // Saturated sand darkens toward wet mud
            col = mix(col, vec3(0.48, 0.36, 0.24), 0.5 * clamp(cell.b, 0.0, 1.0));
        }
    } else if (mat == MAT_CONCRETE) {
        // Reinforced concrete bar with rebar grid texture
        vec3 concreteBase = vec3(0.55, 0.60, 0.68);
        if (mod(coord.x, 6.0) < 1.0 || mod(coord.y, 6.0) < 1.0) {
            concreteBase = vec3(0.38, 0.42, 0.48); // Rebar hatch lines
        }
        col = concreteBase + noise * 0.7;
    } else if (mat == MAT_WATER) {
        // Vibrant arcade blue water with dynamic surface wave shimmer
        float wave = sin(coord.x * 0.15 + u_time * 4.0) * 0.05;
        vec3 waterCol = vec3(0.13, 0.44, 0.82) + wave;
        col = waterCol + noise * 0.3;
    } else if (mat == MAT_BEDROCK) {
        // Indestructible dark basalt bedrock
        vec3 basalt = vec3(0.17, 0.18, 0.26);
        if (mod(coord.x + coord.y, 4.0) < 1.0) {
            basalt = vec3(0.12, 0.13, 0.18);
        }
        col = basalt;
    } else if (mat == MAT_DEBRIS) {
        // Settled red bomb-casing gravel: stays red on the ground
        vec3 debrisLight = vec3(0.84, 0.24, 0.17);
        vec3 debrisDark  = vec3(0.58, 0.12, 0.09);
        col = mix(debrisDark, debrisLight, hash(coord * 1.7)) + noise * 0.5;
    }

    // Ballistic ordnance bodies (spinning circular rigid projectiles).
    // w packs kind*10 + rotation angle: kind 0 = TNT, 2 = water balloon.
    for (int i = 0; i < 16; i++) {
        if (i >= u_projectileCount) break;
        vec4 p = u_projectiles[i];
        float d = distance(coord, p.xy);
        if (d > p.z + 1.5) continue;

        float kind = floor(p.w / 10.0 + 0.001);
        float ang = p.w - kind * 10.0;
        vec2 spin = vec2(cos(ang), sin(ang));

        vec3 bodyCol;
        if (kind < 0.5) {
            // Live TNT: red drum; the rotation-locked stripe and fuse make the
            // sphere visibly roll and tumble
            bodyCol = vec3(0.78, 0.16, 0.12);
            vec2 off = coord - p.xy;
            if (abs(dot(off, vec2(-spin.y, spin.x))) < 1.3 && d <= p.z) {
                bodyCol = vec3(0.5, 0.09, 0.07); // rotating stripe
            }
            if (distance(coord, p.xy + spin * p.z * 0.85) < 2.0 && mod(u_time * 6.0, 2.0) < 1.0) {
                bodyCol = vec3(1.0, 0.9, 0.35); // fuse spark at the rotating cap
            }
        } else {
            // Water balloon: glossy cyan membrane
            bodyCol = vec3(0.25, 0.75, 0.95);
            if (distance(coord, p.xy + vec2(-p.z * 0.35, p.z * 0.35)) < p.z * 0.3) {
                bodyCol = vec3(0.7, 0.95, 1.0); // specular highlight
            }
        }
        if (d <= p.z) {
            col = bodyCol;
        } else {
            col = mix(col, vec3(0.05), 0.8); // 1px dark rim
        }
    }

    // Slingshot aim line: dashed trajectory indicator from drag point to origin
    if (u_aimActive == 1) {
        vec2 origin = u_aim.xy;
        vec2 drag = u_aim.zw;
        float dSeg = distToSegment(coord, drag, origin);
        if (dSeg < 1.5) {
            float along = distance(coord, drag);
            if (mod(along, 10.0) < 6.0) {
                float pull = distance(origin, drag);
                vec3 aimCol = mix(vec3(1.0, 1.0, 0.6), vec3(1.0, 0.35, 0.2), clamp(pull / 240.0, 0.0, 1.0));
                col = mix(col, aimCol, 0.9);
            }
        }
        // Launch velocity vector preview beyond the origin
        vec2 launchDir = origin - drag;
        float dVec = distToSegment(coord, origin, origin + launchDir * 0.5);
        if (dVec < 1.0 && mod(distance(coord, origin), 8.0) < 3.0) {
            col = mix(col, vec3(1.0, 1.0, 1.0), 0.7);
        }
        if (distance(coord, origin) < 4.0) {
            col = vec3(1.0, 0.95, 0.7); // anchor pad
        }
    }

    // Dynamic Acoustic Shockwave Flash Overlay
    for (int i = 0; i < 4; i++) {
        if (i >= u_shockwaveCount) break;
        vec4 sw = u_shockwaves[i];
        if (sw.w <= 0.0) continue;
        float dist = distance(coord, sw.xy);

        // Flash expanding ring
        float ringWidth = 14.0;
        if (abs(dist - sw.z) < ringWidth) {
            float ringFactor = 1.0 - (abs(dist - sw.z) / ringWidth);
            col += vec3(1.0, 0.85, 0.3) * ringFactor * sw.w;
        } else if (dist < sw.z) {
            // Core fireball fade
            col += vec3(0.9, 0.35, 0.1) * 0.3 * sw.w * (1.0 - dist / sw.z);
        }
    }

    fragColor = vec4(col, 1.0);
}
`;
