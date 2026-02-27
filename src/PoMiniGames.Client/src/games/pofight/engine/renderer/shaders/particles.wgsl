// Particle System Shader

struct Particle {
    pos: vec2<f32>,
    vel: vec2<f32>,
    life: f32,
    maxLife: f32,
    color: vec4<f32>,
    size: f32,
    pad: f32,
}

struct SimParams {
    dt: f32,
    gravity: f32,
    screenWidth: f32,
    screenHeight: f32,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

@compute @workgroup_size(64)
fn simulate(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= arrayLength(&particles)) {
        return;
    }

    var p = particles[index];

    if (p.life > 0.0) {
        // Physics
        p.vel.y += params.gravity * params.dt;
        p.pos += p.vel * params.dt;
        p.life -= params.dt;

        // Floor Bounce
        if (p.pos.y > params.screenHeight - 20.0) {
            p.pos.y = params.screenHeight - 20.0;
            p.vel.y *= -0.6; // Damping
        }

        particles[index] = p;
    }
}

// --- Rendering ---

struct Camera {
    viewProjection: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> camera: Camera;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
}

@vertex
fn vs_main(
    @builtin(vertex_index) vIdx: u32,
    @builtin(instance_index) iIdx: u32,
) -> VertexOutput {
    let p = particles[iIdx];
    
    // Degenerate triangle if dead
    if (p.life <= 0.0) {
        return VertexOutput(vec4(0.0), vec4(0.0));
    }

    // Billboard Quad
    var pos = vec2<f32>(0.0, 0.0);
    switch vIdx {
        case 0u: { pos = vec2(-0.5, -0.5); }
        case 1u: { pos = vec2(-0.5,  0.5); }
        case 2u: { pos = vec2( 0.5,  0.5); }
        case 3u: { pos = vec2(-0.5, -0.5); }
        case 4u: { pos = vec2( 0.5,  0.5); }
        default: { pos = vec2( 0.5, -0.5); }
    }

    let worldPos = p.pos + (pos * p.size);
    
    var output: VertexOutput;
    output.position = camera.viewProjection * vec4<f32>(worldPos, 0.0, 1.0);
    
    // Fade out over life
    output.color = p.color;
    output.color.a *= (p.life / p.maxLife);

    return output;
}

@fragment
fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
    return color;
}
