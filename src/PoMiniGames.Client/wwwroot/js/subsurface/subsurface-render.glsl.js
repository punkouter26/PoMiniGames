// WebGL 2.0 Retro Pixel-Art Palette & Shockwave Visualizer Render Shader
// Sub-Surface Multi-Material Engine

export const fsRenderSource = `#version 300 es
precision highp float;

uniform sampler2D u_stateTexture;
uniform vec2 u_resolution;       // (800.0, 600.0)
uniform float u_time;
uniform vec4 u_shockwave;        // (x, y, radius, intensity)

in vec2 v_uv;
out vec4 fragColor;

#define MAT_AIR       0.0
#define MAT_SAND      1.0
#define MAT_CONCRETE  2.0
#define MAT_WATER     3.0
#define MAT_BEDROCK   4.0

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
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
            // Retro arcade twilight sky
            col = mix(vec3(0.08, 0.12, 0.22), vec3(0.05, 0.07, 0.14), t);
            // Distant subtle stars
            if (hash(coord * 0.9) > 0.996) {
                col += vec3(0.4, 0.5, 0.7);
            }
        } else {
            // Dark underground excavated cavern void
            col = vec3(0.06, 0.05, 0.09) + noise * 0.5;
        }
    } else if (mat == MAT_SAND) {
        // Warm cohesive sand pixel palette with organic grain variation
        vec3 sandLight = vec3(0.76, 0.61, 0.38);
        vec3 sandDark  = vec3(0.56, 0.39, 0.20);
        float pattern = hash(coord * 1.5);
        col = mix(sandDark, sandLight, pattern) + noise;
    } else if (mat == MAT_CONCRETE) {
        // Reinforced concrete bar with rebar grid texture
        vec3 concreteBase = vec3(0.55, 0.60, 0.68);
        if (mod(coord.x, 6.0) < 1.0 || mod(coord.y, 6.0) < 1.0) {
            concreteBase = vec3(0.38, 0.42, 0.48); // Rebar hatch lines
        }
        col = concreteBase + noise * 0.7;
    } else if (mat == MAT_WATER) {
        // Vibrant arcade fluid cyan/blue with dynamic surface wave shimmer
        float wave = sin(coord.x * 0.15 + u_time * 4.0) * 0.05;
        vec3 waterCol = vec3(0.0, 0.71, 0.85) + wave;
        col = waterCol + noise * 0.3;
    } else if (mat == MAT_BEDROCK) {
        // Indestructible dark basalt bedrock
        vec3 basalt = vec3(0.17, 0.18, 0.26);
        if (mod(coord.x + coord.y, 4.0) < 1.0) {
            basalt = vec3(0.12, 0.13, 0.18);
        }
        col = basalt;
    }

    // Dynamic Acoustic Shockwave Flash Overlay
    if (u_shockwave.w > 0.0) {
        vec2 sPos = u_shockwave.xy;
        float sRadius = u_shockwave.z;
        float sIntensity = u_shockwave.w;
        float dist = distance(coord, sPos);

        // Flash expanding ring
        float ringWidth = 14.0;
        if (abs(dist - sRadius) < ringWidth) {
            float ringFactor = 1.0 - (abs(dist - sRadius) / ringWidth);
            vec3 flashCol = vec3(1.0, 0.85, 0.3) * ringFactor * sIntensity;
            col += flashCol;
        } else if (dist < sRadius) {
            // Core fireball fade
            col += vec3(0.9, 0.35, 0.1) * 0.3 * sIntensity * (1.0 - dist / sRadius);
        }
    }

    fragColor = vec4(col, 1.0);
}
`;
