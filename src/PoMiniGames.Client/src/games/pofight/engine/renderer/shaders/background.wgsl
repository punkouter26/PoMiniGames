// Background Shader (Cyber Fog)
struct Uniforms {
    time: f32, // Offset 0
    padding: vec3<f32>,
    shockwave: vec4<f32>, // Offset 16 (unused here but needed for alignment match)
    glitch: f32, // Offset 32 (unused)
    screenSize: vec2<f32>, // Offset 36 (real layout I used in Renderer was packing screen at 36?)
    // In Renderer I wrote: time(0), sw(16), glitch(32), screen matches struct PostUniforms?
    // Let's check Renderer again.
    // postBufferCorrected[0] = time
    // [4..7] = sw
    // [8] = glitch
    // [9] = width, [10] = height.
    // Float index 9 = 36 bytes offset.
    // So yes, screen is at offset 36.
}

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
    // Fullscreen quad logic (same as post)
    var pos = vec2<f32>(0.0, 0.0);
    var uv = vec2<f32>(0.0, 0.0);
    switch vIdx {
        case 0u: { pos = vec2(-1.0, -1.0); uv = vec2(0.0, 1.0); }
        case 1u: { pos = vec2( 3.0, -1.0); uv = vec2(2.0, 1.0); }
        default: { pos = vec2(-1.0,  3.0); uv = vec2(0.0, -1.0); }
    }
    var output: VertexOutput;
    output.position = vec4<f32>(pos, 0.999, 1.0); // Depth check?
    output.uv = uv;
    return output;
}

// Simple Hash
fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// 2D Noise
fn noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// FBM
fn fbm(p: vec2<f32>) -> f32 {
    var v = 0.0;
    var a = 0.5;
    var shift = vec2(100.0);
    var rot = mat2x2<f32>(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
    var pp = p;
    for (var i = 0; i < 5; i++) {
        v += a * noise(pp);
        pp = rot * pp * 2.0 + shift;
        a *= 0.5;
    }
    return v;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let time = u.time * 0.2;
    // Base gradient
    let bg = mix(vec3(0.05, 0.05, 0.1), vec3(0.0, 0.0, 0.05), uv.y);
    
    // Moving Fog
    let q = vec2(fbm(uv * 3.0 + time * 0.1), fbm(uv * 5.0 - time * 0.1));
    let r = vec2(fbm(uv * 4.0 + 3.0 * q + vec2(1.7, 9.2) + 0.15 * time),
                 fbm(uv * 4.0 + 3.0 * q + vec2(8.3, 2.8) + 0.126 * time));
    let f = fbm(uv + r);

    // Colorize fog
    let color = mix(vec3(0.1, 0.1, 0.3), vec3(0.4, 0.2, 0.5), clamp((f * f) * 4.0, 0.0, 1.0));
    let color2 = mix(color, vec3(0.0, 0.5, 0.5), clamp(length(q), 0.0, 1.0));
    
    // Grid lines persective
    // Let's make a pseudo floor grid
    // Map UV to floor plane... simplistic approach
    let horizon = 0.3;
    var grid = 0.0;
    if (uv.y < horizon) {
        // Sky
    } else {
        // Floor
        // Checkered / Grid
        let floorUV = vec2(uv.x / (uv.y - horizon + 0.1), 1.0 / (uv.y - horizon + 0.1));
        // Moving floor
        let movingFloorUV = floorUV + vec2(0.0, time * 2.0);
        let g = step(0.9, fract(movingFloorUV.x * 2.0)) + step(0.9, fract(movingFloorUV.y * 2.0));
        grid = g * 0.1 * (uv.y - horizon); // Fade out at horizon
    }

    let finalColor = bg + color2 * 0.5 + vec3(0.0, 0.5, 1.0) * grid;

    return vec4(finalColor, 1.0);
}
