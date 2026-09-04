// AUTO-WRAPPED GLSL — do not fetch this as a raw .glsl asset.
//
// The SandPlayground page is routed at /sandplayground, so a relative shader fetch
// would resolve against the route rather than the app root,
// and 404. Shipping the shader source as an ES module also keeps it inside the
// module graph, so it is fingerprinted and cached with the engine instead of
// arriving as a second, uncacheable round-trip.
//
// Sections are delimited by `//====== NAME ======` and split by parseSections()
// in sand-playground-engine.js.
export const source = `
//====== VERTEX ======
#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}

//====== RENDER ======
#version 300 es
// Scene pass: material shading (wetness, strata, scorch, vitrified glass),
// water flow shimmer + refraction + caustics, micro-relief and ambient
// occlusion, column-depth ambience (dark caverns) and the propagated dynamic
// light field. Renders into the scene FBO; alpha carries the emissive mask
// that drives the bloom chain. Distortion/shake/tonemap live in COMPOSITE.
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform sampler2D u_light;    // half-res propagated light field
uniform sampler2D u_heights;  // 800x1: column surface height / 600
uniform float u_time;
in vec2 v_uv;
out vec4 outColor;

const int W = 800;
const int H = 600;
const int AIR = 0, SAND = 1, CONCRETE = 2, WATER = 3, BEDROCK = 4;
const float COHESION_THRESH = 0.25;

vec4 get(ivec2 p) {
    if (p.y < 0) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.x < 0 || p.x >= W || p.y >= H) return vec4(0.0);
    return texelFetch(u_state, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
bool solidM(int m) { return m == SAND || m == CONCRETE || m == BEDROCK; }
float wetOf(vec4 c) {
    if (matOf(c) != SAND) return 0.0;
    float rb = floor(c.r * 255.0 + 0.5);
    if (rb >= 85.0) return 20.0;
    float w = rb - 60.0;
    return (w <= 20.0) ? w : 0.0;
}
float shockOf(vec4 c) { return matOf(c) == AIR ? c.b : 0.0; }

float waterMask(ivec2 p) { return matOf(get(p)) == WATER ? 1.0 : 0.0; }
vec2 waterNormal(ivec2 p) {
    float gx = waterMask(p + ivec2(-2, 0)) + 2.0 * waterMask(p + ivec2(-1, 0))
             - waterMask(p + ivec2( 2, 0)) - 2.0 * waterMask(p + ivec2( 1, 0));
    float gy = waterMask(p + ivec2(0, -2)) + 2.0 * waterMask(p + ivec2(0, -1))
             - waterMask(p + ivec2(0,  2)) - 2.0 * waterMask(p + ivec2(0,  1));
    return normalize(vec2(gx, gy) + vec2(0.0, 0.001));
}

float hash(vec2 q) {
    return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
    ivec2 p = ivec2(v_uv * vec2(float(W), float(H)));
    p = clamp(p, ivec2(0), ivec2(W - 1, H - 1));

    vec4 self = get(p);
    int m = matOf(self);
    float g = hash(vec2(p) * 0.7131); // static per-position grain seed

    vec4 up = get(p + ivec2(0, 1));
    vec4 dn = get(p + ivec2(0, -1));
    vec4 lf = get(p + ivec2(-1, 0));
    vec4 rt = get(p + ivec2(1, 0));
    int mu = matOf(up), md = matOf(dn), ml = matOf(lf), mr = matOf(rt);

    float speck = floor(g * 3.0) / 2.0; // 0, 0.5, 1.0

    // How deep this cell sits below its column's ground surface (0 = open).
    float colTop = texture(u_heights, vec2((float(p.x) + 0.5) / float(W), 0.5)).r * float(H);
    float depthBelow = max(0.0, colTop - float(p.y));

    vec3 col;
    float emis = 0.0; // emissive mask -> bloom

    if (m == AIR) {
        float t = float(p.y) / float(H - 1);
        t = floor(t * 24.0) / 23.0;
        col = mix(vec3(0.76, 0.88, 0.94), vec3(0.25, 0.44, 0.72), clamp(pow(t, 1.6), 0.0, 1.0));
        if (mod(float(p.x + p.y * 2), 4.0) < 1.0) col *= 0.985;
        // Smoke/dust haze and white steam.
        float gg = self.g;
        if (gg >= 136.0 / 255.0) {
            float st = clamp((gg - 0.5) * 2.2, 0.0, 0.85);
            col = mix(col, vec3(0.93, 0.95, 0.97), st);
            emis += st * 0.12;
        } else if (gg > 0.01) {
            col = mix(col, vec3(0.36, 0.34, 0.32), clamp(gg * 2.0, 0.0, 0.7));
        }
        // Underground air reads as dark cavern space, not sky.
        if (depthBelow > 1.0) {
            float cave = 1.0 - exp(-depthBelow / 24.0);
            vec3 caveCol = vec3(0.072, 0.068, 0.084) * (0.8 + 0.5 * g);
            col = mix(col, caveCol, cave * 0.94);
        }
        // Sub-cell volume reconstruction: an air notch supported by water
        // below and beside it is the upper fraction of the free surface, not
        // a square hole. This visually preserves thin sheets and menisci while
        // the conservative occupancy grid remains one-material-per-cell.
        float partialWater = waterMask(p + ivec2(0, -1)) *
            (0.28 + 0.22 * max(waterMask(p + ivec2(-1, 0)), waterMask(p + ivec2(1, 0))));
        col = mix(col, vec3(0.30, 0.62, 0.82), partialWater);
    } else if (m == SAND) {
        float rb = floor(self.r * 255.0 + 0.5);
        float depth = clamp(1.0 - float(p.y) / 360.0, 0.0, 1.0);
        col = mix(vec3(0.78, 0.60, 0.33), vec3(0.47, 0.34, 0.19), depth * 0.55);
        // Geology strata: clay band and bedrock-adjacent gravel.
        float band1 = 120.0 + 18.0 * sin(float(p.x) * 0.011 + 2.1);
        float band2 = 45.0 + 12.0 * sin(float(p.x) * 0.017);
        if (float(p.y) < band2) col = mix(col, vec3(0.42, 0.40, 0.38), 0.45 + 0.2 * speck);
        else if (float(p.y) < band1) col = mix(col, vec3(0.55, 0.38, 0.28), 0.4);
        col *= 0.90 + 0.14 * speck;
        if (self.a < COHESION_THRESH) col *= 1.10;
        // Damp sand reads darker and slightly richer.
        float wet = wetOf(self) / 20.0;
        float shore = max(max(waterMask(p + ivec2(-1, 0)), waterMask(p + ivec2(1, 0))),
                          max(waterMask(p + ivec2(0, 1)), waterMask(p + ivec2(0, 2)) * 0.55));
        wet = max(wet, shore * 0.72);
        col = mix(col, col * vec3(0.62, 0.60, 0.66), wet);
        if (mu == AIR) col = mix(col, vec3(0.95, 0.83, 0.55) * (1.0 - 0.35 * wet), 0.55);
        if (mu == AIR && wet > 0.15) {
            float wetSpec = pow(max(0.0, sin(float(p.x) * 0.09 + u_time * 0.35)), 18.0);
            col += vec3(0.10, 0.13, 0.14) * wetSpec * wet;
        }
        // Submerged bed: dancing caustic light filtering through the water.
        if (mu == WATER) {
            float wdep = clamp(up.a * 255.0 / 34.0, 0.0, 1.0);
            float ph = float(p.x);
            float ca = sin(ph * 0.31 + u_time * 2.2)
                     + 0.6 * sin(ph * 0.113 - u_time * 1.45)
                     + 0.45 * sin(ph * 0.52 + u_time * 3.1);
            col += vec3(0.18, 0.34, 0.38) * max(0.0, ca - 1.15) * (1.0 - 0.85 * wdep);
            col = mix(col, col * vec3(0.72, 0.80, 0.92), 0.35);
        }
        // Scorched blast debris: ember red, cooling back to sand over time.
        float sc = self.g;
        if (sc > 0.02) {
            col = mix(col, mix(vec3(0.82, 0.22, 0.10), vec3(1.0, 0.45, 0.14), sc), sc * 0.85);
            emis += sc * 0.8;
        }
        // Saturated ground: pore water darkens it and adds a wet sheen.
        if (rb >= 85.0) {
            col = mix(col, vec3(0.20, 0.24, 0.30), 0.45);
            if (mu == AIR) col = mix(col, vec3(0.42, 0.52, 0.60), 0.35);
        }
        // Vitrified blast lining: dark glassy sheen.
        if (rb >= 81.0 && rb <= 84.0) {
            col = mix(col, vec3(0.30, 0.48, 0.44), 0.7) * (0.9 + 0.25 * speck);
            emis += 0.06;
        }
    } else if (m == WATER) {
        float vx = (self.g * 255.0 - 128.0) / 62.0;
        float vyv = (self.b * 255.0 - 128.0) / 62.0;
        float speed = clamp(length(vec2(vx, vyv)), 0.0, 2.0);
        // Hydrostatic pressure = real depth below the connected surface.
        float depth = clamp(self.a * 255.0 / 45.0, 0.0, 1.0);
        vec2 normal = waterNormal(p);
        float surface = float(mu != WATER || ml != WATER || mr != WATER);
        // Beer-Lambert absorption in metres: red disappears first, leaving
        // deep water blue-green without painting an arbitrary depth ramp.
        float metres = self.a * 255.0 * 0.025;
        vec3 transmittance = exp(-vec3(0.42, 0.16, 0.075) * metres);
        vec3 shallow = vec3(0.18, 0.52, 0.72);
        vec3 deep = vec3(0.018, 0.075, 0.16);
        col = deep + shallow * transmittance;
        // Refraction follows the reconstructed surface normal and local flow.
        vec2 roff = normal * (1.2 + depth * 3.5) + vec2(vx, vyv) * 1.7;
        int rm = matOf(get(p + ivec2(roff)));
        if (rm == SAND) col = mix(col, vec3(0.40, 0.34, 0.24), 0.28);
        else if (rm == CONCRETE) col = mix(col, vec3(0.35, 0.38, 0.42), 0.25);
        // Interior caustic bands near the surface.
        if (depth < 0.55) {
            float ca = sin(float(p.x) * 0.21 + u_time * 1.8 + float(p.y) * 0.06)
                     + 0.7 * sin(float(p.x) * 0.083 - u_time * 1.15);
            col += vec3(0.08, 0.20, 0.24) * max(0.0, ca - 0.95) * (1.0 - depth / 0.55);
        }
        float curvature = abs(waterMask(p + ivec2(-1, 0)) + waterMask(p + ivec2(1, 0))
                            + waterMask(p + ivec2(0, -1)) + waterMask(p + ivec2(0, 1)) - 3.0);
        float foam = surface * smoothstep(0.35, 1.35, speed + curvature * 0.18);
        col = mix(col, vec3(0.72, 0.86, 0.94), foam * 0.72);
        // Bed contact under energetic flow entrains a visible turbidity veil.
        float bedContact = float(md == SAND || ml == SAND || mr == SAND);
        col = mix(col, vec3(0.34, 0.29, 0.20), bedContact * smoothstep(0.25, 1.1, speed) * 0.35);
        // Animated sparkle, advected with the flow.
        float sp = fract(g * 91.7 + u_time * (0.35 + speed * 0.5) + float(p.x) * 0.013 - vx * 1.7);
        if (sp > 0.96) { col = mix(col, vec3(0.62, 0.85, 0.98), 0.8); emis += 0.10; }
        // Free surface: bright rim with a moving glint (cheap Fresnel).
        if (mu == AIR) {
            float glint = 0.75 + 0.25 * sin(float(p.x) * 0.35 + u_time * 2.4 + g * 6.28);
            float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(normal.y, 0.0, 1.0), 5.0);
            vec3 skyReflection = mix(vec3(0.32, 0.58, 0.82), vec3(0.92, 0.97, 1.0), glint);
            col = mix(col, skyReflection, clamp(fresnel + 0.18, 0.0, 0.82));
            emis += 0.12 * glint;
        } else if (ml == AIR || mr == AIR) {
            col = mix(col, vec3(0.55, 0.80, 0.95), 0.4);
        }
    } else if (m == CONCRETE) {
        col = vec3(0.60, 0.63, 0.67);
        col *= 0.92 + 0.10 * speck;
        if (mu != CONCRETE || md != CONCRETE || ml != CONCRETE || mr != CONCRETE)
            col *= 0.55;
        if ((p.x + p.y) % 7 == 0) col *= 0.88;
        if (mu == AIR) col += vec3(0.06);
    } else { // BEDROCK
        col = vec3(0.23, 0.24, 0.27);
        if ((p.x / 4 + p.y / 4) % 2 == 0) col *= 1.12;
        if (mu != BEDROCK) col = mix(col, vec3(0.42, 0.40, 0.36), 0.6);
    }

    // Micro-relief + ambient occlusion for granular solids.
    if (m == SAND || m == CONCRETE) {
        int nsolid = (solidM(mu) ? 1 : 0) + (solidM(md) ? 1 : 0)
                   + (solidM(ml) ? 1 : 0) + (solidM(mr) ? 1 : 0);
        col *= 1.08 - 0.05 * float(nsolid);          // enclosed cells read darker
        if (!solidM(ml) && solidM(mr)) col *= 1.05;  // key light from upper-left
        else if (!solidM(mr) && solidM(ml)) col *= 0.97;
    }

    // Depth ambience + propagated dynamic light.
    vec3 light = texture(u_light, v_uv).rgb;
    float llum = dot(light, vec3(0.35, 0.45, 0.2));
    if (m == AIR) {
        col += light * 0.55;
        emis += llum * 0.45;
    } else {
        float amb = 0.34 + 0.66 * exp(-depthBelow / 110.0);
        col *= amb;
        col += col * light * 1.7 + light * 0.16;
        emis += llum * 0.35;
    }

    // Acoustic blast flash rings.
    float s = shockOf(self);
    float ns = max(max(shockOf(up), shockOf(dn)), max(shockOf(lf), shockOf(rt)));
    if (s > 0.02) {
        col = mix(col, vec3(1.0, 0.62, 0.18), smoothstep(0.05, 0.35, s));
        col = mix(col, vec3(1.0, 0.93, 0.62), smoothstep(0.35, 0.62, s));
        col = mix(col, vec3(1.0), smoothstep(0.62, 0.9, s));
        emis += smoothstep(0.05, 0.6, s);
    } else if (ns > 0.15 && m != AIR) {
        col = mix(col, vec3(1.0, 0.72, 0.30), min(ns, 1.0) * 0.55);
        emis += min(ns, 1.0) * 0.35;
    }

    outColor = vec4(col, clamp(emis, 0.0, 1.0));
}

//====== LIGHT ======
#version 300 es
// Dynamic 2D light field (half res, ping-pong). Emission comes from blast
// shock cells and red-hot scorched sand, plus a handful of CPU point lights
// (lit fuses, fresh explosions, hot ejecta). Each step diffuses the previous
// field through the world with per-material attenuation, so explosions light
// up caverns and glow fades through overburden.
precision highp float;
precision highp int;

uniform sampler2D u_state;   // full-res sim state
uniform sampler2D u_prev;    // previous light field (target res)
uniform vec4 u_lights[8];    // x, y (sim px), radius, intensity
uniform int u_nlights;
in vec2 v_uv;
out vec4 outColor;

void main() {
    vec2 texel = vec2(1.0 / 400.0, 1.0 / 300.0);
    vec4 s = texture(u_state, v_uv);
    int m = (int(floor(s.r * 255.0 + 0.5)) + 30) / 60;

    vec3 E = vec3(0.0);
    if (m == 0) { // air: shock flash (steam excluded)
        if (s.g < 136.0 / 255.0) E += vec3(1.0, 0.55, 0.22) * smoothstep(0.03, 0.6, s.b) * 1.2;
    } else if (m == 1) { // sand: cooling embers
        E += vec3(1.0, 0.28, 0.08) * s.g * 0.9;
    }

    vec2 px = v_uv * vec2(800.0, 600.0);
    for (int i = 0; i < 8; i++) {
        if (i >= u_nlights) break;
        vec4 L = u_lights[i];
        float d = distance(px, L.xy);
        E += vec3(1.0, 0.72, 0.4) * L.w * exp(-d * d / (L.z * L.z));
    }

    vec3 c = texture(u_prev, v_uv).rgb;
    vec3 n = texture(u_prev, v_uv + vec2(texel.x, 0.0)).rgb
           + texture(u_prev, v_uv - vec2(texel.x, 0.0)).rgb
           + texture(u_prev, v_uv + vec2(0.0, texel.y)).rgb
           + texture(u_prev, v_uv - vec2(0.0, texel.y)).rgb;
    vec3 diff = c * 0.4 + n * 0.15;
    float occl = (m == 1 || m == 2 || m == 4) ? 0.80 : (m == 3 ? 0.93 : 0.975);
    outColor = vec4(clamp(max(E, diff * occl * 0.985), 0.0, 1.0), 1.0);
}

//====== BRIGHT ======
#version 300 es
// Bloom bright-pass: keyed on the scene's emissive mask (alpha) plus a
// conservative pure-luminance knee for the very brightest pixels.
precision highp float;
uniform sampler2D u_scene;
in vec2 v_uv;
out vec4 outColor;
void main() {
    vec4 s = texture(u_scene, v_uv);
    float l = dot(s.rgb, vec3(0.299, 0.587, 0.114));
    outColor = vec4(s.rgb * (s.a * 1.15 + smoothstep(0.93, 1.06, l) * 0.35), 1.0);
}

//====== BLUR ======
#version 300 es
// Separable 5-tap gaussian (bilinear-optimized offsets).
precision highp float;
uniform sampler2D u_scene;
uniform vec2 u_dir;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 outColor;
void main() {
    vec2 o = u_dir * u_texel;
    vec3 c = texture(u_scene, v_uv).rgb * 0.227027;
    c += (texture(u_scene, v_uv + o * 1.3846).rgb + texture(u_scene, v_uv - o * 1.3846).rgb) * 0.3162162;
    c += (texture(u_scene, v_uv + o * 3.2308).rgb + texture(u_scene, v_uv - o * 3.2308).rgb) * 0.0702703;
    outColor = vec4(c, 1.0);
}

//====== COMPOSITE ======
#version 300 es
// Final composite: screen shake, expanding shock-ring refraction, bloom,
// blast flash, vignette, film grain, ACES tonemap.
precision highp float;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform vec4 u_rings[4];   // x, y (sim px), radius, amplitude (px)
uniform int u_nrings;
uniform vec2 u_shake;      // sim px
uniform float u_flash;
uniform float u_time;
in vec2 v_uv;
out vec4 outColor;

float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123); }

vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
    vec2 res = vec2(800.0, 600.0);
    vec2 uv = v_uv + u_shake / res;
    vec2 px = uv * res;
    for (int i = 0; i < 4; i++) {
        if (i >= u_nrings) break;
        vec4 r = u_rings[i];
        vec2 d = px - r.xy;
        float dist = max(length(d), 0.6);
        float w = exp(-pow(dist - r.z, 2.0) / 260.0);
        uv += (d / dist) * (w * r.w) / res;
    }
    vec3 col = texture(u_scene, uv).rgb;
    col += texture(u_bloom, uv).rgb * 0.85;
    col += vec3(1.0, 0.86, 0.62) * u_flash;
    vec2 vd = v_uv - 0.5;
    col *= 1.0 - dot(vd, vd) * 0.5;
    col += (hash(v_uv * 613.7 + fract(u_time * 0.7) * 17.0) - 0.5) * 0.02;
    outColor = vec4(aces(col * 1.05), 1.0);
}

//====== PVERTEX ======
#version 300 es
// Additive point-sprite particles (sparks, dust, mist, bubbles), positions
// in sim pixel coords (y-up), rendered 1:1 into the 800x600 scene FBO.
layout(location = 0) in vec2 a_pos;
layout(location = 1) in float a_size;
layout(location = 2) in vec4 a_col;
out vec4 v_col;
void main() {
    v_col = a_col;
    gl_PointSize = max(a_size, 1.5);
    gl_Position = vec4(a_pos / vec2(400.0, 300.0) - 1.0, 0.0, 1.0);
}

//====== PFRAG ======
#version 300 es
precision mediump float;
in vec4 v_col;
out vec4 outColor;
void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = max(0.0, 1.0 - dot(d, d) * 4.0);
    a *= a;
    outColor = vec4(v_col.rgb * v_col.a * a, v_col.a * a * 0.9);
}
`;
