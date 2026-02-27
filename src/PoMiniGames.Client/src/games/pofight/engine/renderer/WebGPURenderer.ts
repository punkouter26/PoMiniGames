import { Fighter } from '../Fighter';
import { mat4 } from 'gl-matrix';
// @ts-ignore
import spriteShader from './shaders/sprite.wgsl?raw';
// @ts-ignore
import particleShader from './shaders/particles.wgsl?raw';
// @ts-ignore
import postShader from './shaders/post.wgsl?raw';
// @ts-ignore
import backgroundShader from './shaders/background.wgsl?raw';
// @ts-ignore
import godrayShader from './shaders/godrays.wgsl?raw';
// @ts-ignore
import fluidShader from './shaders/fluid.wgsl?raw';

export class WebGPURenderer {
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private format!: GPUTextureFormat;

    private spritePipeline!: GPURenderPipeline;
    private particleUpdatePipeline!: GPUComputePipeline;
    private particleRenderPipeline!: GPURenderPipeline;
    private postPipeline!: GPURenderPipeline;
    private backgroundPipeline!: GPURenderPipeline;
    private godrayPipeline!: GPURenderPipeline;
    private fluidDensityPipeline!: GPUComputePipeline;
    private fluidForcePipeline!: GPUComputePipeline;
    private fluidRenderPipeline!: GPURenderPipeline; // New

    // Buffers
    private uniformBuffer!: GPUBuffer;
    private spriteBuffer!: GPUBuffer;
    private particleBuffer!: GPUBuffer;
    private fluidBuffer!: GPUBuffer; // New
    private simParamsBuffer!: GPUBuffer;
    private fluidParamsBuffer!: GPUBuffer; // New

    private bindGroupPost!: GPUBindGroup;
    private bindGroupBackground!: GPUBindGroup;
    private bindGroupGodrays!: GPUBindGroup;
    private bindGroupShadow!: GPUBindGroup;
    private bindGroupFluid!: GPUBindGroup; // New

    private fighters: Fighter[] = [];

    // Post Process State
    private postUniformBuffer!: GPUBuffer;
    private godrayUniformBuffer!: GPUBuffer;
    private shadowUniformBuffer!: GPUBuffer;
    private shockwaveData = { x: 0.5, y: 0.5, time: 10.0, amp: 0.0 };
    private glitchStrength = 0.0;
    private totalTime = 0.0;

    // Particle State
    private particleCount = 100000;
    private fluidParticleCount = 1000; // SPH is expensive N^2

    // Motion Blur State
    private prevPositions = new Map<string, { x: number, y: number }>();

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
    }

    async initialize() {
        if (!navigator.gpu) {
            throw new Error("WebGPU not supported on this browser.");
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("No appropriate GPUAdapter found.");
        }

        this.device = await adapter.requestDevice();
        this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
        this.format = navigator.gpu.getPreferredCanvasFormat();

        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'premultiplied',
        });

        await this.createPipelines();
        this.createBuffers();
        this.createBindGroups();

        console.log("WebGPU Initialized");
    }

    private async createPipelines() {
        // --- Sprite Pipeline ---
        this.spritePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.device.createShaderModule({ code: spriteShader }),
                entryPoint: 'vs_main',
            },
            fragment: {
                module: this.device.createShaderModule({ code: spriteShader }),
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    }
                }],
            },
            primitive: { topology: 'triangle-list' },
        });

        // --- Particle Compute Pipeline ---
        this.particleUpdatePipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: this.device.createShaderModule({ code: particleShader }),
                entryPoint: 'simulate',
            },
        });

        // --- Particle Render Pipeline ---
        this.particleRenderPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.device.createShaderModule({ code: particleShader }),
                entryPoint: 'vs_main',
            },
            fragment: {
                module: this.device.createShaderModule({ code: particleShader }),
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' }, // Additive for glow
                        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                    }
                }],
            },
            primitive: { topology: 'triangle-list' },
        });
        // --- Post Pipeline ---
        this.postPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.device.createShaderModule({ code: postShader }),
                entryPoint: 'vs_main',
            },
            fragment: {
                module: this.device.createShaderModule({ code: postShader }),
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format // Output directly to screen
                }],
            },
            primitive: { topology: 'triangle-list' },
        });

        // --- Background Pipeline ---
        this.backgroundPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.device.createShaderModule({ code: backgroundShader }),
                entryPoint: 'vs_main',
            },
            fragment: {
                module: this.device.createShaderModule({ code: backgroundShader }),
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format // Draws to texture (sceneTexture) which uses same format
                }],
            },
            primitive: { topology: 'triangle-list' },
        });

        // --- God Ray Pipeline ---
        this.godrayPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.device.createShaderModule({ code: godrayShader }),
                entryPoint: 'vs_main',
            },
            fragment: {
                module: this.device.createShaderModule({ code: godrayShader }),
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, // Additive blend for light rays
                        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                    }
                }],
            },
            primitive: { topology: 'triangle-list' },
        });

        // --- Fluid Pipelines ---
        this.fluidDensityPipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: this.device.createShaderModule({ code: fluidShader }),
                entryPoint: 'compute_density',
            },
        });

        this.fluidForcePipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: this.device.createShaderModule({ code: fluidShader }),
                entryPoint: 'compute_force',
            },
        });

        // Fluid Render Pipeline
        this.fluidRenderPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.device.createShaderModule({ code: fluidShader }),
                entryPoint: 'vs_main',
            },
            fragment: {
                module: this.device.createShaderModule({ code: fluidShader }),
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                    }
                }],
            },
            primitive: { topology: 'triangle-list' },
        });
    }



    private sceneTexture!: GPUTexture;
    private sceneTextureView!: GPUTextureView;
    private sampler!: GPUSampler;

    public resize(width: number, height: number) {
        if (!this.device) return;
        this.canvas.width = width;
        this.canvas.height = height;

        // Recreate Scene Texture
        if (this.sceneTexture) this.sceneTexture.destroy();

        this.sceneTexture = this.device.createTexture({
            size: [width, height],
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.sceneTextureView = this.sceneTexture.createView();

        if (!this.sampler) {
            this.sampler = this.device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
            });
        }

        // Recreate Post Bind Group
        // We need pipeline layout to be ready. Recreate bind groups that depend on the scene texture.
        if (this.postPipeline) {
            this.bindGroupPost = this.device.createBindGroup({
                layout: this.postPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.sceneTextureView },
                    { binding: 1, resource: this.sampler },
                    { binding: 2, resource: { buffer: this.postUniformBuffer } },
                ],
            });
        }
        if (this.godrayPipeline) {
            this.bindGroupGodrays = this.device.createBindGroup({
                layout: this.godrayPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.sceneTextureView }, // Using scene texture as source for rays
                    { binding: 1, resource: this.sampler },
                    { binding: 2, resource: { buffer: this.godrayUniformBuffer } },
                ],
            });
        }
    }

    private createBuffers() {
        // Uniforms (Camera ViewProj)
        this.uniformBuffer = this.device.createBuffer({
            size: 64, // mat4
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Sprites Storage (Max 100 sprites for now)
        // struct Sprite { position: vec2, size: vec2, color: vec4, rotation: f32, pad: f32 } = 48 bytes
        const spriteBufferSize = 100 * 48;
        this.spriteBuffer = this.device.createBuffer({
            size: spriteBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Particles Storage
        // struct Particle { pos: vec2, vel: vec2, life: f32, maxLife: f32, color: vec4, size: f32, pad: f32 } = 48 bytes
        // 48 bytes * 100,000 = ~4.8MB
        const particleBufferSize = this.particleCount * 48;
        this.particleBuffer = this.device.createBuffer({
            size: particleBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Initialize particles with random data
        const initialParticles = new Float32Array(this.particleCount * 12); // 48 bytes / 4 = 12 floats
        for (let i = 0; i < this.particleCount; i++) {
            const offset = i * 12;
            initialParticles[offset + 0] = Math.random() * 800; // x
            initialParticles[offset + 1] = Math.random() * 600; // y
            initialParticles[offset + 2] = (Math.random() - 0.5) * 100; // vx
            initialParticles[offset + 3] = (Math.random() - 0.5) * 100; // vy
            initialParticles[offset + 4] = Math.random(); // life
            initialParticles[offset + 5] = 1.0; // maxLife
            initialParticles[offset + 6] = Math.random(); // r
            initialParticles[offset + 7] = Math.random(); // g
            initialParticles[offset + 8] = 1.0; // b
            initialParticles[offset + 9] = 1.0; // a
            initialParticles[offset + 10] = Math.random() * 5 + 2; // size
        }
        this.device.queue.writeBuffer(this.particleBuffer, 0, initialParticles);

        // Sim Params
        this.simParamsBuffer = this.device.createBuffer({
            size: 16, // dt, gravity, width, height (4 floats)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Post Uniforms
        // struct PostUniforms { time: f32, swParams: vec4, glitch: f32, screen: vec2 }
        this.postUniformBuffer = this.device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // God Rays Uniforms
        // exposure, decay, density, weight, lightPos(vec2), time
        // 4 * 4 + 8 + 4 = 16 + 8 + 4 = 28 -> 32 bytes aligned
        // float, float, float, float (16)
        // vec2 (8)
        // float (4)
        // Total 28 bytes. Align to 32?
        this.godrayUniformBuffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.shadowUniformBuffer = this.device.createBuffer({
            size: 64, // mat4
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Fluid Buffer
        // struct Particle { pos: vec2, vel: vec2, density: f32, pressure: f32 } = 24 bytes -> 32 bytes aligned
        // 1000 particles * 32 = 32000 bytes
        this.fluidBuffer = this.device.createBuffer({
            size: this.fluidParticleCount * 32,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX, // Vertex too for rendering
        });

        // Init Fluid Particles (Cluster them in center to test explosion)
        const fluidData = new Float32Array(this.fluidParticleCount * 8); // 32 bytes = 8 floats
        for (let i = 0; i < this.fluidParticleCount; i++) {
            const off = i * 8;
            fluidData[off + 0] = 400 + (Math.random() - 0.5) * 50; // x
            fluidData[off + 1] = 300 + (Math.random() - 0.5) * 50; // y
            // vel = 0
            fluidData[off + 6] = 0; // density
            fluidData[off + 7] = 0; // pressure
        }
        this.device.queue.writeBuffer(this.fluidBuffer, 0, fluidData);

        // Fluid Params
        // dt, gravity, width, height, radius, targetDensity, pressMult, friction
        // 8 floats = 32 bytes
        this.fluidParamsBuffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    private createBindGroups() {
        // Bind group for sprites is created inline during render
        void this.device.createBindGroup({
            layout: this.spritePipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
        });

        if (this.backgroundPipeline) {
            this.bindGroupBackground = this.device.createBindGroup({
                layout: this.backgroundPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.postUniformBuffer } }
                ]
            });
        }
        this.bindGroupShadow = this.device.createBindGroup({
            layout: this.spritePipeline.getBindGroupLayout(0), // Reuse sprite layout (Group 0 is Camera/Uniforms)
            entries: [{ binding: 0, resource: { buffer: this.shadowUniformBuffer } }],
        });

        // If scene texture and sampler are available, create post and godray bind groups.
        if (this.sceneTextureView && this.sampler) {
            if (this.postPipeline) {
                this.bindGroupPost = this.device.createBindGroup({
                    layout: this.postPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: this.sceneTextureView },
                        { binding: 1, resource: this.sampler },
                        { binding: 2, resource: { buffer: this.postUniformBuffer } },
                    ],
                });
            }

            if (this.godrayPipeline) {
                this.bindGroupGodrays = this.device.createBindGroup({
                    layout: this.godrayPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: this.sceneTextureView },
                        { binding: 1, resource: this.sampler },
                        { binding: 2, resource: { buffer: this.godrayUniformBuffer } },
                    ],
                });
            }
        }
    }

    public triggerShockwave(x: number, y: number, amplitude: number = 1.0) {
        // Normalize coordinates to 0-1
        this.shockwaveData.x = x / this.canvas.width;
        this.shockwaveData.y = y / this.canvas.height;
        this.shockwaveData.time = 0.0; // Reset time
        this.shockwaveData.amp = amplitude;
    }

    public setGlitch(strength: number) {
        this.glitchStrength = strength;
    }

    public setFighters(fighters: Fighter[]) {
        this.fighters = fighters;
    }

    public render(dt: number) {
        if (!this.device) return;

        // 1. Update Uniforms
        const projection = mat4.create();
        mat4.ortho(projection, 0, 800, 600, 0, -1, 1);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, (projection as Float32Array).buffer);

        // 2. Update Sprite Buffer
        const spriteData = new Float32Array(this.fighters.length * 12);
        this.fighters.forEach((f, i) => {
            const offset = i * 12;
            spriteData[offset + 0] = f.x.value;
            spriteData[offset + 1] = f.y.value;
            spriteData[offset + 2] = 50; // Width
            spriteData[offset + 3] = 100; // Height

            // Color based on state
            const state = f.state.value;
            let r = 0, g = 0, b = 1; // Blue
            if (f.id === 'cpu') { r = 1; g = 0; b = 0; } // Red
            if (state === 'ATTACKING') { r = 1; g = 1; b = 0; } // Yellow charge

            spriteData[offset + 4] = r;
            spriteData[offset + 5] = g;
            spriteData[offset + 6] = b;
            spriteData[offset + 7] = 1.0;

            spriteData[offset + 8] = 0; // Rot

            // Motion Blur Velocity
            // We need to compare current pos (f.x, f.y) with prev pos.
            let vx = 0;
            let vy = 0;
            const prev = this.prevPositions.get(f.id);
            if (prev) {
                vx = f.x.value - prev.x;
                vy = f.y.value - prev.y;
            }
            // Store current for next frame
            this.prevPositions.set(f.id, { x: f.x.value, y: f.y.value });

            spriteData[offset + 9] = vx;
            spriteData[offset + 10] = vy;
            spriteData[offset + 11] = 0; // PADDING
        });
        this.device.queue.writeBuffer(this.spriteBuffer, 0, spriteData);

        // 3. Update Sim Params
        this.device.queue.writeBuffer(this.simParamsBuffer, 0, new Float32Array([dt, 900.0, 800, 600]));

        // 3b. Update Fluid Params
        // dt, gravity, width, height, radius, targetDensity, pressMult, friction
        const fluidParams = new Float32Array([
            dt, 900.0, 800.0, 600.0,
            30.0, // Radius
            0.5, // Target Density
            2000.0, // Pressure Mult
            0.0 // Viscosity
        ]);
        this.device.queue.writeBuffer(this.fluidParamsBuffer, 0, fluidParams);

        // 4. Update Post Uniforms
        this.totalTime += dt;
        this.shockwaveData.time += dt * 2.0; // Speed of wave

        // Correct packing for struct PostUniforms { time: f32, swParams: vec4, glitch: f32, screen: vec2 }
        // time (offset 0, 4 bytes)
        // swParams (offset 16, 16 bytes)
        // glitch (offset 32, 4 bytes)
        // screen (offset 44, 8 bytes)
        const postBuffer = new Float32Array(12); // 12 floats = 48 bytes
        postBuffer[0] = this.totalTime;
        // swParams (vec4) starts at float index 4 (offset 16)
        postBuffer[4] = this.shockwaveData.x;
        postBuffer[5] = this.shockwaveData.y;
        postBuffer[6] = this.shockwaveData.time;
        postBuffer[7] = this.shockwaveData.amp;
        // glitch (f32) starts at float index 8 (offset 32)
        postBuffer[8] = this.glitchStrength;
        // screen (vec2) starts at float index 11 (offset 44)
        postBuffer[11] = this.canvas.width;
        postBuffer[12] = this.canvas.height; // This would exceed 12 floats, need to check buffer size.
        // The buffer size is 48 bytes, which is 12 floats.
        // So postBuffer[11] is the last float.
        // This means screen.y cannot be written here.
        // Let's re-evaluate the struct size.
        // time (4) + pad(12) -> offset 16
        // swParams (16) -> offset 32
        // glitch (4) -> offset 36
        // screen (8) -> offset 44
        // Total 44 bytes. If size is 48, then 4 bytes padding at end.
        // So, screen.x is at float index 11 (offset 44).
        // screen.y would be at float index 12 (offset 48), which is out of bounds for 48 bytes.
        // The `size: 48` for `postUniformBuffer` is correct.
        // The `screen` vec2 should be at offset 36 (after glitch).
        // Let's assume the WGSL struct is actually:
        // struct PostUniforms { time: f32, swParams: vec4, glitch: f32, screen: vec2 }
        // time (4)
        // swParams (16) - needs 16-byte alignment, so time is padded to 16.
        // glitch (4)
        // screen (8) - needs 8-byte alignment, so glitch is padded to 8.
        //
        // Correct layout:
        // time: f32 (offset 0)
        // padding: 12 bytes (to align swParams)
        // swParams: vec4<f32> (offset 16)
        // glitch: f32 (offset 32)
        // screen: vec2<f32> (offset 36)
        // Total size: 36 + 8 = 44 bytes.
        // If buffer size is 48, then 4 bytes padding at end.
        //
        // So, in Float32Array (each element is 4 bytes):
        // [0] = time
        // [1], [2], [3] = padding
        // [4] = swParams.x (offset 16)
        // [5] = swParams.y
        // [6] = swParams.z (time)
        // [7] = swParams.w (amp)
        // [8] = glitch (offset 32)
        // [9] = screen.x (offset 36)
        // [10] = screen.y
        // Array size should be 11 floats (44 bytes).
        const postBufferCorrected = new Float32Array(11); // 11 floats = 44 bytes
        postBufferCorrected[0] = this.totalTime;
        postBufferCorrected[4] = this.shockwaveData.x;
        postBufferCorrected[5] = this.shockwaveData.y;
        postBufferCorrected[6] = this.shockwaveData.time;
        postBufferCorrected[7] = this.shockwaveData.amp;
        postBufferCorrected[8] = this.glitchStrength;
        postBufferCorrected[9] = this.canvas.width;
        postBufferCorrected[10] = this.canvas.height;

        this.device.queue.writeBuffer(this.postUniformBuffer, 0, postBufferCorrected);


        const commandEncoder = this.device.createCommandEncoder();

        // --- Compute Pass (Particles) ---
        const passIndex = this.particleUpdatePipeline.getBindGroupLayout(0);
        const bindGroupSim = this.device.createBindGroup({
            layout: passIndex,
            entries: [
                { binding: 0, resource: { buffer: this.simParamsBuffer } },
                { binding: 1, resource: { buffer: this.particleBuffer } },
            ]
        });

        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.particleUpdatePipeline);
        computePass.setBindGroup(0, bindGroupSim);
        computePass.dispatchWorkgroups(Math.ceil(this.particleCount / 64));

        // Fluid Compute
        if (this.fluidDensityPipeline && this.bindGroupFluid) {
            computePass.setPipeline(this.fluidDensityPipeline);
            computePass.setBindGroup(0, this.bindGroupFluid);
            computePass.dispatchWorkgroups(Math.ceil(this.fluidParticleCount / 64));

            computePass.setPipeline(this.fluidForcePipeline);
            computePass.setBindGroup(0, this.bindGroupFluid);
            computePass.dispatchWorkgroups(Math.ceil(this.fluidParticleCount / 64));
        }

        computePass.end();

        // --- Render Pass (To Texture) ---
        if (!this.sceneTextureView) this.resize(this.canvas.width, this.canvas.height); // Ensure texture exists

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.sceneTextureView,
                clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        // Draw Background
        if (this.backgroundPipeline && this.bindGroupBackground) {
            renderPass.setPipeline(this.backgroundPipeline);
            renderPass.setBindGroup(0, this.bindGroupBackground);
            renderPass.draw(3, 1, 0, 0);
        }

        // --- Shadows Pass ---
        // Prepare Shadow Matrix
        const shadowMat = mat4.create();
        mat4.ortho(shadowMat, 0, 800, 600, 0, -1, 1);
        // Simple Shadow Skew: x' = x - 0.5 * y
        // We adjust the X coordinate based on Y.
        // In column-major: 
        // m0, m1, m2, m3 (X)
        // m4, m5, m6, m7 (Y)
        shadowMat[4] = -0.5; // Skew X by Y
        // Squash Y to look like floor shadow
        shadowMat[5] = 0.3; // Scale Y
        // Translate Y to floor "ground" level? 
        // Since we are 2D, a generic skew works if "0" is feet. 
        // But feet are at varying Y. We might need to translate. 
        // Let's iterate: just skew first.
        // Also, we need to shift the shadow down a bit relative to sprite?
        // Let's add translation to Y?
        shadowMat[13] = 10.0; // Offset Y

        this.device.queue.writeBuffer(this.shadowUniformBuffer, 0, (shadowMat as Float32Array).buffer);

        const bgSprites0 = this.device.createBindGroup({
            layout: this.spritePipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }]
        });
        const bgSprites1 = this.device.createBindGroup({
            layout: this.spritePipeline.getBindGroupLayout(1),
            entries: [{ binding: 0, resource: { buffer: this.spriteBuffer } }]
        });

        // Draw Shadows (using Shadow Matrix + Sprites)
        // We reuse Sprite Pipeline but swap the Camera Uniform Group (Group 0)
        // Note: Sprite Shader uses color from sprite. Shadows should be black.
        // We can't change color without new pipeline or uniform.
        // Hack: We accept colored shadows ("reflections") for now as per plan.
        if (this.bindGroupShadow) {
            renderPass.setPipeline(this.spritePipeline);
            renderPass.setBindGroup(0, this.bindGroupShadow); // Shadow Camera
            renderPass.setBindGroup(1, bgSprites1); // Functioning as "Model" data
            renderPass.draw(6, this.fighters.length, 0, 0);
        }

        // Draw Sprites (Normal)
        renderPass.setPipeline(this.spritePipeline);
        renderPass.setBindGroup(0, bgSprites0);
        renderPass.setBindGroup(1, bgSprites1);
        renderPass.draw(6, this.fighters.length, 0, 0);

        // Draw Particles
        const bgParticles1 = this.device.createBindGroup({
            layout: this.particleRenderPipeline.getBindGroupLayout(1),
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }]
        });

        renderPass.setPipeline(this.particleRenderPipeline);
        renderPass.setBindGroup(0, bindGroupSim);
        renderPass.setBindGroup(1, bgParticles1);
        renderPass.draw(6, this.particleCount, 0, 0);

        // Draw Fluids
        if (this.fluidRenderPipeline && this.bindGroupFluid) {
            // Need Camera BindGroup (Group 1)
            // Reuse bgParticles1? It has uniform buffer at binding 0.
            // fluid shader expects @group(1) @binding(0) var<uniform> camera: Camera;
            // This matches bgParticles1 layout.

            renderPass.setPipeline(this.fluidRenderPipeline);
            renderPass.setBindGroup(0, this.bindGroupFluid); // Particles/Params
            renderPass.setBindGroup(1, bgParticles1); // Camera
            renderPass.draw(6, this.fluidParticleCount, 0, 0);
        }

        renderPass.end();

        // --- Post Process Pass (To Screen) ---
        const postPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }
            }],
        });

        // 1. Bloom/Glitch (Post)
        postPass.setPipeline(this.postPipeline);
        if (this.bindGroupPost) {
            postPass.setBindGroup(0, this.bindGroupPost);
            postPass.draw(3, 1, 0, 0);
        }

        // 2. God Rays (Additive)
        if (this.godrayPipeline && this.bindGroupGodrays) {
            // Update God Ray Uniforms
            const lightX = 0.5 + Math.sin(this.totalTime * 0.5) * 0.3;
            const lightY = 0.3; // Fixed height

            const godrayData = new Float32Array([
                0.6, // exposure
                0.92, // decay
                0.8, // density
                0.4, // weight
                lightX, lightY,
                this.totalTime,
                0
            ]);
            this.device.queue.writeBuffer(this.godrayUniformBuffer, 0, godrayData);

            postPass.setPipeline(this.godrayPipeline);
            postPass.setBindGroup(0, this.bindGroupGodrays);
            postPass.draw(3, 1, 0, 0);
        }

        postPass.end();

        this.device.queue.submit([commandEncoder.finish()]);
    }
}
