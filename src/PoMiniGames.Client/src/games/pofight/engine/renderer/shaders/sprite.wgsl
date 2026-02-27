// Sprite Shader

struct Camera {
    viewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> camera: Camera;

struct Sprite {
    position: vec2<f32>,
    size: vec2<f32>,
    color: vec4<f32>,
    rotation: f32,
    velocity: vec2<f32>, // Mapped to offset 9, 10
    _pad: f32, 
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) worldPos: vec2<f32>,
    @location(3) velocity: vec2<f32>,
}

@vertex
fn vs_main(
    @builtin(vertex_index) vIdx: u32,
    @builtin(instance_index) iIdx: u32
) -> VertexOutput {
    let sprite = sprites[iIdx];

    // Standard quad vertices
    var pos = vec2<f32>(0.0, 0.0);
    var uv = vec2<f32>(0.0, 0.0);

    // 0: TL, 1: BL, 2: BR, 3: TL, 4: BR, 5: TR
    switch vIdx {
        case 0u: { pos = vec2(-0.5, -0.5); uv = vec2(0.0, 0.0); } // TL
        case 1u: { pos = vec2(-0.5,  0.5); uv = vec2(0.0, 1.0); } // BL
        case 2u: { pos = vec2( 0.5,  0.5); uv = vec2(1.0, 1.0); } // BR
        case 3u: { pos = vec2(-0.5, -0.5); uv = vec2(0.0, 0.0); } // TL
        case 4u: { pos = vec2( 0.5,  0.5); uv = vec2(1.0, 1.0); } // BR
        default: { pos = vec2( 0.5, -0.5); uv = vec2(1.0, 0.0); } // TR
    }

    // World Space
    var worldPos = sprite.position + (pos * sprite.size);

    var output: VertexOutput;
    output.position = camera.viewProjection * vec4<f32>(worldPos, 0.0, 1.0);
    output.color = sprite.color;
    output.uv = uv;
    output.worldPos = worldPos;
    // Pass velocity scaled for UV space blur
    // Velocity is in pixels. Sprite size is in pixels.
    // UV is 0..1.
    // If we move 10 pixels and size is 100 pixels, that is 0.1 UV units.
    output.velocity = sprite.velocity / sprite.size * 0.5; // Scale factor

    return output;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Basic Circle Shape with Fake Normal Map
    let center = vec2(0.5, 0.5);
    
    // Motion Blur Sampling
    var colorAcc = vec4(0.0);
    let samples = 5;
    
    for (var i = 0; i < samples; i++) {
        let t = f32(i) / f32(samples - 1);
        let offset = -in.velocity * t; // Trail behind
        let sampleUV = in.uv + offset;
        
        let dist = length(sampleUV - center);
        let alpha = 1.0 - smoothstep(0.45, 0.5, dist);
        
        if (alpha > 0.0) {
             colorAcc += in.color * alpha;
        }
    }
    
    let finalColor = colorAcc / f32(samples);
    if (finalColor.a <= 0.01) { discard; }

    return finalColor;
}
