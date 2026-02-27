// Post-Processing / Fullscreen Shader

struct PostUniforms {
    time: f32,
    shockwaveParams: vec4<f32>, // x,y: center, z: time, w: amplitude
    glitchStrength: f32,
    screenSize: vec2<f32>,
}

@group(0) @binding(0) var myTexture: texture_2d<f32>;
@group(0) @binding(1) var mySampler: sampler;
@group(0) @binding(2) var<uniform> u: PostUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
    var pos = vec2<f32>(0.0, 0.0);
    var uv = vec2<f32>(0.0, 0.0);

    // Fullscreen Triangle
    // (-1, -1), (3, -1), (-1, 3) covers screen in clip space
    switch vIdx {
        case 0u: { pos = vec2(-1.0, -1.0); uv = vec2(0.0, 1.0); }
        case 1u: { pos = vec2( 3.0, -1.0); uv = vec2(2.0, 1.0); }
        default: { pos = vec2(-1.0,  3.0); uv = vec2(0.0, -1.0); }
    }

    var output: VertexOutput;
    output.position = vec4<f32>(pos, 0.0, 1.0);
    output.uv = uv;
    return output;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    var finalUV = uv;
    let time = u.time;

    // --- 1. Glitch / Data Mosh ---
    if (u.glitchStrength > 0.0) {
        // Random horizontal slice offset
        let sliceY = floor(uv.y * 20.0);
        let noise = fract(sin(dot(vec2(sliceY, time), vec2(12.9898, 78.233))) * 43758.5453);
        if (noise < u.glitchStrength) {
            finalUV.x += (fract(noise * 100.0) - 0.5) * 0.1;
        }
        // RGB Split Glitch
        let split = u.glitchStrength * 0.02;
        let r = textureSample(myTexture, mySampler, finalUV + vec2(split, 0.0)).r;
        let g = textureSample(myTexture, mySampler, finalUV).g;
        let b = textureSample(myTexture, mySampler, finalUV - vec2(split, 0.0)).b;
        return vec4(r, g, b, 1.0);
    }

    // --- 2. Shockwave Distortion ---
    // shockwaveParams: x=centerX, y=centerY (0-1), z=time since start, w=amplitude
    let swCenter = u.shockwaveParams.xy;
    let swTime = u.shockwaveParams.z;
    
    if (swTime >= 0.0 && swTime < 1.0) { // Active shockwave
        let dist = length(finalUV - swCenter);
        // Ring expands over time: radius = swTime * speed
        let radius = swTime * 0.8; 
        let width = 0.1;
        
        if (dist > radius && dist < radius + width) {
            let diff = dist - radius;
            let distortAmt = 1.0 - (diff / width); // 1 at inner edge, 0 at outer
            let distortVec = normalize(finalUV - swCenter) * distortAmt * 0.03 * (1.0 - swTime); // Fade out
            finalUV -= distortVec;
        }
    }

    // Curvature (Lens) - Subtle
    let dc = finalUV - 0.5;
    let dist2 = dot(dc, dc);
    finalUV = finalUV + dc * (dist2 * 0.05);

    // Bounds check after curvature
    if (finalUV.x < 0.0 || finalUV.x > 1.0 || finalUV.y < 0.0 || finalUV.y > 1.0) {
        return vec4(0.0, 0.0, 0.0, 1.0);
    }

    // --- 3. Sampling with Chromatic Aberration ---
    // Distance from center determines aberration strength
    let centerDist = length(finalUV - 0.5);
    let aberration = centerDist * 0.015;
    
    let r = textureSample(myTexture, mySampler, finalUV + vec2(aberration, 0.0)).r;
    let g = textureSample(myTexture, mySampler, finalUV).g;
    let b = textureSample(myTexture, mySampler, finalUV - vec2(aberration, 0.0)).b;
    var color = vec3(r, g, b);

    // --- 4. Simple Bloom (Glow) ---
    // Boost bright channels
    let brightness = dot(color, vec3(0.299, 0.587, 0.114));
    if (brightness > 0.7) {
        color += color * 0.6; // Simple additive glow
    }

    // --- 5. Scanlines ---
    // Sine wave pattern based on Y coord
    let scanline = sin((finalUV.y * u.screenSize.y) * 0.5 + time * 10.0) * 0.04;
    color -= scanline;

    // --- 6. Vignette ---
    let vignette = smoothstep(0.8, 0.2, centerDist);
    color *= vignette;

    return vec4(color, 1.0);
}
