struct Particle {
    pos: vec2<f32>,
    vel: vec2<f32>,
    density: f32,
    pressure: f32,
}

struct SimParams {
    dt: f32,
    gravity: f32,
    width: f32,
    height: f32,
    smoothingRadius: f32,
    targetDensity: f32,
    pressureMultiplier: f32,
    viscosity: f32,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

// Constants
const PI: f32 = 3.1415926535;

// SPH Kernels
// Poly6 Kernel for Density
fn poly6_kernel(r2: f32, h: f32) -> f32 {
    let h2 = h * h;
    let h9 = h2 * h2 * h2 * h2 * h; // h^9
    if (r2 < h2 && r2 >= 0.0) {
        let diff = h2 - r2;
        return (315.0 / (64.0 * PI * h9)) * diff * diff * diff;
    }
    return 0.0;
}

// Spiky Gradient for Pressure
fn spiky_kernel_gradient(r: f32, diffVec: vec2<f32>, h: f32) -> vec2<f32> {
    let h6 = h * h * h * h * h * h;
    if (r > 0.0 && r < h) {
        let diff = h - r;
        let scalar = -(45.0 / (PI * h6)) * diff * diff;
        return (diffVec / r) * scalar;
    }
    return vec2(0.0);
}

@compute @workgroup_size(64)
fn compute_density(@builtin(global_invocation_id) GlobalInvocationID : vec3<u32>) {
    let idx = GlobalInvocationID.x;
    if (idx >= arrayLength(&particles)) { return; }

    var p = particles[idx];
    var density = 0.0;
    
    // N^2 loop for simplicity (Optimize with Grid later if needed)
    // Note: iterating all particles is slow for large N.
    // For 1000 particles it is fine.
    
    let count = arrayLength(&particles);
    for (var i = 0u; i < count; i++) {
        let other = particles[i];
        let d = p.pos - other.pos;
        let r2 = dot(d, d);
        density += poly6_kernel(r2, params.smoothingRadius);
    }
    
    particles[idx].density = max(density, params.targetDensity); // Prevent negative pressure
    // Compute pressure: P = k * (rho - rho0)
    particles[idx].pressure = params.pressureMultiplier * (particles[idx].density - params.targetDensity);
}

@compute @workgroup_size(64)
fn compute_force(@builtin(global_invocation_id) GlobalInvocationID : vec3<u32>) {
    let idx = GlobalInvocationID.x;
    if (idx >= arrayLength(&particles)) { return; }

    var p = particles[idx];
    var pressureForce = vec2(0.0, 0.0);
    var viscosityForce = vec2(0.0, 0.0);
    
    let count = arrayLength(&particles);
    for (var i = 0u; i < count; i++) {
        if (i == idx) { continue; }
        
        let other = particles[i];
        let d = p.pos - other.pos;
        let r = length(d);
        
        if (r < params.smoothingRadius) {
            // Pressure Force
            // Fp = - mass * (Pi + Pj)/(2 * rhoj) * GenericSpiky
            // Assuming mass = 1
            let common = (p.pressure + other.pressure) / (2.0 * other.density);
            pressureForce -= common * spiky_kernel_gradient(r, d, params.smoothingRadius);
            
            // Viscosity Force (Simple damping)
            // Fv = u * sum((vj - vi) / rhoj * W)
            // Skip for performance, just do simple damping in integrate
        }
    }
    
    // Gravity
    var force = pressureForce;
    force.y += params.gravity * p.density; // Multiply by density approx F=ma

    // Integration
    let dt = params.dt;
    p.vel += (force / p.density) * dt;
    p.vel *= 0.98; // Friction
    
    // Move
    p.pos += p.vel * dt;

    // Boundary
    if (p.pos.x < 0.0) { p.pos.x = 0.0; p.vel.x *= -0.5; }
    if (p.pos.x > params.width) { p.pos.x = params.width; p.vel.x *= -0.5; }
    if (p.pos.y > params.height) { p.pos.y = params.height; p.vel.y *= -0.5; } // Floor
    if (p.pos.y < 0.0) { p.pos.y = 0.0; p.vel.y *= -0.5; }

    particles[idx] = p;
}

// --- Renderer ---
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) density: f32,
}

struct Camera {
    viewProjection: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> camera: Camera;

@vertex
fn vs_main(@builtin(vertex_index) vIdx: u32, @builtin(instance_index) iIdx: u32) -> VertexOutput {
    let p = particles[iIdx];
    
    // Billboard quad
    var pos = vec2(0.0, 0.0);
    var uv = vec2(0.0, 0.0);
    // Expand a bit based on density?
    let size = 10.0; 
    
    switch vIdx {
        case 0u: { pos = vec2(-0.5, -0.5); uv = vec2(0.0, 0.0); }
        case 1u: { pos = vec2(-0.5,  0.5); uv = vec2(0.0, 1.0); }
        case 2u: { pos = vec2( 0.5,  0.5); uv = vec2(1.0, 1.0); }
        case 3u: { pos = vec2(-0.5, -0.5); uv = vec2(0.0, 0.0); }
        case 4u: { pos = vec2( 0.5,  0.5); uv = vec2(1.0, 1.0); }
        default: { pos = vec2( 0.5, -0.5); uv = vec2(1.0, 0.0); }
    }
    
    let worldPos = p.pos + pos * size;
    
    var output: VertexOutput;
    output.position = camera.viewProjection * vec4(worldPos, 0.0, 1.0);
    output.uv = uv;
    output.density = p.density;
    return output;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let dist = length(in.uv - 0.5);
    if (dist > 0.5) { discard; }
    
    // Color based on density (Blue/Purple energy)
    let d = in.density * 0.1;
    return vec4(0.2 * d, 0.5 * d, 1.0, 0.8);
}
