struct Uniforms {
    exposure: f32,
    decay: f32,
    density: f32,
    weight: f32,
    lightPositionOnScreen: vec2<f32>,
    time: f32, // Added time for animation
}

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
    var pos = vec2<f32>(0.0, 0.0);
    var uv = vec2<f32>(0.0, 0.0);
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
    let NUM_SAMPLES = 50;
    
    var deltaTextCoord = vec2<f32>(uv - u.lightPositionOnScreen);
    let dist = length(deltaTextCoord);
    deltaTextCoord = (deltaTextCoord / dist) * u.density / f32(NUM_SAMPLES);
    
    var color = textureSample(sceneTexture, sceneSampler, uv);
    var illuminationDecay = 1.0;
    
    var coord = uv;
    
    for (var i = 0; i < NUM_SAMPLES; i++) {
        coord = coord - deltaTextCoord;
        let sample = textureSample(sceneTexture, sceneSampler, coord);
        
        // Use bright parts of the scene for rays
        // Simple threshold or just alpha?
        // Let's assume the texture passed in is the "occlusion" map where usually
        // light sources are white and occluders are black.
        // Or we can use the alpha channel / brightness.
        
        sample = sample * illuminationDecay * u.weight;
        color = color + sample;
        illuminationDecay = illuminationDecay * u.decay;
    }
    
    return color * u.exposure;
}
