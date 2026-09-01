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
    // 5 red bomb debris, 6 lava, 7 oil, 9 obsidian shard) + 10 if it is a
    // fine slow-settling particle.
    bool dusty = v_mat >= 10.0;
    float m = dusty ? v_mat - 10.0 : v_mat;
    vec3 col;
    if (m < 1.5) {
        col = dusty ? vec3(0.82, 0.75, 0.62) : vec3(0.86, 0.71, 0.47);  // sand / dust
    } else if (m < 2.5) {
        col = vec3(0.55, 0.60, 0.68);                                   // concrete rubble
    } else if (m < 4.0) {
        col = dusty ? vec3(0.78, 0.88, 0.96) : vec3(0.30, 0.60, 0.92);  // water / steam
    } else if (m < 5.5) {
        col = vec3(0.80, 0.18, 0.13);                                   // red bomb-casing debris
    } else if (m < 6.5) {
        col = vec3(1.00, 0.52, 0.12);                                   // molten lava gobbet
    } else if (m < 7.5) {
        col = vec3(0.16, 0.12, 0.08);                                   // oil droplet
    } else {
        col = vec3(0.38, 0.28, 0.48);                                   // obsidian shard
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
uniform vec4 u_projectiles[24];  // (x, y, radius, kind*10+angle) kind: 0 TNT/bomblet, 2 balloon, 3 drill, 4 cluster, 5 nuke, 6 sticky
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
#define MAT_LAVA      6.0
#define MAT_OIL       7.0
#define MAT_FIRE      8.0
#define MAT_OBSIDIAN  9.0

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
            // Living sky: 180s day-night cycle. The sun-position formula is
            // duplicated in fsCompositeSource's god-ray pass — keep in sync.
            float dayT = fract(u_time / 180.0);
            float sunH = sin(dayT * 6.2832);
            float daylight = smoothstep(-0.18, 0.25, sunH);
            float t = (coord.y - 300.0) / 300.0;
            vec3 dayTop = vec3(0.15, 0.36, 0.72), dayHor = vec3(0.44, 0.68, 0.94);
            vec3 nightTop = vec3(0.015, 0.025, 0.09), nightHor = vec3(0.06, 0.08, 0.18);
            col = mix(mix(nightHor, dayHor, daylight), mix(nightTop, dayTop, daylight), t);
            // Warm sunrise/sunset band hugging the horizon
            float dusk = smoothstep(0.35, 0.0, abs(sunH)) * (1.0 - t);
            col += vec3(0.55, 0.22, 0.05) * dusk * 0.8;
            // Sun disc + halo (bright enough for the bloom pass to pick up)
            vec2 sunP = vec2(mix(60.0, 740.0, clamp(dayT * 2.0, 0.0, 1.0)), 310.0 + 265.0 * max(sunH, 0.0));
            float sd = distance(coord, sunP);
            col += vec3(1.0, 0.9, 0.6) * (smoothstep(16.0, 6.0, sd) * 1.2 + smoothstep(90.0, 10.0, sd) * 0.25) * daylight;
            // Twinkling stars after dark
            float st = hash(floor(coord / 2.0) * 2.0);
            if (st > 0.9965) {
                float tw = 0.6 + 0.4 * sin(u_time * (2.0 + st * 8.0) + st * 40.0);
                col += vec3(0.9) * tw * (1.0 - daylight);
            }
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
        // Depth-graded water: the hydrostatic head channel doubles as a depth
        // estimate, darkening deep columns; caustic light bands fade with
        // depth, fast flow whitens to foam, and the surface layer sparkles.
        float depth = clamp(cell.a / 60.0, 0.0, 1.0);
        vec3 waterCol = mix(vec3(0.20, 0.55, 0.90), vec3(0.05, 0.22, 0.50), depth);
        float ca = sin(coord.x * 0.11 + u_time * 1.6) *
                   sin(coord.x * 0.053 - u_time * 1.1 + coord.y * 0.05);
        waterCol += vec3(0.10, 0.14, 0.16) * max(ca, 0.0) * (1.0 - depth);
        if (abs(cell.g) > 0.5) {
            waterCol = mix(waterCol, vec3(0.75, 0.88, 0.97), 0.45); // rapids foam
        }
        if (cell.a < 3.0) {
            float sp = hash(coord + floor(u_time * 8.0));
            if (sp > 0.985) waterCol += vec3(0.5); // surface glints
        }
        col = waterCol + noise * 0.25;
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
    } else if (mat == MAT_LAVA) {
        // Molten rock: incandescent orange while hot (G = heat), darkening
        // toward a dull crusting red as the surface radiates away
        float heat = clamp(cell.g, 0.0, 1.0);
        vec3 molten = vec3(1.00, 0.55, 0.10);
        vec3 crust  = vec3(0.42, 0.10, 0.06);
        col = mix(crust, molten, 0.25 + 0.75 * heat);
        col += vec3(0.14, 0.06, 0.0) * sin(u_time * 3.0 + hash(coord * 0.8) * 6.283) * heat;
        col += noise * 0.3;
    } else if (mat == MAT_OIL) {
        // Crude oil: near-black glossy slick with an iridescent sheen
        col = vec3(0.11, 0.09, 0.07);
        float sheen = hash(coord * 2.1);
        col += vec3(0.06, 0.04, 0.10) * smoothstep(0.75, 1.0, sheen);
        col += sin(coord.x * 0.2 + u_time * 1.5) * 0.015;
    } else if (mat == MAT_FIRE) {
        // Flame: flickers yellow->orange->red as fuel (G) burns down
        float fuel = clamp(cell.g, 0.0, 1.0);
        float flicker = hash(coord + floor(u_time * 18.0));
        col = mix(vec3(0.85, 0.20, 0.05), vec3(1.0, 0.85, 0.30), fuel * (0.6 + 0.4 * flicker));
    } else if (mat == MAT_OBSIDIAN) {
        // Quenched volcanic glass: dark violet-black with glassy facets
        vec3 base = vec3(0.13, 0.09, 0.19);
        float facet = hash(coord * 1.3);
        col = base + vec3(0.16, 0.12, 0.24) * smoothstep(0.82, 1.0, facet);
        col += noise * 0.4;
    }

    // Ballistic ordnance bodies (spinning circular rigid projectiles).
    // w packs kind*10 + rotation angle: 0 TNT/bomblet, 2 balloon, 3 drill,
    // 4 cluster shell, 5 nuke, 6 sticky charge.
    for (int i = 0; i < 24; i++) {
        if (i >= u_projectileCount) break;
        vec4 p = u_projectiles[i];
        float d = distance(coord, p.xy);
        if (d > p.z + 1.5) continue;

        float kind = floor(p.w / 10.0 + 0.001);
        float ang = p.w - kind * 10.0;
        vec2 spin = vec2(cos(ang), sin(ang));
        vec2 off = coord - p.xy;

        vec3 bodyCol;
        if (kind < 0.5) {
            // Live TNT / bomblet: red drum; the rotation-locked stripe and fuse
            // make the sphere visibly roll and tumble
            bodyCol = vec3(0.78, 0.16, 0.12);
            if (abs(dot(off, vec2(-spin.y, spin.x))) < 1.3 && d <= p.z) {
                bodyCol = vec3(0.5, 0.09, 0.07); // rotating stripe
            }
            if (distance(coord, p.xy + spin * p.z * 0.85) < 2.0 && mod(u_time * 6.0, 2.0) < 1.0) {
                bodyCol = vec3(1.0, 0.9, 0.35); // fuse spark at the rotating cap
            }
        } else if (kind < 2.5) {
            // Water balloon: glossy cyan membrane
            bodyCol = vec3(0.25, 0.75, 0.95);
            if (distance(coord, p.xy + vec2(-p.z * 0.35, p.z * 0.35)) < p.z * 0.3) {
                bodyCol = vec3(0.7, 0.95, 1.0); // specular highlight
            }
        } else if (kind < 3.5) {
            // Bunker-buster drill: steel body, hardened nose cone locked to the
            // heading (angle carries velocity direction, not spin)
            bodyCol = vec3(0.60, 0.63, 0.69);
            if (dot(off, spin) > d * 0.45) {
                bodyCol = vec3(0.30, 0.32, 0.38); // nose cone
            }
            if (abs(dot(off, vec2(-spin.y, spin.x))) < 1.0 && d <= p.z) {
                bodyCol = vec3(0.82, 0.60, 0.20); // brass drive band
            }
        } else if (kind < 4.5) {
            // Cluster shell: orange casing with a dark split seam
            bodyCol = vec3(0.94, 0.55, 0.13);
            if (abs(dot(off, vec2(-spin.y, spin.x))) < 1.2 && d <= p.z) {
                bodyCol = vec3(0.45, 0.25, 0.06); // seam that pops open
            }
        } else if (kind < 5.5) {
            // Nuke: yellow casing with rotation-locked black hazard bands
            bodyCol = vec3(0.93, 0.83, 0.20);
            float band = dot(off, vec2(-spin.y, spin.x));
            if (mod(band + 100.0, 6.0) < 2.2 && d <= p.z) {
                bodyCol = vec3(0.10, 0.10, 0.10);
            }
            if (distance(coord, p.xy + spin * p.z * 0.85) < 2.2 && mod(u_time * 8.0, 2.0) < 1.0) {
                bodyCol = vec3(1.0, 0.95, 0.5); // fast fuse strobe
            }
        } else {
            // Sticky charge: green gel blob, pulsing while armed
            float pulse = 0.5 + 0.5 * sin(u_time * 8.0);
            bodyCol = mix(vec3(0.22, 0.55, 0.20), vec3(0.45, 0.90, 0.35), pulse);
            if (distance(coord, p.xy + vec2(-p.z * 0.35, p.z * 0.35)) < p.z * 0.3) {
                bodyCol = vec3(0.75, 1.0, 0.65); // wet highlight
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

// ---- Post-processing chain ---------------------------------------------------
// scene (offscreen) -> bright extract (half res) -> separable gaussian blur x2
// -> composite to canvas. The blurred bright texture serves double duty: added
// back as bloom AND used as a 2D emissive light map that re-lights the dark
// underground around lava, fire, and explosions.

export const fsExtractSource = `#version 300 es
precision highp float;
uniform sampler2D u_scene;
in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec3 c = texture(u_scene, v_uv).rgb;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    float w = smoothstep(0.62, 0.95, l);   // soft-knee bright pass
    fragColor = vec4(c * w, 1.0);
}
`;

export const fsBlurSource = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_dir;   // (1/w, 0) or (0, 1/h)
in vec2 v_uv;
out vec4 fragColor;

void main() {
    // 5-tap linearly-sampled 9-wide gaussian
    vec3 acc = texture(u_tex, v_uv).rgb * 0.2270270270;
    vec2 o1 = u_dir * 1.3846153846;
    vec2 o2 = u_dir * 3.2307692308;
    acc += texture(u_tex, v_uv + o1).rgb * 0.3162162162;
    acc += texture(u_tex, v_uv - o1).rgb * 0.3162162162;
    acc += texture(u_tex, v_uv + o2).rgb * 0.0702702703;
    acc += texture(u_tex, v_uv - o2).rgb * 0.0702702703;
    fragColor = vec4(acc, 1.0);
}
`;

export const fsCompositeSource = `#version 300 es
precision highp float;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform sampler2D u_state;
uniform vec2 u_resolution;
uniform float u_time;
in vec2 v_uv;
out vec4 fragColor;

#define MAT_AIR  0.0
#define MAT_LAVA 6.0
#define MAT_FIRE 8.0

float matAt(vec2 px) {
    if (px.x < 0.0 || px.x >= u_resolution.x || px.y < 0.0 || px.y >= u_resolution.y) return MAT_AIR;
    return texture(u_state, (px + 0.5) / u_resolution).r;
}

void main() {
    vec2 px = floor(gl_FragCoord.xy);
    float mHere = matAt(px);

    // Heat haze: hot cells just below wobble the sampled scene UV
    float haze = 0.0;
    for (int i = 1; i <= 3; i++) {
        float m = matAt(px - vec2(0.0, float(i) * 4.0));
        if (m == MAT_LAVA || m == MAT_FIRE) haze += 1.0;
    }
    vec2 uv = v_uv;
    if (haze > 0.0 && mHere == MAT_AIR) {
        uv.x += sin(px.y * 0.35 + u_time * 7.0) * (0.8 * haze) / u_resolution.x;
        uv.y += sin(px.x * 0.30 + u_time * 5.0) * (0.4 * haze) / u_resolution.y;
    }

    vec3 scene = texture(u_scene, uv).rgb;
    vec3 bloom = texture(u_bloom, uv).rgb;

    // Day-night factor (mirrors the sky pass formula in fsRenderSource)
    float dayT = fract(u_time / 180.0);
    float sunH = sin(dayT * 6.2832);
    float daylight = smoothstep(-0.18, 0.25, sunH);

    // 2D lighting: ambient dims underground (and at night on the surface);
    // the blurred emissive texture re-lights nearby terrain like firelight.
    float bloomLuma = dot(bloom, vec3(0.299, 0.587, 0.114));
    float underground = smoothstep(312.0, 288.0, px.y);
    float ambient = mix(mix(0.78, 1.0, daylight), 0.62, underground);
    float light = clamp(ambient + bloomLuma * 1.8, 0.0, 1.35);
    vec3 col = scene * light;

    // God rays: sky pixels march toward the sun accumulating open-air
    // visibility, so towers and dust-choked craters carve visible shafts.
    if (mHere == MAT_AIR && px.y >= 300.0 && daylight > 0.05) {
        vec2 sunP = vec2(mix(60.0, 740.0, clamp(dayT * 2.0, 0.0, 1.0)), 310.0 + 265.0 * max(sunH, 0.0));
        vec2 toSun = sunP - px;
        float dSun = length(toSun);
        if (dSun > 1.0 && dSun < 600.0) {
            vec2 stepv = toSun / 12.0;
            float vis = 0.0;
            for (int i = 1; i <= 11; i++) {
                if (matAt(px + stepv * float(i)) == MAT_AIR) vis += 1.0;
            }
            vis /= 11.0;
            col += vec3(1.0, 0.92, 0.7) * pow(vis, 3.0) * smoothstep(600.0, 80.0, dSun) * 0.14 * daylight;
        }
    }

    // Additive glow, then a soft vignette
    col += bloom * 0.85;
    vec2 vc = v_uv - 0.5;
    col *= 1.0 - dot(vc, vc) * 0.55;

    fragColor = vec4(col, 1.0);
}
`;

// ---- Render-only FX particles (smoke / embers / sparks) ---------------------
// Purely cosmetic: never enter the conservation grid. Drawn into the scene
// FBO so bloom and the light map pick them up.

export const vsFxSource = `#version 300 es
layout(location = 0) in vec4 a_p;   // (x, y, type, lifeFrac)
uniform vec2 u_resolution;
flat out float v_type;
flat out float v_life;

void main() {
    v_type = a_p.z;
    v_life = a_p.w;
    vec2 clip = (a_p.xy / u_resolution) * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
    gl_PointSize = a_p.z < 0.5 ? mix(3.0, 9.0, 1.0 - a_p.w)   // smoke grows as it ages
                 : a_p.z < 1.5 ? 2.0                            // ember
                 : 1.5;                                          // spark
}
`;

export const fsFxSource = `#version 300 es
precision highp float;
flat in float v_type;
flat in float v_life;
out vec4 fragColor;

void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    if (v_type < 0.5) {
        // Smoke: soft translucent puff (alpha blended)
        float a = max(0.0, (0.28 - r2 * 0.9)) * v_life * 0.55;
        fragColor = vec4(0.55, 0.53, 0.52, a);
    } else if (v_type < 1.5) {
        // Ember: hot orange fleck (additive)
        fragColor = vec4(vec3(1.0, 0.45, 0.10) * v_life, 1.0);
    } else {
        // Spark: white-hot chip (additive)
        fragColor = vec4(vec3(1.0, 0.85, 0.45) * v_life, 1.0);
    }
}
`;
